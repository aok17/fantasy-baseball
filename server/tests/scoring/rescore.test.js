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

describe('rescoreAll edge cases', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    const schema = readFileSync(join(__dirname, '..', '..', 'src', 'schema.sql'), 'utf8');
    db.exec(schema);
    seedDefaults(db);
  });

  afterEach(() => { db.close(); });

  it('handles empty pitchers_raw gracefully', () => {
    // Only insert batter, no pitcher
    db.prepare(`INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS)
      VALUES ('Test OF', 'LAD', 150, 600, 550, 160, 30, 5, 35, 95, 100, 60, 130, 5, 15, 3)`).run();
    db.prepare(`INSERT INTO position_eligibility (name, source, position) VALUES ('Test OF', 'espn_2025', 'OF')`).run();
    rescoreAll(db);
    const rows = db.prepare('SELECT * FROM combined_rankings ORDER BY rank').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Test OF');
  });

  it('handles missing position_eligibility gracefully', () => {
    db.prepare(`INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS)
      VALUES ('Test OF', 'LAD', 150, 600, 550, 160, 30, 5, 35, 95, 100, 60, 130, 5, 15, 3)`).run();
    // No position_eligibility rows
    rescoreAll(db);
    const rows = db.prepare('SELECT * FROM batter_scores').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].position).toBe('DH');
  });

  it('handles empty database gracefully', () => {
    // No raw data at all
    rescoreAll(db);
    const rows = db.prepare('SELECT * FROM combined_rankings').all();
    expect(rows).toHaveLength(0);
  });
});

function freshDb() {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '..', '..', 'src', 'schema.sql'), 'utf8'));
  seedDefaults(db);
  return db;
}

describe('name canonicalization across projection feeds', () => {
  // Razzball publishes accent-stripped names where the FanGraphs data already in
  // players uses the accented spelling. Without canonicalization the exact-name
  // upsert creates a second row for the same player, splitting his roster link,
  // positions, injuries and planning projection.
  function seed() {
    const db = freshDb();
    db.prepare('INSERT INTO players (name, team) VALUES (?, ?)').run('Cristopher Sánchez', 'PHI');
    db.prepare('INSERT INTO players (name, team) VALUES (?, ?)').run('Carlos Rodón', 'NYY');
    return db;
  }

  it('reuses the existing accented row instead of inserting a stripped duplicate', () => {
    const db = seed();
    db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB)
      VALUES ('Cristopher Sanchez','PHI',30,30,180,12,8,18,0,0,160,70,15,180,45)`).run();
    rescoreAll(db);

    const rows = db.prepare("SELECT name FROM players WHERE team = 'PHI'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Cristopher Sánchez');
  });

  it('links the scored row to the existing player id', () => {
    const db = seed();
    const existing = db.prepare("SELECT id FROM players WHERE name = 'Carlos Rodón'").get().id;
    db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB)
      VALUES ('Carlos Rodon','NYY',30,30,175,13,7,17,0,0,150,68,20,190,60)`).run();
    rescoreAll(db);

    const scored = db.prepare("SELECT player_id, name FROM pitcher_scores WHERE name LIKE 'Carlos Rod%'").get();
    expect(scored.player_id).toBe(existing);
    expect(db.prepare("SELECT COUNT(*) n FROM players WHERE team = 'NYY'").get().n).toBe(1);
  });

  it('leaves a genuinely new player alone', () => {
    const db = seed();
    db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB)
      VALUES ('Brand New Arm','SEA',20,20,120,8,6,11,0,0,100,45,10,110,30)`).run();
    rescoreAll(db);
    expect(db.prepare("SELECT COUNT(*) n FROM players WHERE name = 'Brand New Arm'").get().n).toBe(1);
  });

  it('does not merge two different players who share a normalized name', () => {
    const db = freshDb();
    db.prepare('INSERT INTO players (name, team) VALUES (?, ?)').run('Luis Garcia', 'HOU');
    db.prepare('INSERT INTO players (name, team) VALUES (?, ?)').run('Luis García', 'WSN');
    db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB)
      VALUES ('Luis Garcia','HOU',30,30,180,12,8,18,0,0,160,70,15,180,45)`).run();
    rescoreAll(db);
    // Ambiguous by name alone, so the team-qualified match must win and neither
    // existing row may be collapsed into the other.
    expect(db.prepare("SELECT COUNT(*) n FROM players WHERE name LIKE 'Luis Garc%'").get().n).toBe(2);
  });
});
