require('dotenv').config();

const { App } = require('@slack/bolt');
const cron = require('node-cron');
const db = require('./db');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

const REACTION_NAME = 'helpful';
const GIF_SEARCH_TERMS = ['awesome', 'great job', 'celebrate', 'thank you', 'you rock'];
const LEADERBOARD_CHANNEL = process.env.LEADERBOARD_CHANNEL || 'dynamic-agency-hq';

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
  const { newCount, newThresholds, userId } = await db.incrementReaction(
    messageId,
    channelId,
    messageAuthorId
  );

  // Track monthly stats for the message author
  await db.incrementMonthlyHelpful(messageAuthorId);

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
      await db.markThresholdSent(messageId, threshold);
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
  const messageAuthorId = event.item_user;

  await db.decrementReaction(messageId);

  // Decrement monthly stats for the message author
  if (messageAuthorId) {
    await db.decrementMonthlyHelpful(messageAuthorId);
  }

  console.log(`Reaction removed from message ${messageId}`);
});

/**
 * Get medal emoji based on rank
 */
function getMedal(rank) {
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  return medals[rank] || '🏅';
}

/**
 * Get month name from month number
 */
function getMonthName(month) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return months[month - 1];
}

/**
 * Post monthly leaderboard to the designated channel
 */
async function postMonthlyLeaderboard() {
  const { year, month } = db.getPreviousMonth();
  const topUsers = await db.getTopHelpfulUsers(year, month, 5);

  if (topUsers.length === 0) {
    console.log(`No helpful reactions recorded for ${getMonthName(month)} ${year}`);
    return;
  }

  const monthName = getMonthName(month);

  // Build the leaderboard message
  const leaderboardText = topUsers.map((user, index) =>
    `${getMedal(index)} <@${user.user_id}> — ${user.helpful_count} helpful reaction${user.helpful_count === 1 ? '' : 's'}`
  ).join('\n');

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `🏆 ${monthName} Helpfulness Leaderboard`,
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Congratulations to our most helpful team members from ${monthName} ${year}!\n\n${leaderboardText}`
      }
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Keep spreading the helpfulness! React with :helpful: to recognize great contributions.'
        }
      ]
    }
  ];

  try {
    await app.client.chat.postMessage({
      channel: LEADERBOARD_CHANNEL,
      text: `🏆 ${monthName} Helpfulness Leaderboard`,
      blocks: blocks
    });

    console.log(`Posted ${monthName} ${year} leaderboard to #${LEADERBOARD_CHANNEL}`);
  } catch (error) {
    console.error('Error posting leaderboard:', error);
  }
}

/**
 * Post leaderboard for a specific month (or current month)
 */
async function postLeaderboardForMonth(year, month, channelId) {
  const topUsers = await db.getTopHelpfulUsers(year, month, 5);
  const monthName = getMonthName(month);

  if (topUsers.length === 0) {
    return { success: false, message: `No helpful reactions recorded for ${monthName} ${year}.` };
  }

  const leaderboardText = topUsers.map((user, index) =>
    `${getMedal(index)} <@${user.user_id}> — ${user.helpful_count} helpful reaction${user.helpful_count === 1 ? '' : 's'}`
  ).join('\n');

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `🏆 ${monthName} Helpfulness Leaderboard`,
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Congratulations to our most helpful team members from ${monthName} ${year}!\n\n${leaderboardText}`
      }
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Keep spreading the helpfulness! React with :helpful: to recognize great contributions.'
        }
      ]
    }
  ];

  try {
    await app.client.chat.postMessage({
      channel: channelId,
      text: `🏆 ${monthName} Helpfulness Leaderboard`,
      blocks: blocks
    });
    return { success: true, message: `Posted ${monthName} ${year} leaderboard!` };
  } catch (error) {
    console.error('Error posting leaderboard:', error);
    return { success: false, message: `Error posting leaderboard: ${error.message}` };
  }
}

// Slash command: /leaderboard [current|last|YYYY-MM]
app.command('/leaderboard', async ({ command, ack, respond }) => {
  await ack();

  const arg = command.text.trim().toLowerCase();
  let year, month;

  if (arg === '' || arg === 'last') {
    // Default: show last month
    const prev = db.getPreviousMonth();
    year = prev.year;
    month = prev.month;
  } else if (arg === 'current') {
    // Show current month so far
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  } else {
    // Try to parse YYYY-MM format
    const match = arg.match(/^(\d{4})-(\d{1,2})$/);
    if (match) {
      year = parseInt(match[1], 10);
      month = parseInt(match[2], 10);
      if (month < 1 || month > 12) {
        await respond('Invalid month. Use format: `/leaderboard YYYY-MM` (e.g., `/leaderboard 2025-01`)');
        return;
      }
    } else {
      await respond('Usage: `/leaderboard [current|last|YYYY-MM]`\n• `last` (default) - Previous month\n• `current` - Current month so far\n• `YYYY-MM` - Specific month (e.g., 2025-01)');
      return;
    }
  }

  const result = await postLeaderboardForMonth(year, month, command.channel_id);

  if (!result.success) {
    await respond(result.message);
  }
});

// Schedule monthly leaderboard post for 9 AM on the 1st of every month
cron.schedule('0 9 1 * *', () => {
  console.log('Running monthly leaderboard job...');
  postMonthlyLeaderboard();
});

// Start the app
(async () => {
  await db.initializeDatabase();
  await app.start();
  console.log('⚡️ Appreciation Bot is running in socket mode!');
  console.log('📊 Monthly leaderboard scheduled for 9 AM on the 1st of each month');
})();
