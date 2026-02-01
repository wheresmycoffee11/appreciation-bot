const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const THRESHOLDS = [1, 5, 10, 20];

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

  console.log('Database initialized');
}

/**
 * Get or create a message record
 */
async function getOrCreateMessage(messageId, channelId, userId) {
  const existing = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  await pool.query(
    'INSERT INTO messages (id, channel_id, user_id, reaction_count) VALUES ($1, $2, $3, 0)',
    [messageId, channelId, userId]
  );

  const result = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
  return result.rows[0];
}

/**
 * Increment reaction count and return any newly crossed thresholds
 */
async function incrementReaction(messageId, channelId, userId) {
  const message = await getOrCreateMessage(messageId, channelId, userId);
  const oldCount = message.reaction_count;
  const newCount = oldCount + 1;

  await pool.query('UPDATE messages SET reaction_count = $1 WHERE id = $2', [newCount, messageId]);

  // Check which thresholds are newly crossed
  const newThresholds = [];
  for (const threshold of THRESHOLDS) {
    const columnName = `threshold_${threshold}_sent`;
    if (newCount >= threshold && !message[columnName]) {
      newThresholds.push(threshold);
    }
  }

  return { newCount, newThresholds, userId: message.user_id };
}

/**
 * Mark a threshold as sent for a message
 */
async function markThresholdSent(messageId, threshold) {
  const columnName = `threshold_${threshold}_sent`;
  await pool.query(`UPDATE messages SET ${columnName} = 1 WHERE id = $1`, [messageId]);
}

/**
 * Decrement reaction count (for reaction_removed events)
 */
async function decrementReaction(messageId) {
  const result = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);

  if (result.rows.length > 0 && result.rows[0].reaction_count > 0) {
    await pool.query('UPDATE messages SET reaction_count = reaction_count - 1 WHERE id = $1', [messageId]);
  }
}

/**
 * Get message stats (for debugging/admin purposes)
 */
async function getMessageStats(messageId) {
  const result = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
  return result.rows[0];
}

/**
 * Increment a user's monthly helpful count
 */
async function incrementMonthlyHelpful(userId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // JavaScript months are 0-indexed

  await pool.query(`
    INSERT INTO monthly_stats (user_id, year, month, helpful_count)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT(user_id, year, month)
    DO UPDATE SET helpful_count = monthly_stats.helpful_count + 1
  `, [userId, year, month]);
}

/**
 * Decrement a user's monthly helpful count
 */
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

/**
 * Get top helpful users for a given month
 */
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

/**
 * Get previous month's year and month
 */
function getPreviousMonth() {
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth(); // Previous month
  return { year, month };
}

module.exports = {
  initializeDatabase,
  getOrCreateMessage,
  incrementReaction,
  decrementReaction,
  markThresholdSent,
  getMessageStats,
  incrementMonthlyHelpful,
  decrementMonthlyHelpful,
  getTopHelpfulUsers,
  getPreviousMonth,
  THRESHOLDS
};
