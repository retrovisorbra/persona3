import { getUser, updateUser } from '@/actions/actions'
import { TweetType } from '@/actions/types'
import { TwitterAnalysis } from '@/components/analysis/analysis'

export const maxDuration = 300

// Utility function to parse partial JSON
function parsePartialJson(jsonText: string): any | undefined {
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    // If parsing fails, try to find the last complete object
    const lastObjectEnd = jsonText.lastIndexOf('}');
    if (lastObjectEnd !== -1) {
      try {
        return JSON.parse(jsonText.slice(0, lastObjectEnd + 1));
      } catch (e) {
        // If that fails too, return undefined
        return undefined;
      }
    }
    return undefined;
  }
}

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

  const reader = runResponse.body?.getReader()
  if (!reader || !runResponse.ok) {
    console.log(`[${username}] ERROR | Wordware API Error:`, runResponse.status, await runResponse.text())
    return new Response(JSON.stringify({ error: 'No reader' }), { status: 400 })
  }

  console.log(`[${username}] Received successful response from Wordware API`)

  console.log(`[${username}] Updating user to indicate Wordware has started`)
  await updateUser({
    user: {
      ...user,
      wordwareStarted: true,
      wordwareStartedTime: new Date(),
    },
  })

  const existingAnalysis = user?.analysis as TwitterAnalysis
  let chunkCount = 0
  let lastChunkTime = Date.now()

  const stream = new ReadableStream({
    async start(controller) {
      console.log(`[${username}] Stream processing started`);
      let buffer = '';
      let lastProcessedValue = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            console.log(`[${username}] Stream reading completed`);
            if (lastProcessedValue) {
              // Attempt to save the last processed value if it exists
              console.log(`[${username}] Attempting to save analysis at the end of stream.`);
              await saveAnalysisAndUpdateUser(user, lastProcessedValue, full);
            }
            controller.close();
            return;
          }
          
          const chunk = new TextDecoder().decode(value);
          chunkCount++;
          const now = Date.now();
          console.log(`[${username}] Chunk #${chunkCount} received at ${new Date(now).toISOString()}, ${now - lastChunkTime}ms since last chunk`);
          lastChunkTime = now;
          
          if (chunkCount <= 5) {
            console.log(`[${username}] Full chunk content: ${chunk}`);
          }
          
          buffer += chunk;
          let parseResult;
          while ((parseResult = parsePartialJson(buffer)) !== undefined) {
            const content = parseResult;
            buffer = buffer.slice(buffer.indexOf('}') + 1);
            
            if (content.type === 'chunk') {
              controller.enqueue(content.value.value ?? '');
              console.log(`[${username}] Enqueued chunk: ${(content.value.value ?? '').slice(0, 50)}...`);
            } else if (content.type === 'outputs') {
              console.log(`[${username}] Received final output from Wordware. Now parsing`);
              lastProcessedValue = content;
              await saveAnalysisAndUpdateUser(user, content, full);
            }
          }
        }
      } catch (error) {
        console.error(`[${username}] Critical error in stream processing:`, error);
      } finally {
        console.log(`[${username}] Stream processing finished`);
        console.log(`[${username}] Total chunks processed: ${chunkCount}`);
        if (lastProcessedValue) {
          // Attempt to save analysis if it wasn't saved during the process
          console.log(`[${username}] Attempting final save of analysis.`);
          await saveAnalysisAndUpdateUser(user, lastProcessedValue, full);
        }
        reader.releaseLock();
      }
    },
  })

  async function saveAnalysisAndUpdateUser(user, value, full) {
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

  console.log(`[${username}] Returning stream response`)
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain' },
  })
}
