require('dotenv').config();

const { App } = require('@slack/bolt');
const db = require('./db');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

const REACTION_NAME = 'helpful';
const GIF_SEARCH_TERMS = ['awesome', 'great job', 'celebrate', 'thank you', 'you rock'];

/**
 * Get a random GIF from Giphy
 */
async function getRandomGif() {
  const searchTerm = GIF_SEARCH_TERMS[Math.floor(Math.random() * GIF_SEARCH_TERMS.length)];
  const apiKey = process.env.GIPHY_API_KEY;

  try {
    const url = `https://api.giphy.com/v1/gifs/random?api_key=${apiKey}&tag=${encodeURIComponent(searchTerm)}&rating=g`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.data && data.data.images) {
      return data.data.images.downsized.url;
    }
  } catch (error) {
    console.error('Error fetching GIF:', error);
  }

  return null;
}

/**
 * Build the congratulations message for a threshold
 */
function buildMessage(threshold, gifUrl) {
  const messages = {
    1: "Someone found your message helpful! You're making a difference. 🌟",
    5: "Wow! 5 people found your message helpful! You're on fire! 🔥",
    10: "Amazing! 10 helpful reactions! You're a real team asset! 💪",
    20: "Incredible! 20 helpful reactions! You're a superstar! ⭐"
  };

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: messages[threshold] || `Your message just hit ${threshold} helpful reactions!`
      }
    }
  ];

  if (gifUrl) {
    blocks.push({
      type: 'image',
      image_url: gifUrl,
      alt_text: 'Celebration GIF'
    });
  }

  return blocks;
}

/**
 * Send a DM using pre-opened channel (fast path)
 */
async function sendCongratsDMFast(client, dmChannelId, threshold, messageLink, gifUrl) {
  try {
    // Build the message
    const blocks = buildMessage(threshold, gifUrl);

    // Add link to original message
    if (messageLink) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${messageLink}|View the message>`
          }
        ]
      });
    }

    await client.chat.postMessage({
      channel: dmChannelId,
      text: `Your message just hit ${threshold} helpful reaction(s)!`,
      blocks: blocks
    });

    console.log(`Sent ${threshold}-reaction DM`);
  } catch (error) {
    console.error('Error sending DM:', error);
  }
}

/**
 * Get permalink for a message
 */
async function getMessageLink(client, channelId, messageTs) {
  try {
    const result = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs
    });
    return result.permalink;
  } catch (error) {
    console.error('Error getting permalink:', error);
    return null;
  }
}

// Listen for reaction_added events
app.event('reaction_added', async ({ event, client }) => {
  // Only track :helpful: reactions
  if (event.reaction !== REACTION_NAME) {
    return;
  }

  const { item, item_user } = event;

  // Only handle message reactions
  if (item.type !== 'message') {
    return;
  }

  const messageId = `${item.channel}-${item.ts}`;
  const channelId = item.channel;
  const messageAuthorId = item_user;

  // Don't notify if author reacts to their own message
  if (event.user === messageAuthorId) {
    console.log('Skipping self-reaction');
    return;
  }

  // Increment reaction and check for new thresholds
  const { newCount, newThresholds, userId } = db.incrementReaction(
    messageId,
    channelId,
    messageAuthorId
  );

  console.log(`Message ${messageId} now has ${newCount} helpful reactions`);

  // Send DMs for any newly crossed thresholds
  if (newThresholds.length > 0) {
    // Fetch GIF, permalink, and open DM channel all in parallel for speed
    const [messageLink, gifUrl, dmResult] = await Promise.all([
      getMessageLink(client, channelId, item.ts),
      getRandomGif(),
      client.conversations.open({ users: userId })
    ]);

    const dmChannelId = dmResult.channel.id;

    for (const threshold of newThresholds) {
      await sendCongratsDMFast(client, dmChannelId, threshold, messageLink, gifUrl);
      db.markThresholdSent(messageId, threshold);
    }
  }
});

// Listen for reaction_removed events
app.event('reaction_removed', async ({ event }) => {
  if (event.reaction !== REACTION_NAME) {
    return;
  }

  if (event.item.type !== 'message') {
    return;
  }

  const messageId = `${event.item.channel}-${event.item.ts}`;
  db.decrementReaction(messageId);

  console.log(`Reaction removed from message ${messageId}`);
});

// Start the app
(async () => {
  await app.start();
  console.log('⚡️ Appreciation Bot is running in socket mode!');
})();
