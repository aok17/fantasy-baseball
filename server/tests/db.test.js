// server/tests/db.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seedDefaults } from '../src/seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'src', 'schema.sql');

describe('database schema', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all required tables', () => {
    const schema = readFileSync(schemaPath, 'utf8');
    db.exec(schema);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    expect(tables).toContain('pitchers_raw');
    expect(tables).toContain('batters_raw');
    expect(tables).toContain('statcast_pitches');
    expect(tables).toContain('pitcher_scores');
    expect(tables).toContain('batter_scores');
    expect(tables).toContain('combined_rankings');
    expect(tables).toContain('draft_sessions');
    expect(tables).toContain('draft_picks');
    expect(tables).toContain('scoring_config');
    expect(tables).toContain('position_adjustments');
    expect(tables).toContain('app_config');
    expect(tables).toContain('name_replacements');
    expect(tables).toContain('position_eligibility');
    expect(tables).toContain('espn_adp');
    expect(tables).toContain('players');
  });
});

describe('seed defaults', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    const schema = readFileSync(schemaPath, 'utf8');
    db.exec(schema);
  });

  afterEach(() => {
    db.close();
  });

  it('seeds pitcher scoring weights', () => {
    seedDefaults(db);
    const weights = db.prepare(
      "SELECT stat, weight FROM scoring_config WHERE category='pitcher' ORDER BY stat"
    ).all();
    expect(weights.find(w => w.stat === 'IP').weight).toBe(2.1);
    expect(weights.find(w => w.stat === 'SV').weight).toBe(5.0);
    expect(weights.find(w => w.stat === 'SO').weight).toBe(1.0);
  });

  it('seeds batter scoring weights', () => {
    seedDefaults(db);
    const weights = db.prepare(
      "SELECT stat, weight FROM scoring_config WHERE category='batter' ORDER BY stat"
    ).all();
    expect(weights.find(w => w.stat === 'HR').weight).toBe(3.1);
    expect(weights.find(w => w.stat === 'SB').weight).toBe(2.0);
    expect(weights.find(w => w.stat === 'SO').weight).toBe(-1.0);
  });

  it('seeds position adjustments', () => {
    seedDefaults(db);
    const adj = db.prepare(
      "SELECT position, adjustment FROM position_adjustments ORDER BY position"
    ).all();
    expect(adj.find(a => a.position === 'C').adjustment).toBe(70);
    expect(adj.find(a => a.position === 'SS').adjustment).toBe(20);
  });

  it('seeds app config defaults', () => {
    seedDefaults(db);
    const rl = db.prepare("SELECT value FROM app_config WHERE key='replacement_level'").get();
    expect(rl.value).toBe('237');
    const ps = db.prepare("SELECT value FROM app_config WHERE key='projection_system'").get();
    expect(ps.value).toBe('steamer');
  });
});
