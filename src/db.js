const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const THRESHOLDS = [1, 5, 10, 20];
const MILESTONES = [10, 25, 50, 100, 250, 500];

const TITLES = [
  { min: 500, title: 'Hall of Fame' },
  { min: 250, title: 'Legend' },
  { min: 100, title: 'Champion' },
  { min: 50,  title: 'Expert' },
  { min: 25,  title: 'Mentor' },
  { min: 10,  title: 'Helper' },
  { min: 1,   title: 'Contributor' },
  { min: 0,   title: 'Newcomer' },
];

function getTitle(count) {
  for (const tier of TITLES) {
    if (count >= tier.min) return tier.title;
  }
  return 'Newcomer';
}

/**
 * Initialize database schema
 */
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reaction_count INTEGER DEFAULT 0,
      threshold_1_sent INTEGER DEFAULT 0,
      threshold_5_sent INTEGER DEFAULT 0,
      threshold_10_sent INTEGER DEFAULT 0,
      threshold_20_sent INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS monthly_stats (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      helpful_count INTEGER DEFAULT 0,
      UNIQUE(user_id, year, month)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id TEXT PRIMARY KEY,
      all_time_count INTEGER DEFAULT 0,
      current_streak INTEGER DEFAULT 0,
      longest_streak INTEGER DEFAULT 0,
      last_reaction_date DATE,
      milestone_10_sent INTEGER DEFAULT 0,
      milestone_25_sent INTEGER DEFAULT 0,
      milestone_50_sent INTEGER DEFAULT 0,
      milestone_100_sent INTEGER DEFAULT 0,
      milestone_250_sent INTEGER DEFAULT 0,
      milestone_500_sent INTEGER DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      dm_notifications_enabled INTEGER DEFAULT 1
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS appreciations (
      id SERIAL PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      message TEXT,
      channel_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_activity (
      user_id TEXT NOT NULL,
      activity_date DATE NOT NULL,
      reaction_count INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, activity_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_stats (
      user_id TEXT NOT NULL,
      week_start DATE NOT NULL,
      weekly_count INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, week_start)
    )
  `);

  // Indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_appreciations_recipient ON appreciations (recipient_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_weekly_stats_week ON weekly_stats (week_start)`);

  console.log('Database initialized');
}

// ---------------------------------------------------------------------------
// Message-level reaction tracking (existing)
// ---------------------------------------------------------------------------

/**
 * Increment reaction count atomically and return any newly crossed thresholds.
 */
async function incrementReaction(messageId, channelId, userId) {
  await pool.query(
    `INSERT INTO messages (id, channel_id, user_id, reaction_count)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (id) DO NOTHING`,
    [messageId, channelId, userId]
  );

  const result = await pool.query(
    `UPDATE messages SET reaction_count = reaction_count + 1
     WHERE id = $1
     RETURNING *`,
    [messageId]
  );

  const message = result.rows[0];
  const newCount = message.reaction_count;

  const newThresholds = [];
  for (const threshold of THRESHOLDS) {
    const columnName = `threshold_${threshold}_sent`;
    if (newCount >= threshold && !message[columnName]) {
      newThresholds.push(threshold);
    }
  }

  return { newCount, newThresholds, userId: message.user_id };
}

async function markThresholdSent(messageId, threshold) {
  const columnName = `threshold_${threshold}_sent`;
  await pool.query(`UPDATE messages SET ${columnName} = 1 WHERE id = $1`, [messageId]);
}

async function decrementReaction(messageId) {
  const result = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
  if (result.rows.length > 0 && result.rows[0].reaction_count > 0) {
    await pool.query('UPDATE messages SET reaction_count = reaction_count - 1 WHERE id = $1', [messageId]);
  }
}

async function getMessageStats(messageId) {
  const result = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Monthly stats (existing)
// ---------------------------------------------------------------------------

async function incrementMonthlyHelpful(userId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  await pool.query(`
    INSERT INTO monthly_stats (user_id, year, month, helpful_count)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT(user_id, year, month)
    DO UPDATE SET helpful_count = monthly_stats.helpful_count + 1
  `, [userId, year, month]);
}

async function decrementMonthlyHelpful(userId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  await pool.query(`
    UPDATE monthly_stats
    SET helpful_count = GREATEST(0, helpful_count - 1)
    WHERE user_id = $1 AND year = $2 AND month = $3
  `, [userId, year, month]);
}

async function getTopHelpfulUsers(year, month, limit = 5) {
  const result = await pool.query(`
    SELECT user_id, helpful_count
    FROM monthly_stats
    WHERE year = $1 AND month = $2 AND helpful_count > 0
    ORDER BY helpful_count DESC
    LIMIT $3
  `, [year, month, limit]);
  return result.rows;
}

function getPreviousMonth() {
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  return { year, month };
}

// ---------------------------------------------------------------------------
// User stats, streaks, milestones (new)
// ---------------------------------------------------------------------------

/**
 * Atomically increment all-time count, update streak, and track daily/weekly activity.
 * Returns the updated user_stats row.
 */
async function incrementUserStats(userId) {
  const result = await pool.query(`
    INSERT INTO user_stats (user_id, all_time_count, current_streak, longest_streak, last_reaction_date)
    VALUES ($1, 1, 1, 1, CURRENT_DATE)
    ON CONFLICT (user_id) DO UPDATE SET
      all_time_count = user_stats.all_time_count + 1,
      current_streak = CASE
        WHEN user_stats.last_reaction_date = CURRENT_DATE THEN user_stats.current_streak
        WHEN user_stats.last_reaction_date = CURRENT_DATE - INTERVAL '1 day' THEN user_stats.current_streak + 1
        ELSE 1
      END,
      longest_streak = GREATEST(
        user_stats.longest_streak,
        CASE
          WHEN user_stats.last_reaction_date = CURRENT_DATE THEN user_stats.current_streak
          WHEN user_stats.last_reaction_date = CURRENT_DATE - INTERVAL '1 day' THEN user_stats.current_streak + 1
          ELSE 1
        END
      ),
      last_reaction_date = CURRENT_DATE
    RETURNING *
  `, [userId]);

  // Track daily and weekly activity in parallel
  await Promise.all([
    pool.query(`
      INSERT INTO daily_activity (user_id, activity_date, reaction_count)
      VALUES ($1, CURRENT_DATE, 1)
      ON CONFLICT (user_id, activity_date) DO UPDATE SET reaction_count = daily_activity.reaction_count + 1
    `, [userId]),
    pool.query(`
      INSERT INTO weekly_stats (user_id, week_start, weekly_count)
      VALUES ($1, date_trunc('week', CURRENT_DATE)::date, 1)
      ON CONFLICT (user_id, week_start) DO UPDATE SET weekly_count = weekly_stats.weekly_count + 1
    `, [userId])
  ]);

  return result.rows[0];
}

/**
 * Decrement all-time count and daily/weekly tracking. Does NOT undo streaks.
 */
async function decrementUserStats(userId) {
  await Promise.all([
    pool.query(`
      UPDATE user_stats SET all_time_count = GREATEST(0, all_time_count - 1)
      WHERE user_id = $1
    `, [userId]),
    pool.query(`
      UPDATE daily_activity SET reaction_count = GREATEST(0, reaction_count - 1)
      WHERE user_id = $1 AND activity_date = CURRENT_DATE
    `, [userId]),
    pool.query(`
      UPDATE weekly_stats SET weekly_count = GREATEST(0, weekly_count - 1)
      WHERE user_id = $1 AND week_start = date_trunc('week', CURRENT_DATE)::date
    `, [userId])
  ]);
}

/**
 * Check if the user crossed a new all-time milestone. Returns the milestone number or null.
 */
async function checkAndMarkMilestone(userId, allTimeCount) {
  for (const milestone of MILESTONES) {
    if (allTimeCount >= milestone) {
      const col = `milestone_${milestone}_sent`;
      const result = await pool.query(
        `UPDATE user_stats SET ${col} = 1 WHERE user_id = $1 AND ${col} = 0 RETURNING *`,
        [userId]
      );
      if (result.rows.length > 0) {
        return milestone; // newly crossed
      }
    }
  }
  return null;
}

/**
 * Get a user's all-time stats. Returns defaults if no row exists.
 */
async function getUserStats(userId) {
  const result = await pool.query('SELECT * FROM user_stats WHERE user_id = $1', [userId]);
  if (result.rows.length > 0) return result.rows[0];
  return { user_id: userId, all_time_count: 0, current_streak: 0, longest_streak: 0, last_reaction_date: null };
}

// ---------------------------------------------------------------------------
// Rankings (new)
// ---------------------------------------------------------------------------

async function getUserRank(userId, year, month) {
  const result = await pool.query(`
    SELECT rank FROM (
      SELECT user_id, RANK() OVER (ORDER BY helpful_count DESC) as rank
      FROM monthly_stats
      WHERE year = $2 AND month = $3 AND helpful_count > 0
    ) ranked
    WHERE user_id = $1
  `, [userId, year, month]);
  return result.rows.length > 0 ? parseInt(result.rows[0].rank) : null;
}

async function getUserMonthlyCount(userId, year, month) {
  const result = await pool.query(
    'SELECT helpful_count FROM monthly_stats WHERE user_id = $1 AND year = $2 AND month = $3',
    [userId, year, month]
  );
  return result.rows.length > 0 ? result.rows[0].helpful_count : 0;
}

async function getWeeklyRank(userId, weekStart) {
  const result = await pool.query(`
    SELECT rank FROM (
      SELECT user_id, RANK() OVER (ORDER BY weekly_count DESC) as rank
      FROM weekly_stats
      WHERE week_start = $2 AND weekly_count > 0
    ) ranked
    WHERE user_id = $1
  `, [userId, weekStart]);
  return result.rows.length > 0 ? parseInt(result.rows[0].rank) : null;
}

// ---------------------------------------------------------------------------
// User settings (new)
// ---------------------------------------------------------------------------

async function getDMEnabled(userId) {
  const result = await pool.query(
    'SELECT dm_notifications_enabled FROM user_settings WHERE user_id = $1',
    [userId]
  );
  if (result.rows.length === 0) return true; // default on
  return result.rows[0].dm_notifications_enabled === 1;
}

async function setDMEnabled(userId, enabled) {
  await pool.query(`
    INSERT INTO user_settings (user_id, dm_notifications_enabled) VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE SET dm_notifications_enabled = $2
  `, [userId, enabled ? 1 : 0]);
}

// ---------------------------------------------------------------------------
// Appreciations (new)
// ---------------------------------------------------------------------------

async function createAppreciation(senderId, recipientId, message, channelId) {
  const result = await pool.query(
    `INSERT INTO appreciations (sender_id, recipient_id, message, channel_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [senderId, recipientId, message, channelId]
  );

  // Increment the recipient's stats (same as receiving a reaction)
  await incrementUserStats(recipientId);
  await incrementMonthlyHelpful(recipientId);

  return result.rows[0];
}

async function getRecentAppreciations(userId, limit = 5) {
  const result = await pool.query(
    `SELECT * FROM appreciations WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Weekly digest (new)
// ---------------------------------------------------------------------------

async function getWeeklyDigestUsers(weekStart) {
  const result = await pool.query(`
    SELECT ws.user_id, ws.weekly_count
    FROM weekly_stats ws
    LEFT JOIN user_settings us ON ws.user_id = us.user_id
    WHERE ws.week_start = $1
      AND ws.weekly_count > 0
      AND (us.dm_notifications_enabled IS NULL OR us.dm_notifications_enabled = 1)
    ORDER BY ws.weekly_count DESC
  `, [weekStart]);
  return result.rows;
}

/**
 * Close the connection pool for graceful shutdown
 */
async function close() {
  await pool.end();
}

module.exports = {
  initializeDatabase,
  incrementReaction,
  decrementReaction,
  markThresholdSent,
  getMessageStats,
  incrementMonthlyHelpful,
  decrementMonthlyHelpful,
  getTopHelpfulUsers,
  getPreviousMonth,
  incrementUserStats,
  decrementUserStats,
  checkAndMarkMilestone,
  getUserStats,
  getUserRank,
  getUserMonthlyCount,
  getWeeklyRank,
  getDMEnabled,
  setDMEnabled,
  createAppreciation,
  getRecentAppreciations,
  getWeeklyDigestUsers,
  getTitle,
  close,
  THRESHOLDS,
  MILESTONES,
  TITLES
};
