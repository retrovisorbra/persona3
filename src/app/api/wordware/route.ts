import { getUser, updateUser } from '@/actions/actions'
import { TweetType } from '@/actions/types'
import { TwitterAnalysis } from '@/components/analysis/analysis'
import axios from 'axios'
import { NextResponse } from 'next/server'

export const maxDuration = 300

export async function POST(request: Request) {
  const { username, full } = await request.json()
  console.log(`[${username}] Processing request for username: ${username}, full: ${full}`)

  const user = await getUser({ username })

  if (!user) {
    console.log(`[${username}] User not found: ${username}`)
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  if (!full && (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    console.log(`[${username}] Wordware already started or completed for ${username}`)
    return NextResponse.json({ error: 'Wordware already started' }, { status: 400 })
  }

  if (full && (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000))) {
    console.log(`[${username}] Paid Wordware already started or completed for ${username}`)
    return NextResponse.json({ error: 'Wordware already started' }, { status: 400 })
  }

  function formatTweet(tweet: TweetType) {
    const isRetweet = tweet.isRetweet ? 'RT ' : ''
    const author = tweet.author?.userName ?? username
    const createdAt = tweet.createdAt
    const text = tweet.text ?? ''
    const formattedText = text
      .split('\n')
      .map((line) => `${line}`)
      .join(`\n> `)
    return `**${isRetweet}@${author} - ${createdAt}**

> ${formattedText}

*retweets: ${tweet.retweetCount ?? 0}, replies: ${tweet.replyCount ?? 0}, likes: ${tweet.likeCount ?? 0}, quotes: ${tweet.quoteCount ?? 0}, views: ${tweet.viewCount ?? 0}*`
  }

  const tweets = user.tweets as TweetType[]
  const tweetsMarkdown = tweets.map(formatTweet).join('\n---\n\n')
  console.log(`[${username}] Prepared ${tweets.length} tweets for analysis`)

  const promptID = full ? process.env.WORDWARE_FULL_PROMPT_ID : process.env.WORDWARE_ROAST_PROMPT_ID
  console.log(`[${username}] Using promptID: ${promptID}`)

  console.log(`[${username}] Sending request to Wordware API`)

  // Update user to indicate Wordware has started
  await updateUser({
    user: {
      ...user,
      wordwareStarted: true,
      wordwareStartedTime: new Date(),
    },
  })

  const stream = new TransformStream()
  const writer = stream.writable.getWriter()
  const encoder = new TextEncoder()

  const saveAnalysisAndUpdateUser = async (analysisData: any) => {
    console.log(`[${username}] Attempting to save analysis. Value received:`, JSON.stringify(analysisData))
    
    const statusObject = full
      ? { paidWordwareStarted: true, paidWordwareCompleted: true }
      : { wordwareStarted: true, wordwareCompleted: true }
    
    try {
      await updateUser({
        user: {
          ...user,
          ...statusObject,
          analysis: {
            ...(user.analysis as TwitterAnalysis),
            ...analysisData,
          },
        },
      })
      console.log(`[${username}] Analysis saved to database.`)
    } catch (error) {
      console.error(`[${username}] Error parsing or saving output:`, error)
      const failureStatusObject = full
        ? { paidWordwareStarted: false, paidWordwareCompleted: false }
        : { wordwareStarted: false, wordwareCompleted: false }
      await updateUser({
        user: {
          ...user,
          ...failureStatusObject,
        },
      })
      console.log(`[${username}] Updated user status to indicate failure.`)
    }
  }

  try {
    const response = await axios.post(
      `https://app.wordware.ai/api/released-app/${promptID}/run`,
      {
        inputs: {
          tweets: `Tweets: ${tweetsMarkdown}`,
          profilePicture: user.profilePicture,
          profileInfo: user.fullProfile,
          version: '^1.0',
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.WORDWARE_API_KEY}`,
        },
        responseType: 'stream',
      }
    )

    console.log(`[${username}] Received response from Wordware API`)

    let buffer = ''
    let finalOutput = false
    response.data.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'generation') {
            if (parsed.value.state === 'start' && parsed.value.label === 'output') {
              finalOutput = true
            } else if (parsed.value.state === 'end' && parsed.value.label === 'output') {
              finalOutput = false
            }
          } else if (parsed.type === 'chunk' && finalOutput) {
            writer.write(encoder.encode(parsed.value.value))
          } else if (parsed.type === 'outputs') {
            saveAnalysisAndUpdateUser(parsed.values.output)
          }
        } catch (error) {
          console.error(`[${username}] Error parsing chunk:`, error)
        }
      }
    })

    response.data.on('end', () => {
      console.log(`[${username}] Stream ended`)
      writer.close()
    })

    return new NextResponse(stream.readable, {
      headers: { 'Content-Type': 'text/plain' },
    })
  } catch (error) {
    console.error(`[${username}] Error in Wordware API call:`, error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
