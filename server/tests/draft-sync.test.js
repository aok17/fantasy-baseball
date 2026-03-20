import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseMessage, mapPick, buildPlayerMap } from '../src/draft-sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseMessage', () => {
  it('parses SELECTED messages', () => {
    const result = parseMessage('SELECTED 8 35983 5');
    expect(result).toEqual({ type: 'SELECTED', teamId: 8, playerId: 35983, slotId: 5 });
  });

  it('parses SELECTING messages', () => {
    const result = parseMessage('SELECTING 6 30000');
    expect(result).toEqual({ type: 'SELECTING', teamId: 6, timeMs: 30000 });
  });

  it('parses CLOCK messages', () => {
    const result = parseMessage('CLOCK 6 28877 8');
    expect(result).toEqual({ type: 'CLOCK', teamId: 6, timeMs: 28877, pickIndex: 8 });
  });

  it('returns null for empty input', () => {
    expect(parseMessage('')).toBeNull();
    expect(parseMessage(null)).toBeNull();
  });

  it('returns type-only object for unrecognized messages', () => {
    expect(parseMessage('PONG PING%201774037721175')).toEqual({ type: 'PONG' });
    expect(parseMessage('AUTOSUGGEST 35983')).toEqual({ type: 'AUTOSUGGEST' });
  });

  it('handles messages with trailing newlines', () => {
    const result = parseMessage('SELECTED 10 42404 8\n');
    expect(result).toEqual({ type: 'SELECTED', teamId: 10, playerId: 42404, slotId: 8 });
  });
});

describe('mapPick', () => {
  const playerMap = { 35983: 'Aaron Judge', 42404: 'Bobby Witt Jr.' };
  const teamMap = { 7: 'me', 8: 'Tom', 10: 'Carl' };

  it('maps a SELECTED message to a draft pick', () => {
    const msg = { type: 'SELECTED', teamId: 8, playerId: 35983, slotId: 5 };
    const result = mapPick(msg, playerMap, teamMap, 1);
    expect(result).toEqual({
      player_name: 'Aaron Judge',
      pick_number: 1,
      drafted_by: 'Tom',
    });
  });

  it('labels own team picks as "me"', () => {
    const msg = { type: 'SELECTED', teamId: 7, playerId: 42404, slotId: 4 };
    const result = mapPick(msg, playerMap, teamMap, 3);
    expect(result).toEqual({
      player_name: 'Bobby Witt Jr.',
      pick_number: 3,
      drafted_by: 'me',
    });
  });

  it('uses "Unknown (#id)" for unmapped players', () => {
    const msg = { type: 'SELECTED', teamId: 8, playerId: 99999, slotId: 5 };
    const result = mapPick(msg, playerMap, teamMap, 1);
    expect(result.player_name).toBe('Unknown (#99999)');
  });

  it('uses team ID string for unmapped teams', () => {
    const msg = { type: 'SELECTED', teamId: 99, playerId: 35983, slotId: 5 };
    const result = mapPick(msg, playerMap, teamMap, 1);
    expect(result.drafted_by).toBe('Team 99');
  });
});

describe('buildPlayerMap', () => {
  it('builds espn_id to name map from DB', () => {
    const db = new Database(':memory:');
    const schema = readFileSync(join(__dirname, '..', 'src', 'schema.sql'), 'utf8');
    db.exec(schema);
    try { db.exec('ALTER TABLE espn_rank ADD COLUMN espn_id INTEGER'); } catch (e) {}
    db.prepare('INSERT INTO espn_rank (name, espn_id, adp_rank) VALUES (?, ?, ?)').run('Aaron Judge', 33192, 1);
    db.prepare('INSERT INTO espn_rank (name, espn_id, adp_rank) VALUES (?, ?, ?)').run('Mookie Betts', 33039, 5);
    db.prepare('INSERT INTO espn_rank (name, adp_rank) VALUES (?, ?)').run('No ESPN ID', 99);

    const map = buildPlayerMap(db);
    expect(map[33192]).toBe('Aaron Judge');
    expect(map[33039]).toBe('Mookie Betts');
    expect(Object.keys(map).length).toBe(2);
    db.close();
  });
});
