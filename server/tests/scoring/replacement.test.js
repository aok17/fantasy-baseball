import { describe, it, expect } from 'vitest';
import { computeReplacement, slotsFromEspn, batterReplacement, DEFAULT_SLOTS } from '../../src/scoring/replacement.js';

describe('slotsFromEspn', () => {
  it('maps real ESPN league 133164 lineupSlotCounts to position depth', () => {
    // From live mSettings: 10-team, OF=5, P=8, RP=1, UTIL=1
    const counts = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 5, 6: 1, 7: 1, 12: 1, 13: 8, 15: 1, 16: 4, 17: 2 };
    expect(slotsFromEspn(counts)).toEqual({ C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 5, DH: 1, SP: 8, RP: 1 });
  });

  it('treats missing slots as zero', () => {
    expect(slotsFromEspn({}).OF).toBe(0);
  });
});

describe('computeReplacement', () => {
  const pitchers = [
    { display_position: 'SP', scoring_position: 'SP', starting_pts: 300, relief_pts: 0 },
    { display_position: 'SP', scoring_position: 'SP', starting_pts: 200, relief_pts: 0 },
    { display_position: 'SP', scoring_position: 'SP', starting_pts: 100, relief_pts: 0 },
    { display_position: 'RP', scoring_position: 'CLOSER', starting_pts: 0, relief_pts: 150 },
    { display_position: 'RP', scoring_position: 'RP', starting_pts: 0, relief_pts: 80 },
  ];
  const batters = [
    { position: 'C', raw_score: 100 },
    { position: 'OF', raw_score: 200 },
    { position: 'OF', raw_score: 150 },
    { position: 'OF', raw_score: 90 },
  ];

  it('SP replacement = value at depth leagueSize*slots.SP', () => {
    // leagueSize 2 * SP 1 = rank 2 -> 2nd-best SP starting_pts = 200
    const r = computeReplacement(pitchers, batters, { leagueSize: 2, slots: { SP: 1, RP: 1, OF: 1, C: 1 } });
    expect(r.sp).toBe(200);
  });

  it('RP replacement drawn from relief pool (closers + relievers)', () => {
    // rank 2 -> 2nd-best relief_pts = 80
    const r = computeReplacement(pitchers, batters, { leagueSize: 2, slots: { SP: 1, RP: 1, OF: 1, C: 1 } });
    expect(r.rp).toBe(80);
  });

  it('positional replacement reflects depth: OF at rank 2 = 150', () => {
    const r = computeReplacement(pitchers, batters, { leagueSize: 2, slots: { SP: 1, RP: 1, OF: 1, C: 1 } });
    expect(r.byPos.OF).toBe(150);
  });

  it('thin pool (fewer players than rank) returns the last available value', () => {
    // Only 1 catcher, rank 2 -> falls back to the single available value
    const r = computeReplacement(pitchers, batters, { leagueSize: 2, slots: { SP: 1, RP: 1, OF: 1, C: 1 } });
    expect(r.byPos.C).toBe(100);
  });

  it('empty pools collapse to 0 (no baseline -> VOR == raw)', () => {
    const r = computeReplacement([], [], { leagueSize: 10, slots: DEFAULT_SLOTS });
    expect(r.sp).toBe(0);
    expect(r.rp).toBe(0);
    expect(r.byPos.OF).toBe(0);
  });
});

describe('batterReplacement', () => {
  const byPos = { C: 100, OF: 350, '1B': 300, DH: 120 };
  it('picks the lowest replacement among eligible positions', () => {
    expect(batterReplacement('OF, C', byPos)).toBe(100);
    expect(batterReplacement('1B, OF', byPos)).toBe(300);
  });
  it('falls back to DH for unknown position', () => {
    expect(batterReplacement('SP', byPos)).toBe(120);
  });
});
