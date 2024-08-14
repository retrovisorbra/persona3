import { getUser, updateUser } from '@/actions/actions'
import { TweetType } from '@/actions/types'
import { TwitterAnalysis } from '@/components/analysis/analysis'

export const maxDuration = 300

export async function POST(request: Request) {
  const { username, full } = await request.json()
  console.log(`[${username}] Received request for user: ${username}, full version: ${full}`)

  const user = await getUser({ username })
  if (!user) {
    console.error(`[${username}] User not found: ${username}`)
    throw Error(`User not found: ${username}`)
  }

  console.log(`[${username}] Checking if Wordware has already started for ${full ? 'paid' : 'free'} version`)

  if (!full) {
    if (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.warn(`[${username}] Wordware already started or completed for free version`)
      return Response.json({ error: 'Wordware already started' })
    }
  }

  if (full) {
    if (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.warn(`[${username}] Wordware already started or completed for paid version`)
      return Response.json({ error: 'Wordware already started' })
    }
  }

 
  function formatTweet(tweet: TweetType) {
    // console.log('Formatting', tweet)
    const isRetweet = tweet.isRetweet ? 'RT ' : ''
    const author = tweet.author?.userName ?? username
    const createdAt = tweet.createdAt
    const text = tweet.text ?? '' // Ensure text is not undefined
    const formattedText = text
      .split('\n')
      .map((line) => `${line}`)
      .join(`\n> `)
    return `**${isRetweet}@${author} - ${createdAt}**

> ${formattedText}

*retweets: ${tweet.retweetCount ?? 0}, replies: ${tweet.replyCount ?? 0}, likes: ${tweet.likeCount ?? 0}, quotes: ${tweet.quoteCount ?? 0}, views: ${tweet.viewCount ?? 0}*`
  }

    const tweets = user.tweets as TweetType[]
  console.log(`[${username}] Formatting ${tweets.length} tweets`)

  const tweetsMarkdown = tweets.map(formatTweet).join('\n---\n\n')

  const promptID = full ? process.env.WORDWARE_FULL_PROMPT_ID : process.env.WORDWARE_ROAST_PROMPT_ID
  console.log(`[${username}] Using prompt ID: ${promptID} for ${full ? 'paid' : 'free'} version`)

  console.log(`[${username}] Making request to Wordware API`)
  const runResponse = await fetch(`https://app.wordware.ai/api/released-app/${promptID}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.WORDWARE_API_KEY}`,
    },
    body: JSON.stringify({
      inputs: {
        tweets: `Tweets: ${tweetsMarkdown}`,
        profilePicture: user.profilePicture,
        profileInfo: user.fullProfile,
        version: '^1.0',
      },
    }),
  })

  console.log(`[${username}] API responded with status: ${runResponse.status} for ${full ? 'paid' : 'free'} version`)

  const reader = runResponse.body?.getReader()
  if (!reader || !runResponse.ok) {
    console.error(`[${username}] No reader or API call failed`, runResponse)
    return Response.json({ error: 'No reader' }, { status: 400 })
  }

  console.log(`[${username}] Updating user to indicate Wordware has started`)
  await updateUser({
    user: {
      ...user,
      wordwareStarted: true,
      wordwareStartedTime: new Date(),
    },
  })

  const decoder = new TextDecoder()
  let buffer: string[] = []
  let finalOutput = false
  const existingAnalysis = user?.analysis as TwitterAnalysis

  console.log(`[${username}] Starting stream processing`)
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            console.log(`[${username}] Stream processing completed`)
            controller.close()
            return
          }

          const chunk = decoder.decode(value)
          console.log(`[${username}] Received chunk:`, chunk)

          for (let i = 0, len = chunk.length; i < len; ++i) {
            const isChunkSeparator = chunk[i] === '\n'

            if (!isChunkSeparator) {
              buffer.push(chunk[i])
              continue
            }

            const line = buffer.join('').trimEnd()

            try {
              const content = JSON.parse(line)
              const value = content.value

              if (value.type === 'generation') {
                if (value.state === 'start') {
                  if (value.label === 'output') {
                    finalOutput = true
                  }
                  console.log(`[${username}] NEW GENERATION - ${value.label}`)
                } else {
                  if (value.label === 'output') {
                    finalOutput = false
                  }
                  console.log(`[${username}] END GENERATION - ${value.label}`)
                }
              } else if (value.type === 'chunk') {
                if (finalOutput) {
                  controller.enqueue(value.value ?? '')
                  console.log(`[${username}] Enqueued chunk: ${value.value}`)
                }
              } else if (value.type === 'outputs') {
                console.log(`[${username}] Wordware output:`, value.values.output)
                try {
                  const statusObject = full
                    ? {
                        paidWordwareStarted: true,
                        paidWordwareCompleted: true,
                      }
                    : { wordwareStarted: true, wordwareCompleted: true }
                  await updateUser({
                    user: {
                      ...user,
                      ...statusObject,
                      analysis: {
                        ...existingAnalysis,
                        ...value.values.output,
                      },
                    },
                  })
                  console.log(`[${username}] Analysis saved to database`)
                } catch (error) {
                  console.error(`[${username}] Error parsing or saving output:`, error)
                  const statusObject = full
                    ? {
                        paidWordwareStarted: false,
                        paidWordwareCompleted: false,
                      }
                    : { wordwareStarted: false, wordwareCompleted: false }
                  await updateUser({
                    user: {
                      ...user,
                      ...statusObject,
                    },
                  })
                }
              }
            } catch (error) {
              console.error(`[${username}] Error processing line:`, error)
            }

            buffer = []
          }
        }
      } catch (error) {
        console.error(`[${username}] Error in stream processing:`, error)
      } finally {
        console.log(`[${username}] Stream processing finished, releasing reader lock`)
        reader.releaseLock()
      }
    },
  })

  console.log(`[${username}] Returning stream response`)
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}

