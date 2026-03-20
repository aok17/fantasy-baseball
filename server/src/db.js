// server/src/db.js
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seedDefaults } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createDb(dbPath) {
  // Use DATABASE_PATH env var (for Fly.io volume), fall back to local file
  if (!dbPath) {
    dbPath = process.env.DATABASE_PATH || join(__dirname, '..', '..', 'fantasy-baseball.db');
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  seedDefaults(db);

  // Migration: add espn_id column if missing (for existing DBs)
  try { db.exec('ALTER TABLE espn_rank ADD COLUMN espn_id INTEGER'); } catch (e) { /* column already exists */ }

  return db;
}
