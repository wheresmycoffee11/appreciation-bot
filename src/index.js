require('dotenv').config();

const { App } = require('@slack/bolt');
const cron = require('node-cron');
const db = require('./db');

// Global error handlers — prevent any unhandled error from crashing the process
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Bolt app-level error handler
app.error(async (error) => {
  console.error('Bolt app error:', error);
});

// Configuration
const REACTION_NAMES = (process.env.REACTION_NAMES || 'helpful,thank-you,brilliant,clutch')
  .split(',')
  .map(s => s.trim());
const LEADERBOARD_CHANNEL = process.env.LEADERBOARD_CHANNEL || 'dynamic-agency-hq';
const SHOUTOUT_CHANNEL = process.env.SHOUTOUT_CHANNEL || LEADERBOARD_CHANNEL;
const GIF_SEARCH_TERMS = ['awesome', 'great job', 'celebrate', 'thank you', 'you rock'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function buildMessage(threshold, gifUrl) {
  const messages = {
    1: "Someone found your message helpful! You're making a difference. \u{1F31F}",
    5: "Wow! 5 people found your message helpful! You're on fire! \u{1F525}",
    10: "Amazing! 10 helpful reactions! You're a real team asset! \u{1F4AA}",
    20: "Incredible! 20 helpful reactions! You're a superstar! \u{2B50}"
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

async function sendCongratsDMFast(client, dmChannelId, threshold, messageLink, gifUrl) {
  try {
    const blocks = buildMessage(threshold, gifUrl);

    if (messageLink) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `<${messageLink}|View the message>` }]
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

function getMedal(rank) {
  const medals = ['\u{1F947}', '\u{1F948}', '\u{1F949}', '4\uFE0F\u20E3', '5\uFE0F\u20E3'];
  return medals[rank] || '\u{1F3C5}';
}

function getMonthName(month) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return months[month - 1];
}

/**
 * Post a public milestone shoutout when a user crosses an all-time milestone.
 */
async function postMilestoneShoutout(client, userId, milestone, totalCount) {
  const title = db.getTitle(totalCount);
  const gifUrl = await getRandomGif();

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '\u{1F389} Milestone Reached!', emoji: true }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<@${userId}> just hit *${milestone} all-time appreciations*! They've earned the title of *${title}*! \u{1F31F}`
      }
    }
  ];

  if (gifUrl) {
    blocks.push({ type: 'image', image_url: gifUrl, alt_text: 'Celebration GIF' });
  }

  try {
    await client.chat.postMessage({
      channel: SHOUTOUT_CHANNEL,
      text: `\u{1F389} <@${userId}> just hit ${milestone} all-time appreciations!`,
      blocks: blocks
    });
    console.log(`Posted milestone shoutout for ${userId}: ${milestone}`);
  } catch (error) {
    console.error('Error posting milestone shoutout:', error);
  }
}

// ---------------------------------------------------------------------------
// Reaction event handlers
// ---------------------------------------------------------------------------

app.event('reaction_added', async ({ event, client }) => {
  try {
    if (!REACTION_NAMES.includes(event.reaction)) {
      return;
    }

    const { item, item_user } = event;

    if (item.type !== 'message') {
      return;
    }

    const messageId = `${item.channel}-${item.ts}`;
    const channelId = item.channel;
    const messageAuthorId = item_user;

    if (!messageAuthorId) {
      console.log('Skipping reaction: no message author available');
      return;
    }

    if (event.user === messageAuthorId) {
      console.log('Skipping self-reaction');
      return;
    }

    // Increment per-message count and monthly stats
    const { newCount, newThresholds, userId } = await db.incrementReaction(
      messageId, channelId, messageAuthorId
    );
    await db.incrementMonthlyHelpful(messageAuthorId);

    // Increment all-time stats + streak
    const userStats = await db.incrementUserStats(messageAuthorId);

    // Check for all-time milestones
    const milestone = await db.checkAndMarkMilestone(messageAuthorId, userStats.all_time_count);
    if (milestone) {
      await postMilestoneShoutout(client, messageAuthorId, milestone, userStats.all_time_count);
    }

    console.log(`Message ${messageId} now has ${newCount} helpful reactions`);

    // Send DMs for any newly crossed per-message thresholds
    if (newThresholds.length > 0) {
      const dmEnabled = await db.getDMEnabled(userId);

      if (dmEnabled) {
        const [messageLink, gifUrl, dmResult] = await Promise.all([
          getMessageLink(client, channelId, item.ts),
          getRandomGif(),
          client.conversations.open({ users: userId })
        ]);

        const dmChannelId = dmResult.channel.id;

        for (const threshold of newThresholds) {
          await sendCongratsDMFast(client, dmChannelId, threshold, messageLink, gifUrl);
        }
      }

      // Always mark thresholds sent regardless of DM preference
      for (const threshold of newThresholds) {
        await db.markThresholdSent(messageId, threshold);
      }
    }
  } catch (error) {
    console.error('Error handling reaction_added:', error);
  }
});

app.event('reaction_removed', async ({ event }) => {
  try {
    if (!REACTION_NAMES.includes(event.reaction)) {
      return;
    }

    if (event.item.type !== 'message') {
      return;
    }

    const messageId = `${event.item.channel}-${event.item.ts}`;
    const messageAuthorId = event.item_user;

    await db.decrementReaction(messageId);

    if (messageAuthorId) {
      await db.decrementMonthlyHelpful(messageAuthorId);
      await db.decrementUserStats(messageAuthorId);
    }

    console.log(`Reaction removed from message ${messageId}`);
  } catch (error) {
    console.error('Error handling reaction_removed:', error);
  }
});

// ---------------------------------------------------------------------------
// Leaderboard (existing, enhanced with titles)
// ---------------------------------------------------------------------------

function buildLeaderboardBlocks(topUsers, monthName, year) {
  const leaderboardText = topUsers.map((user, index) => {
    const title = db.getTitle(user.all_time_count || 0);
    return `${getMedal(index)} <@${user.user_id}> _(${title})_ \u2014 ${user.helpful_count} helpful reaction${user.helpful_count === 1 ? '' : 's'}`;
  }).join('\n');

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `\u{1F3C6} ${monthName} Helpfulness Leaderboard`, emoji: true }
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
      elements: [{ type: 'mrkdwn', text: 'Keep spreading the helpfulness! React with :helpful: to recognize great contributions.' }]
    }
  ];
}

async function getTopUsersWithStats(year, month, limit) {
  const topUsers = await db.getTopHelpfulUsers(year, month, limit);
  // Enrich with all-time stats for titles
  const enriched = await Promise.all(topUsers.map(async (user) => {
    const stats = await db.getUserStats(user.user_id);
    return { ...user, all_time_count: stats.all_time_count };
  }));
  return enriched;
}

async function postMonthlyLeaderboard() {
  const { year, month } = db.getPreviousMonth();
  const topUsers = await getTopUsersWithStats(year, month, 5);

  if (topUsers.length === 0) {
    console.log(`No helpful reactions recorded for ${getMonthName(month)} ${year}`);
    return;
  }

  const blocks = buildLeaderboardBlocks(topUsers, getMonthName(month), year);

  try {
    await app.client.chat.postMessage({
      channel: LEADERBOARD_CHANNEL,
      text: `\u{1F3C6} ${getMonthName(month)} Helpfulness Leaderboard`,
      blocks: blocks
    });
    console.log(`Posted ${getMonthName(month)} ${year} leaderboard to #${LEADERBOARD_CHANNEL}`);
  } catch (error) {
    console.error('Error posting leaderboard:', error);
  }
}

async function postLeaderboardForMonth(year, month, channelId) {
  const topUsers = await getTopUsersWithStats(year, month, 5);
  const monthName = getMonthName(month);

  if (topUsers.length === 0) {
    return { success: false, message: `No helpful reactions recorded for ${monthName} ${year}.` };
  }

  const blocks = buildLeaderboardBlocks(topUsers, monthName, year);

  try {
    await app.client.chat.postMessage({
      channel: channelId,
      text: `\u{1F3C6} ${monthName} Helpfulness Leaderboard`,
      blocks: blocks
    });
    return { success: true, message: `Posted ${monthName} ${year} leaderboard!` };
  } catch (error) {
    console.error('Error posting leaderboard:', error);
    return { success: false, message: `Error posting leaderboard: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

// /leaderboard [current|last|YYYY-MM]
app.command('/leaderboard', async ({ command, ack, respond }) => {
  await ack();

  const arg = command.text.trim().toLowerCase();
  let year, month;

  if (arg === '' || arg === 'last') {
    const prev = db.getPreviousMonth();
    year = prev.year;
    month = prev.month;
  } else if (arg === 'current') {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  } else {
    const match = arg.match(/^(\d{4})-(\d{1,2})$/);
    if (match) {
      year = parseInt(match[1], 10);
      month = parseInt(match[2], 10);
      if (month < 1 || month > 12) {
        await respond('Invalid month. Use format: `/leaderboard YYYY-MM` (e.g., `/leaderboard 2025-01`)');
        return;
      }
    } else {
      await respond('Usage: `/leaderboard [current|last|YYYY-MM]`\n\u2022 `last` (default) - Previous month\n\u2022 `current` - Current month so far\n\u2022 `YYYY-MM` - Specific month (e.g., 2025-01)');
      return;
    }
  }

  const result = await postLeaderboardForMonth(year, month, command.channel_id);
  if (!result.success) {
    await respond(result.message);
  }
});

// /mystats — view your own stats
app.command('/mystats', async ({ command, ack, respond }) => {
  await ack();

  try {
    const userId = command.user_id;
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const [stats, monthlyCount, rank] = await Promise.all([
      db.getUserStats(userId),
      db.getUserMonthlyCount(userId, year, month),
      db.getUserRank(userId, year, month)
    ]);

    const title = db.getTitle(stats.all_time_count);
    const monthName = getMonthName(month);

    await respond({
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `\u{1F4CA} Your Appreciation Stats`, emoji: true }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Title:* ${title}\n*All-time appreciations:* ${stats.all_time_count}\n*${monthName} appreciations:* ${monthlyCount}${rank ? ` (Rank #${rank})` : ''}\n*Current streak:* ${stats.current_streak} day${stats.current_streak === 1 ? '' : 's'}\n*Longest streak:* ${stats.longest_streak} day${stats.longest_streak === 1 ? '' : 's'}`
          }
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Keep being helpful! Use `/appreciate-settings` to manage notifications.' }]
        }
      ]
    });
  } catch (error) {
    console.error('Error handling /mystats:', error);
    await respond('Something went wrong fetching your stats. Please try again.');
  }
});

// /appreciate @user [message] — give someone direct kudos
app.command('/appreciate', async ({ command, ack, respond, client }) => {
  await ack();

  try {
    const text = command.text.trim();
    const match = text.match(/^<@(\w+)\|?[^>]*>\s*([\s\S]*)?$/);

    if (!match) {
      await respond('Usage: `/appreciate @user [message]`\nExample: `/appreciate @jane Great job on the API refactor!`');
      return;
    }

    const recipientId = match[1];
    const message = (match[2] || '').trim();

    if (recipientId === command.user_id) {
      await respond("You can't appreciate yourself! But we appreciate you. \u{2764}\u{FE0F}");
      return;
    }

    // Store appreciation and increment stats
    await db.createAppreciation(command.user_id, recipientId, message, command.channel_id);

    // Post public message
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `\u{1F64F} <@${command.user_id}> appreciates <@${recipientId}>!${message ? '\n\n> ' + message : ''}`
        }
      }
    ];

    await client.chat.postMessage({
      channel: command.channel_id,
      text: `<@${command.user_id}> appreciates <@${recipientId}>!`,
      blocks: blocks
    });

    // Check for milestones
    const userStats = await db.getUserStats(recipientId);
    const milestone = await db.checkAndMarkMilestone(recipientId, userStats.all_time_count);
    if (milestone) {
      await postMilestoneShoutout(client, recipientId, milestone, userStats.all_time_count);
    }
  } catch (error) {
    console.error('Error handling /appreciate:', error);
    await respond('Something went wrong. Please try again.');
  }
});

// /appreciate-settings [on|off] — toggle DM notifications
app.command('/appreciate-settings', async ({ command, ack, respond }) => {
  await ack();

  try {
    const userId = command.user_id;
    const arg = command.text.trim().toLowerCase();

    let newSetting;
    if (arg === 'on') {
      newSetting = true;
    } else if (arg === 'off') {
      newSetting = false;
    } else {
      // Toggle
      const current = await db.getDMEnabled(userId);
      newSetting = !current;
    }

    await db.setDMEnabled(userId, newSetting);

    await respond(
      newSetting
        ? '\u{1F514} DM notifications are now *ON*. You will receive threshold DMs and weekly digests.'
        : '\u{1F515} DM notifications are now *OFF*. You will no longer receive threshold DMs or weekly digests. Public shoutouts are unaffected.'
    );
  } catch (error) {
    console.error('Error handling /appreciate-settings:', error);
    await respond('Something went wrong. Please try again.');
  }
});

// ---------------------------------------------------------------------------
// App Home tab
// ---------------------------------------------------------------------------

app.event('app_home_opened', async ({ event, client }) => {
  if (event.tab !== 'home') return;

  try {
    const userId = event.user;
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const [stats, monthlyCount, rank, recentAppreciations] = await Promise.all([
      db.getUserStats(userId),
      db.getUserMonthlyCount(userId, year, month),
      db.getUserRank(userId, year, month),
      db.getRecentAppreciations(userId, 5)
    ]);

    const title = db.getTitle(stats.all_time_count);
    const monthName = getMonthName(month);

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${title}`, emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*All-time appreciations:* ${stats.all_time_count}\n*Current streak:* ${stats.current_streak} day${stats.current_streak === 1 ? '' : 's'} | *Longest:* ${stats.longest_streak} day${stats.longest_streak === 1 ? '' : 's'}\n*${monthName}:* ${monthlyCount} appreciation${monthlyCount === 1 ? '' : 's'}${rank ? ` (Rank #${rank})` : ''}`
        }
      },
      { type: 'divider' },
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Recent Appreciations', emoji: true }
      }
    ];

    if (recentAppreciations.length > 0) {
      for (const a of recentAppreciations) {
        const date = new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `\u{1F64F} From <@${a.sender_id}>${a.message ? ': _' + a.message + '_' : ''} \u2014 ${date}`
          }
        });
      }
    } else {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_No direct appreciations yet. They\'ll show up here when someone uses `/appreciate @you`._' }
      });
    }

    blocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Use `/mystats` for a quick summary | `/appreciate @user` to recognize someone | `/appreciate-settings` to manage DMs' }]
      }
    );

    await client.views.publish({
      user_id: userId,
      view: { type: 'home', blocks: blocks }
    });
  } catch (error) {
    console.error('Error rendering App Home:', error);
  }
});

// ---------------------------------------------------------------------------
// Weekly digest
// ---------------------------------------------------------------------------

async function sendWeeklyDigests() {
  // Calculate previous week's Monday (date_trunc('week') in PG uses ISO weeks starting Monday)
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
  const daysBack = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // days since this Monday
  const lastMonday = new Date(now);
  lastMonday.setDate(now.getDate() - daysBack - 7); // go back to previous Monday
  lastMonday.setHours(0, 0, 0, 0);
  const weekStart = lastMonday.toISOString().split('T')[0];

  const users = await db.getWeeklyDigestUsers(weekStart);
  console.log(`Weekly digest: ${users.length} user(s) to notify for week of ${weekStart}`);

  for (const user of users) {
    try {
      const [stats, weeklyRank] = await Promise.all([
        db.getUserStats(user.user_id),
        db.getWeeklyRank(user.user_id, weekStart)
      ]);
      const title = db.getTitle(stats.all_time_count);

      const dmResult = await app.client.conversations.open({ users: user.user_id });
      await app.client.chat.postMessage({
        channel: dmResult.channel.id,
        text: 'Your weekly appreciation summary',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '\u{1F4F0} Weekly Appreciation Digest', emoji: true }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Last week you received:* ${user.weekly_count} appreciation${user.weekly_count === 1 ? '' : 's'}\n*Weekly rank:* #${weeklyRank || 'N/A'}\n*Current streak:* ${stats.current_streak} day${stats.current_streak === 1 ? '' : 's'}\n*Title:* ${title}\n*All-time total:* ${stats.all_time_count}`
            }
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: 'Use `/appreciate-settings off` to stop these digests.' }]
          }
        ]
      });

      // Throttle to respect Slack rate limits
      await new Promise(resolve => setTimeout(resolve, 1200));
    } catch (error) {
      console.error(`Failed to send weekly digest to ${user.user_id}:`, error);
    }
  }
}

// ---------------------------------------------------------------------------
// Cron jobs
// ---------------------------------------------------------------------------

// Monthly leaderboard: 9 AM on the 1st of every month
cron.schedule('0 9 1 * *', () => {
  console.log('Running monthly leaderboard job...');
  postMonthlyLeaderboard().catch((error) => {
    console.error('Leaderboard cron job failed:', error);
  });
});

// Weekly digest: Monday at 9 AM
cron.schedule('0 9 * * 1', () => {
  console.log('Running weekly digest job...');
  sendWeeklyDigests().catch((error) => {
    console.error('Weekly digest cron job failed:', error);
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown & startup
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  try {
    await app.stop();
  } catch (_) { /* already stopped */ }
  await db.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  try {
    await db.initializeDatabase();
    await app.start();
    console.log('\u26A1\uFE0F Appreciation Bot is running in socket mode!');
    console.log(`\u{1F3AF} Tracking reactions: ${REACTION_NAMES.join(', ')}`);
    console.log('\u{1F4CA} Monthly leaderboard scheduled for 9 AM on the 1st of each month');
    console.log('\u{1F4F0} Weekly digest scheduled for Monday at 9 AM');
  } catch (error) {
    console.error('Fatal: failed to start', error);
    process.exit(1);
  }
})();
