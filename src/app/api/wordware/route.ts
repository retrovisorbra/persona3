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

  const stream = new TransformStream()
  const writer = stream.writable.getWriter()
  const encoder = new TextEncoder()

  console.log(`[${username}] Updating user to indicate Wordware has started`)
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
  const existingAnalysis = user?.analysis as TwitterAnalysis
  let chunkCount = 0
  let lastChunkTime = Date.now()
  let generationEventCount = 0
  const FORCE_FINAL_OUTPUT_AFTER = 50 // Force finalOutput after this many chunks if not set

  function logMemoryUsage() {
    const used = process.memoryUsage()
    console.log(`[${username}] Memory usage:`)
    for (const key in used) {
      console.log(`${key}: ${Math.round(used[key as keyof NodeJS.MemoryUsage] / 1024 / 1024 * 100) / 100} MB`)
    }
  }

  // Implement timeout mechanism
  const timeoutDuration = 5 * 60 * 1000 // 5 minutes
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), timeoutDuration)

  async function saveAnalysisAndUpdateUser(user: any, value: any, full: boolean) {
    console.log(`[${username}] Attempting to save analysis. Value received:`, JSON.stringify(value));
    
    const statusObject = full
      ? {
          paidWordwareStarted: true,
          paidWordwareCompleted: true,
        }
      : { wordwareStarted: true, wordwareCompleted: true };
    
    try {
      await updateUser({
        user: {
          ...user,
          ...statusObject,
          analysis: {
            ...existingAnalysis,
            ...value.values.output,
          },
        },
      });
      console.log(`[${username}] Analysis saved to database.`);
    } catch (error) {
      console.error(`[${username}] Error parsing or saving output:`, error);
      const statusObject = full
        ? {
            paidWordwareStarted: false,
            paidWordwareCompleted: false,
          }
        : { wordwareStarted: false, wordwareCompleted: false };
      await updateUser({
        user: {
          ...user,
          ...statusObject,
        },
      });
      console.log(`[${username}] Updated user status to indicate failure.`);
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

    response.data.on('data', (chunk: Buffer) => {
      if (abortController.signal.aborted) {
        throw new Error('Stream processing timed out')
      }

      const decodedChunk = decoder.decode(chunk, { stream: true })
      buffer += decodedChunk
      chunkCount++
      const now = Date.now()
      console.log(`[${username}] Chunk #${chunkCount} received at ${new Date(now).toISOString()}, ${now - lastChunkTime}ms since last chunk`)
      lastChunkTime = now

      if (chunkCount <= 5) {
        console.log(`[${username}] Full chunk content: ${decodedChunk}`)
      }

      if (chunkCount % 10 === 0) {
        console.log(`[${username}] Buffer size: ${buffer.length} characters`)
        logMemoryUsage()
      }

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        try {
          const content = JSON.parse(line)
          const value = content.value

          if (value.type === 'generation') {
            console.log(`[${username}] Generation event: ${value.state} - ${value.label}`)
            generationEventCount++
            if (value.state === 'start') {
              if (value.label === 'output') {
                finalOutput = true
                console.log(`[${username}] finalOutput set to true`)
              }
            } else {
              if (value.label === 'output') {
                finalOutput = false
                console.log(`[${username}] finalOutput set to false`)
              }
            }
          } else if (value.type === 'chunk') {
            if (finalOutput) {
              writer.write(encoder.encode(value.value ?? ''))
              console.log(`[${username}] Enqueued chunk: ${(value.value ?? '').slice(0, 50)}...`)
            }
          } else if (value.type === 'outputs') {
            console.log(`[${username}] Received final output from Wordware. Now parsing`)
            await saveAnalysisAndUpdateUser(user, value, full)
          }

          if (!finalOutput && chunkCount >= FORCE_FINAL_OUTPUT_AFTER) {
            console.log(`[${username}] Forcing finalOutput to true after ${FORCE_FINAL_OUTPUT_AFTER} chunks`)
            finalOutput = true
          }
        } catch (error) {
          console.error(`[${username}] Error processing line:`, error, 'Line content:', line)
        }
      }
    })

    response.data.on('end', () => {
      console.log(`[${username}] Stream ended`)
      clearTimeout(timeoutId)
      console.log(`[${username}] Stream processing finished`)
      console.log(`[${username}] Total chunks processed: ${chunkCount}`)
      console.log(`[${username}] Total generation events: ${generationEventCount}`)
      writer.close()
    })

    return new NextResponse(stream.readable, {
      headers: { 'Content-Type': 'text/plain' },
    })
  } catch (error) {
    console.error(`[${username}] Error in Wordware API call:`, error)
    if (error.name === 'AbortError') {
      console.error(`[${username}] Stream processing timed out after`, timeoutDuration / 1000, 'seconds')
    }
    clearTimeout(timeoutId)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
