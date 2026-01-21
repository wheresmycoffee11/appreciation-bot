const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'appreciation.db');
const db = new Database(dbPath);

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    reaction_count INTEGER DEFAULT 0,
    threshold_1_sent INTEGER DEFAULT 0,
    threshold_5_sent INTEGER DEFAULT 0,
    threshold_10_sent INTEGER DEFAULT 0,
    threshold_20_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Monthly stats table for leaderboard tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS monthly_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    helpful_count INTEGER DEFAULT 0,
    UNIQUE(user_id, year, month)
  )
`);

const THRESHOLDS = [1, 5, 10, 20];

/**
 * Get or create a message record
 */
function getOrCreateMessage(messageId, channelId, userId) {
  const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);

  if (existing) {
    return existing;
  }

  db.prepare(`
    INSERT INTO messages (id, channel_id, user_id, reaction_count)
    VALUES (?, ?, ?, 0)
  `).run(messageId, channelId, userId);

  return db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
}

/**
 * Increment reaction count and return any newly crossed thresholds
 */
function incrementReaction(messageId, channelId, userId) {
  const message = getOrCreateMessage(messageId, channelId, userId);
  const oldCount = message.reaction_count;
  const newCount = oldCount + 1;

  db.prepare('UPDATE messages SET reaction_count = ? WHERE id = ?').run(newCount, messageId);

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
function markThresholdSent(messageId, threshold) {
  const columnName = `threshold_${threshold}_sent`;
  db.prepare(`UPDATE messages SET ${columnName} = 1 WHERE id = ?`).run(messageId);
}

/**
 * Decrement reaction count (for reaction_removed events)
 */
function decrementReaction(messageId) {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);

  if (message && message.reaction_count > 0) {
    db.prepare('UPDATE messages SET reaction_count = reaction_count - 1 WHERE id = ?').run(messageId);
  }
}

/**
 * Get message stats (for debugging/admin purposes)
 */
function getMessageStats(messageId) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
}

/**
 * Increment a user's monthly helpful count
 */
function incrementMonthlyHelpful(userId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // JavaScript months are 0-indexed

  db.prepare(`
    INSERT INTO monthly_stats (user_id, year, month, helpful_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(user_id, year, month)
    DO UPDATE SET helpful_count = helpful_count + 1
  `).run(userId, year, month);
}

/**
 * Decrement a user's monthly helpful count
 */
function decrementMonthlyHelpful(userId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  db.prepare(`
    UPDATE monthly_stats
    SET helpful_count = MAX(0, helpful_count - 1)
    WHERE user_id = ? AND year = ? AND month = ?
  `).run(userId, year, month);
}

/**
 * Get top helpful users for a given month
 */
function getTopHelpfulUsers(year, month, limit = 5) {
  return db.prepare(`
    SELECT user_id, helpful_count
    FROM monthly_stats
    WHERE year = ? AND month = ? AND helpful_count > 0
    ORDER BY helpful_count DESC
    LIMIT ?
  `).all(year, month, limit);
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
