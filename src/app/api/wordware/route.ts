import { getUser, updateUser } from '@/actions/actions'
import { TweetType } from '@/actions/types'
import { TwitterAnalysis } from '@/components/analysis/analysis'
import axios from 'axios'

export const maxDuration = 300

export async function POST(request: Request) {
  const { username, full } = await request.json()
  console.log(`[${username}] Processing request for username: ${username}, full: ${full}`)

  const user = await getUser({ username })

  if (!user) {
    console.log(`[${username}] User not found: ${username}`)
    throw Error(`User not found: ${username}`)
  }

  if (!full) {
    if (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log(`[${username}] Wordware already started or completed for ${username}`)
      return new Response(JSON.stringify({ error: 'Wordware already started' }), { status: 400 })
    }
  }

  if (full) {
    if (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.log(`[${username}] Paid Wordware already started or completed for ${username}`)
      return new Response(JSON.stringify({ error: 'Wordware already started' }), { status: 400 })
    }
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

  const decoder = new TextDecoder()
  let buffer = ''
  let finalOutput = false
  let chunkCount = 0
  let lastChunkTime = Date.now()
  let generationEventCount = 0
  const FORCE_FINAL_OUTPUT_AFTER = 50
  let accumulatedOutput = ''
  let finalAnalysis: any = null

  const stream = new TransformStream()
  const writer = stream.writable.getWriter()

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
        responseType: 'stream',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.WORDWARE_API_KEY}`,
        },
      }
    )

    response.data.on('data', (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true })
      chunkCount++
      const now = Date.now()
      console.log(`[${username}] Chunk #${chunkCount} received at ${new Date(now).toISOString()}, ${now - lastChunkTime}ms since last chunk`)
      lastChunkTime = now

      if (chunkCount <= 5) {
        console.log(`[${username}] Full chunk content: ${buffer}`)
      }

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      lines.forEach(async (line) => {
        if (line.trim() === '') return

        try {
          const content = JSON.parse(line)
          const value = content.value

          if (value.type === 'generation') {
            console.log(`[${username}] Generation event: ${value.state} - ${value.label}`)
            generationEventCount++
            if (value.state === 'start' && value.label === 'output') {
              finalOutput = true
              console.log(`[${username}] finalOutput set to true`)
            } else if (value.state === 'end' && value.label === 'output') {
              finalOutput = false
              console.log(`[${username}] finalOutput set to false`)
            }
          } else if (value.type === 'chunk') {
            if (finalOutput) {
              accumulatedOutput += value.value ?? ''
              await writer.write(new TextEncoder().encode(value.value ?? ''))
              console.log(`[${username}] Enqueued chunk: ${(value.value ?? '').slice(0, 50)}...`)
            }
          } else if (value.type === 'outputs') {
            console.log(`[${username}] Received final output from Wordware. Storing for end-of-stream processing.`)
            finalAnalysis = value.values.output
          }

          if (!finalOutput && chunkCount >= FORCE_FINAL_OUTPUT_AFTER) {
            console.log(`[${username}] Forcing finalOutput to true after ${FORCE_FINAL_OUTPUT_AFTER} chunks`)
            finalOutput = true
          }
        } catch (error) {
          console.error(`[${username}] Error processing line:`, error, 'Line content:', line)
        }
      })
    })

    response.data.on('end', async () => {
      console.log(`[${username}] Stream ended`)
      console.log(`[${username}] Stream processing finished`)
      console.log(`[${username}] Total chunks processed: ${chunkCount}`)
      console.log(`[${username}] Total generation events: ${generationEventCount}`)
      
      // Save the accumulated output and final analysis to the database
      if (finalAnalysis) {
        const statusObject = full
          ? { paidWordwareStarted: true, paidWordwareCompleted: true }
          : { wordwareStarted: true, wordwareCompleted: true }
        
        try {
          await updateUser({
            user: {
              ...user,
              ...statusObject,
              analysis: {
                ...user.analysis,
                ...finalAnalysis,
                fullOutput: accumulatedOutput,
              },
            },
          })
          console.log(`[${username}] Final analysis and full output saved to database.`)
        } catch (error) {
          console.error(`[${username}] Error saving final analysis:`, error)
        }
      } else {
        console.warn(`[${username}] Stream ended without receiving final analysis.`)
      }
      
      await writer.close()
    })

    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/plain' },
    })
  } catch (error) {
    console.error(`[${username}] Error in Wordware API call:`, error)
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 })
  }
}


