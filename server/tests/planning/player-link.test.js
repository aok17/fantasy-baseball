import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb } from '../../src/db.js';
import { createPlayerLinker, normalizeName, canonTeam } from '../../src/planning/player-link.js';

describe('normalizeName', () => {
  it('strips accents, punctuation and generational suffixes', () => {
    expect(normalizeName('José Ramírez')).toBe('jose ramirez');
    expect(normalizeName('Ronald Acuña Jr.')).toBe('ronald acuna');
    expect(normalizeName("Logan O'Hoppe")).toBe('logan ohoppe');
    expect(normalizeName('Michael Harris II')).toBe('michael harris');
  });

  it('keeps genuinely different names distinct', () => {
    expect(normalizeName('Luis L. Ortiz')).not.toBe(normalizeName('Luis Ortiz'));
  });

  it('is empty for missing input', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });
});

describe('canonTeam', () => {
  it('reconciles FanGraphs and StatsAPI abbreviations', () => {
    expect(canonTeam('CHW')).toBe(canonTeam('CWS'));
    expect(canonTeam('SFG')).toBe(canonTeam('SF'));
    expect(canonTeam('WSN')).toBe(canonTeam('WSH'));
    expect(canonTeam(null)).toBe(null);
  });
});

describe('createPlayerLinker', () => {
  let db;
  beforeEach(() => { db = createDb(':memory:'); });
  afterEach(() => db.close());

  const add = (name, team, mlbam = null) =>
    Number(db.prepare('INSERT INTO players (name, team, mlbam_id) VALUES (?, ?, ?)').run(name, team, mlbam).lastInsertRowid);

  it('returns the existing id for an already-mapped mlbam', () => {
    const id = add('Zack Wheeler', 'PHI', '554430');
    const linker = createPlayerLinker(db);
    expect(linker.ensure('554430', { name: 'Zack Wheeler' })).toBe(id);
    expect(linker.stats).toEqual({ adopted: 0, created: 0 });
  });

  it('adopts an unmapped row by normalized name, backfilling mlbam_id', () => {
    const id = add('José Ramírez', 'CLE');
    const linker = createPlayerLinker(db);
    expect(linker.ensure('608070', { name: 'Jose Ramirez', team: 'CLE' })).toBe(id);
    expect(linker.stats.adopted).toBe(1);
    expect(db.prepare('SELECT mlbam_id FROM players WHERE id = ?').get(id).mlbam_id).toBe('608070');
    expect(db.prepare('SELECT COUNT(*) c FROM players').get().c).toBe(1);
  });

  it('adopts across FanGraphs/StatsAPI team abbreviation differences', () => {
    const id = add('Garrett Crochet', 'CHW');
    const linker = createPlayerLinker(db);
    expect(linker.ensure('676979', { name: 'Garrett Crochet', team: 'CWS' })).toBe(id);
    expect(linker.stats.adopted).toBe(1);
  });

  it('refuses to adopt when the two sides claim different teams', () => {
    const id = add('John Smith', 'NYY');
    const linker = createPlayerLinker(db);
    const got = linker.ensure('999001', { name: 'John Smith', team: 'SEA' });
    expect(got).not.toBe(id);
    expect(linker.stats).toEqual({ adopted: 0, created: 1 });
    expect(db.prepare('SELECT mlbam_id FROM players WHERE id = ?').get(id).mlbam_id).toBe(null);
  });

  it('refuses to adopt an ambiguous name (two unmapped candidates)', () => {
    add('Luis Garcia', 'WSN');
    add('Luis Garcia', 'HOU');
    const linker = createPlayerLinker(db);
    linker.ensure('999002', { name: 'Luis Garcia', team: 'PHI' });
    expect(linker.stats).toEqual({ adopted: 0, created: 1 });
  });

  it('honours excludeIds so pitchers never hijack a known position player', () => {
    const id = add('Shohei Doppelganger', 'LAD');
    const linker = createPlayerLinker(db, { excludeIds: new Set([id]) });
    const got = linker.ensure('999003', { name: 'Shohei Doppelganger', team: 'LAD' });
    expect(got).not.toBe(id);
    expect(linker.stats.created).toBe(1);
  });

  it('creates a row from the StatsAPI identity when nothing matches', () => {
    const linker = createPlayerLinker(db);
    const id = linker.ensure('700001', { name: 'Rookie Callup', team: 'BAL' });
    const row = db.prepare('SELECT name, team, mlbam_id FROM players WHERE id = ?').get(id);
    expect(row).toEqual({ name: 'Rookie Callup', team: 'BAL', mlbam_id: '700001' });
    expect(linker.stats.created).toBe(1);
  });

  it('labels a nameless pitcher by mlbam id rather than dropping him', () => {
    const linker = createPlayerLinker(db);
    const id = linker.ensure('700002', {});
    expect(db.prepare('SELECT name FROM players WHERE id = ?').get(id).name).toBe('MLB 700002');
  });

  it('is idempotent within a run and caches the new id', () => {
    const linker = createPlayerLinker(db);
    const a = linker.ensure('700003', { name: 'Rookie Callup', team: 'BAL' });
    const b = linker.ensure('700003', { name: 'Rookie Callup', team: 'BAL' });
    expect(a).toBe(b);
    expect(linker.stats.created).toBe(1);
  });

  it('sidesteps a UNIQUE(name, team) collision with a row it must not touch', () => {
    // Same name+team as an unmapped row excludeIds forbids adopting. The insert
    // would collide, so fall back to a team-less row instead of hijacking.
    const id = add('Blocked Row', 'TEX');
    const linker = createPlayerLinker(db, { excludeIds: new Set([id]) });
    const got = linker.ensure('700004', { name: 'Blocked Row', team: 'TEX' });
    expect(got).not.toBe(id);
    expect(db.prepare('SELECT mlbam_id FROM players WHERE id = ?').get(id).mlbam_id).toBe(null);
    expect(db.prepare('SELECT team FROM players WHERE id = ?').get(got).team).toBe(null);
  });

  it('breaks an ambiguous name tie on an exact team match', () => {
    // Two unmapped "Luis Garcia" rows: the normalized-name index refuses, but an
    // exact name+team hit is a strong enough signal to claim.
    add('Luis Garcia', 'WSN');
    const hou = add('Luis Garcia', 'HOU');
    const linker = createPlayerLinker(db);
    expect(linker.ensure('700005', { name: 'Luis Garcia', team: 'HOU' })).toBe(hou);
    expect(linker.stats).toEqual({ adopted: 1, created: 0 });
  });

  it('never claims a row that already belongs to a different mlbam id', () => {
    const taken = add('Same Name', 'BOS', '111111');
    const linker = createPlayerLinker(db);
    const got = linker.ensure('222222', { name: 'Same Name', team: 'BOS' });
    expect(got).not.toBe(taken);
    expect(db.prepare('SELECT mlbam_id FROM players WHERE id = ?').get(taken).mlbam_id).toBe('111111');
  });
});
