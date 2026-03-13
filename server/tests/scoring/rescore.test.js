import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seedDefaults } from '../../src/seed.js';
import { rescoreAll } from '../../src/scoring/rescore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('rescoreAll', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    const schema = readFileSync(join(__dirname, '..', '..', 'src', 'schema.sql'), 'utf8');
    db.exec(schema);
    seedDefaults(db);

    db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB)
      VALUES ('Test SP', 'NYY', 30, 30, 200, 15, 8, 25, 0, 0, 170, 70, 20, 200, 50)`).run();

    db.prepare(`INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS)
      VALUES ('Test OF', 'LAD', 150, 600, 550, 160, 30, 5, 35, 95, 100, 60, 130, 5, 15, 3)`).run();

    db.prepare(`INSERT INTO position_eligibility (name, source, position) VALUES ('Test OF', 'espn_2025', 'OF')`).run();
  });

  afterEach(() => { db.close(); });

  it('populates pitcher_scores', () => {
    rescoreAll(db);
    const rows = db.prepare('SELECT * FROM pitcher_scores').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Test SP');
    expect(rows[0].scoring_position).toBe('SP');
  });

  it('populates batter_scores', () => {
    rescoreAll(db);
    const rows = db.prepare('SELECT * FROM batter_scores').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Test OF');
    expect(rows[0].position).toBe('OF');
  });

  it('populates combined_rankings with both players', () => {
    rescoreAll(db);
    const rows = db.prepare('SELECT * FROM combined_rankings ORDER BY rank').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(2);
  });
});
