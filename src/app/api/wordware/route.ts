import { getUser, updateUser } from '@/actions/actions'
import { TweetType } from '@/actions/types'
import { TwitterAnalysis } from '@/components/analysis/analysis'

/**
 * Maximum duration for the API route execution (in seconds)
 */
export const maxDuration = 300

/**
 * POST handler for the Wordware API route
 * @param {Request} request - The incoming request object
 * @returns {Promise<Response>} The response object
 */
export async function POST(request: Request) {
  // Extract username from the request body
  const { username, full } = await request.json()

  // Log the request received
  console.log(`Received request for user: ${username}, full version: ${full}`)

  // Fetch user data and check if Wordware has already been started
  const user = await getUser({ username })

  if (!user) {
    console.error(`User not found: ${username}`)
    throw Error(`User not found: ${username}`)
  }

  // Log which version is being checked
  console.log(`Checking if Wordware has already started for ${full ? 'paid' : 'free'} version`)

  if (!full) {
    if (user.wordwareCompleted || (user.wordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.warn(`Wordware already started or completed for free version for user: ${username}`)
      return Response.json({ error: 'Wordware already started' })
    }
  }

  if (full) {
    if (user.paidWordwareCompleted || (user.paidWordwareStarted && Date.now() - user.createdAt.getTime() < 3 * 60 * 1000)) {
      console.warn(`Wordware already started or completed for paid version for user: ${username}`)
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

  const tweetsMarkdown = tweets.map(formatTweet).join('\n---\n\n')

  const promptID = full ? process.env.WORDWARE_FULL_PROMPT_ID : process.env.WORDWARE_ROAST_PROMPT_ID

  // Log the prompt ID being used
  console.log(`Using prompt ID: ${promptID} for ${full ? 'paid' : 'free'} version`)

  // Make a request to the Wordware API
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

  // Log the response status from the API
  console.log(`API responded with status: ${runResponse.status} for ${full ? 'paid' : 'free'} version`)

  // Get the reader from the response body
  const reader = runResponse.body?.getReader()
  if (!reader || !runResponse.ok) {
    console.error('No reader or API call failed', runResponse)
    return Response.json({ error: 'No reader' }, { status: 400 })
  }

  // Update user to indicate Wordware has started
  console.log(`Updating user: ${username} to indicate Wordware has started`)
  await updateUser({
    user: {
      ...user,
      wordwareStarted: true,
      wordwareStartedTime: new Date(),
    },
  })

  // Set up decoder and buffer for processing the stream
  const decoder = new TextDecoder()
  let buffer: string[] = []
  let finalOutput = false
  const existingAnalysis = user?.analysis as TwitterAnalysis

  // Create a readable stream to process the response
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            controller.close()
            return
          }

          const chunk = decoder.decode(value)
          // Log the chunk received
          console.log('Received chunk:', chunk)

          // Process the chunk character by character
          for (let i = 0, len = chunk.length; i < len; ++i) {
            const isChunkSeparator = chunk[i] === '\n'

            if (!isChunkSeparator) {
              buffer.push(chunk[i])
              continue
            }

            const line = buffer.join('').trimEnd()

            // Parse the JSON content of each line
            const content = JSON.parse(line)
            const value = content.value

            // Handle different types of messages in the stream
            if (value.type === 'generation') {
              if (value.state === 'start') {
                if (value.label === 'output') {
                  finalOutput = true
                }
                // Log the start of a new generation
                console.log('\nNEW GENERATION -', value.label)
              } else {
                if (value.label === 'output') {
                  finalOutput = false
                }
                // Log the end of a generation
                console.log('\nEND GENERATION -', value.label)
              }
            } else if (value.type === 'chunk') {
              if (finalOutput) {
                controller.enqueue(value.value ?? '')
              }
            } else if (value.type === 'outputs') {
              console.log('✨ Wordware:', value.values.output, '. Now parsing')
              try {
                const statusObject = full
                  ? {
                      paidWordwareStarted: true,
                      paidWordwareCompleted: true,
                    }
                  : { wordwareStarted: true, wordwareCompleted: true }
                // Update user with the analysis from Wordware
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
                // Log that analysis is saved to the database
                console.log('Analysis saved to database')
              } catch (error) {
                console.error('Error parsing or saving output:', error)

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

            // Reset buffer for the next line
            buffer = []
          }
        }
      } finally {
        // Ensure the reader is released when done
        reader.releaseLock()
      }
    },
  })

  // Return the stream as the response
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
