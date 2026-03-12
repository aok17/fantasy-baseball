// server/src/db.js
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seedDefaults } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createDb(dbPath = join(__dirname, '..', '..', 'fantasy-baseball.db')) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  seedDefaults(db);

  return db;
}
