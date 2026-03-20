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

  // Migrations for existing DBs
  try { db.exec('ALTER TABLE espn_rank ADD COLUMN espn_id INTEGER'); } catch (e) { /* column already exists */ }
  try { db.exec('ALTER TABLE combined_rankings RENAME COLUMN espn_adp TO espn_rank'); } catch (e) { /* already renamed or doesn't exist */ }
  try { db.exec('ALTER TABLE espn_adp RENAME TO espn_rank'); } catch (e) { /* already renamed */ }

  // Rename player_id → fg_id in raw tables (player_id now means FK to players.id)
  try { db.exec('ALTER TABLE pitchers_raw RENAME COLUMN player_id TO fg_id'); } catch (e) { /* already renamed */ }
  try { db.exec('ALTER TABLE batters_raw RENAME COLUMN player_id TO fg_id'); } catch (e) { /* already renamed */ }

  // Add player_id FK columns to satellite tables
  try { db.exec('ALTER TABLE pitchers_raw ADD COLUMN player_id INTEGER REFERENCES players(id)'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE batters_raw ADD COLUMN player_id INTEGER REFERENCES players(id)'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE pitcher_scores ADD COLUMN player_id INTEGER REFERENCES players(id)'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE batter_scores ADD COLUMN player_id INTEGER REFERENCES players(id)'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE injuries ADD COLUMN player_id INTEGER REFERENCES players(id)'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE espn_rank ADD COLUMN player_id INTEGER REFERENCES players(id)'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE position_eligibility ADD COLUMN player_id INTEGER REFERENCES players(id)'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE combined_rankings ADD COLUMN pos_rank INTEGER'); } catch (e) { /* already exists */ }

  // Migrate player_notes from name-keyed to player_id-keyed
  try {
    const hasNameCol = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('player_notes') WHERE name = 'name'").get();
    if (hasNameCol.cnt > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS player_notes_new (
          player_id INTEGER PRIMARY KEY REFERENCES players(id),
          note TEXT NOT NULL DEFAULT ''
        );
        INSERT OR IGNORE INTO player_notes_new (player_id, note)
          SELECT p.id, pn.note FROM player_notes pn
          JOIN players p ON p.name = pn.name;
        DROP TABLE player_notes;
        ALTER TABLE player_notes_new RENAME TO player_notes;
      `);
    }
  } catch (e) { /* table may already be migrated */ }

  // Create player_id indexes (after migrations ensure columns exist)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pitchers_raw_player_id ON pitchers_raw(player_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_batters_raw_player_id ON batters_raw(player_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pitcher_scores_player_id ON pitcher_scores(player_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_batter_scores_player_id ON batter_scores(player_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_injuries_player_id ON injuries(player_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_espn_rank_player_id ON espn_rank(player_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_position_eligibility_player_id ON position_eligibility(player_id)'); } catch (e) {}

  return db;
}
