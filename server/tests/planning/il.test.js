import { describe, it, expect } from 'vitest';
import { buildIlIntervals, isOnIl } from '../../src/planning/il.js';

describe('buildIlIntervals', () => {
  it('pairs a placement with its activation (end exclusive)', () => {
    const ivs = buildIlIntervals([
      { mlbam: '1', date: '2026-05-01', description: 'Team placed CF Joe on the 10-day injured list.' },
      { mlbam: '1', date: '2026-05-15', description: 'Team activated CF Joe from the 10-day injured list.' },
    ]);
    expect(ivs.get('1')).toEqual([{ start: '2026-05-01', end: '2026-05-15' }]);
  });

  it('parses a retroactive start date', () => {
    const ivs = buildIlIntervals([
      { mlbam: '1', date: '2026-05-05', description: 'Team placed CF Joe on the 10-day injured list, retroactive to May 1.' },
      { mlbam: '1', date: '2026-05-20', description: 'Team activated CF Joe from the 10-day injured list.' },
    ]);
    expect(ivs.get('1')).toEqual([{ start: '2026-05-01', end: '2026-05-20' }]);
  });

  it('leaves an open-ended stint (no activation) with end null', () => {
    const ivs = buildIlIntervals([
      { mlbam: '1', date: '2026-05-01', description: 'Team placed CF Joe on the 10-day injured list.' },
    ]);
    expect(ivs.get('1')).toEqual([{ start: '2026-05-01', end: null }]);
  });

  it('tracks multiple separate stints for one player', () => {
    const ivs = buildIlIntervals([
      { mlbam: '1', date: '2026-04-01', description: 'placed on the 10-day injured list' },
      { mlbam: '1', date: '2026-04-15', description: 'activated from the 10-day injured list' },
      { mlbam: '1', date: '2026-06-01', description: 'placed on the 15-day injured list' },
      { mlbam: '1', date: '2026-06-20', description: 'reinstated from the 15-day injured list' },
    ]);
    expect(ivs.get('1')).toEqual([
      { start: '2026-04-01', end: '2026-04-15' },
      { start: '2026-06-01', end: '2026-06-20' },
    ]);
  });

  it('ignores a re-placement (10-day -> 60-day transfer) while already on the IL', () => {
    const ivs = buildIlIntervals([
      { mlbam: '1', date: '2026-05-01', description: 'placed on the 10-day injured list' },
      { mlbam: '1', date: '2026-05-10', description: 'transferred to the 60-day injured list' }, // not a new placement match anyway
      { mlbam: '1', date: '2026-05-12', description: 'placed on the 60-day injured list' },      // re-placement: ignored
      { mlbam: '1', date: '2026-07-01', description: 'activated from the 60-day injured list' },
    ]);
    // Single stint anchored at the first placement.
    expect(ivs.get('1')).toEqual([{ start: '2026-05-01', end: '2026-07-01' }]);
  });

  it('handles events arriving out of order', () => {
    const ivs = buildIlIntervals([
      { mlbam: '1', date: '2026-05-15', description: 'activated from the 10-day injured list' },
      { mlbam: '1', date: '2026-05-01', description: 'placed on the 10-day injured list' },
    ]);
    expect(ivs.get('1')).toEqual([{ start: '2026-05-01', end: '2026-05-15' }]);
  });
});

describe('isOnIl', () => {
  const ivs = buildIlIntervals([
    { mlbam: '1', date: '2026-05-01', description: 'placed on the 10-day injured list' },
    { mlbam: '1', date: '2026-05-15', description: 'activated from the 10-day injured list' },
  ]);

  it('is true on the placement date', () => {
    expect(isOnIl(ivs, '1', '2026-05-01')).toBe(true);
  });
  it('is true mid-stint', () => {
    expect(isOnIl(ivs, '1', '2026-05-10')).toBe(true);
  });
  it('is false on the activation date (end exclusive — available to start)', () => {
    expect(isOnIl(ivs, '1', '2026-05-15')).toBe(false);
  });
  it('is false before the stint', () => {
    expect(isOnIl(ivs, '1', '2026-04-30')).toBe(false);
  });
  it('is false for an unknown player', () => {
    expect(isOnIl(ivs, '999', '2026-05-10')).toBe(false);
  });
  it('accepts numeric mlbam (coerced to string)', () => {
    expect(isOnIl(ivs, 1, '2026-05-10')).toBe(true);
  });
});
