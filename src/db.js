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

module.exports = {
  getOrCreateMessage,
  incrementReaction,
  decrementReaction,
  markThresholdSent,
  getMessageStats,
  THRESHOLDS
};
