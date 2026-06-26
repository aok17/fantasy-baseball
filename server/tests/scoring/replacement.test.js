import { describe, it, expect } from 'vitest';
import { computeReplacement, slotsFromEspn, batterReplacement, DEFAULT_SLOTS } from '../../src/scoring/replacement.js';

describe('slotsFromEspn', () => {
  it('maps real ESPN league 133164 lineupSlotCounts incl. MI/CI/UTIL', () => {
    // From live mSettings: 10-team, OF=5, MI=1, CI=1, UTIL=1, P=8, RP=1
    const counts = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 5, 6: 1, 7: 1, 12: 1, 13: 8, 15: 1, 16: 4, 17: 2 };
    expect(slotsFromEspn(counts)).toEqual({ C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 5, MI: 1, CI: 1, UTIL: 1, SP: 8, RP: 1 });
  });

  it('treats missing slots as zero', () => {
    expect(slotsFromEspn({})).toEqual({ C: 0, '1B': 0, '2B': 0, '3B': 0, SS: 0, OF: 0, MI: 0, CI: 0, UTIL: 0, SP: 0, RP: 0 });
  });
});

describe('computeReplacement — pitchers', () => {
  const pitchers = [
    { display_position: 'SP', scoring_position: 'SP', starting_pts: 300, relief_pts: 0 },
    { display_position: 'SP', scoring_position: 'SP', starting_pts: 200, relief_pts: 0 },
    { display_position: 'SP', scoring_position: 'SP', starting_pts: 100, relief_pts: 0 },
    { display_position: 'RP', scoring_position: 'CLOSER', starting_pts: 0, relief_pts: 150 },
    { display_position: 'RP', scoring_position: 'RP', starting_pts: 0, relief_pts: 80 },
  ];

  it('SP replacement = starting_pts at depth leagueSize*slots.SP', () => {
    const r = computeReplacement(pitchers, [], { leagueSize: 2, slots: { SP: 1, RP: 1 } });
    expect(r.sp).toBe(200); // rank 2 -> 2nd-best SP
  });

  it('RP replacement drawn from relief pool', () => {
    const r = computeReplacement(pitchers, [], { leagueSize: 2, slots: { SP: 1, RP: 1 } });
    expect(r.rp).toBe(80); // rank 2 -> 2nd-best reliever
  });
});

describe('computeReplacement — batter roster fill', () => {
  it('MI slot absorbs the 3rd-best middle infielder (flex counted)', () => {
    const batters = [
      { position: '2B, SS', raw_score: 300 }, // -> SS
      { position: '2B', raw_score: 250 },     // -> 2B
      { position: 'SS', raw_score: 240 },     // -> MI (SS/2B full)
      { position: 'C', raw_score: 200 },      // -> C
      { position: '2B, SS', raw_score: 100 }, // -> free agent
    ];
    const r = computeReplacement([], batters, { leagueSize: 1, slots: { C: 1, '2B': 1, SS: 1, MI: 1 } });
    // only the 100 bat is unrostered; it sets 2B and SS replacement
    expect(r.byPos['2B']).toBe(100);
    expect(r.byPos.SS).toBe(100);
    expect(r.byPos.C).toBe(0); // no free-agent catcher
  });

  it('does not double-count a multi-position player across pools', () => {
    // One 2B/SS stud + one each pure 2B and pure SS. Slots: 2B1, SS1 (no MI).
    const batters = [
      { position: '2B, SS', raw_score: 300 }, // -> SS
      { position: '2B', raw_score: 250 },     // -> 2B
      { position: 'SS', raw_score: 240 },     // -> free agent (SS full)
    ];
    const r = computeReplacement([], batters, { leagueSize: 1, slots: { '2B': 1, SS: 1 } });
    // The 240 SS is the only free agent; 2B has no eligible FA, SS replacement = 240.
    expect(r.byPos.SS).toBe(240);
    expect(r.byPos['2B']).toBe(0);
  });

  it('DH/UTIL bar = best free agent overall (highest bar)', () => {
    const batters = [
      { position: 'OF', raw_score: 500 }, // -> OF
      { position: 'C', raw_score: 300 },  // -> free agent (no C slot)
      { position: 'OF', raw_score: 200 }, // -> free agent (OF full)
    ];
    const r = computeReplacement([], batters, { leagueSize: 1, slots: { OF: 1 } });
    expect(r.byPos.DH).toBe(300); // best unrostered overall
    expect(r.byPos.OF).toBe(200); // best unrostered OF
  });

  it('empty pools collapse to 0 (VOR == raw)', () => {
    const r = computeReplacement([], [], { leagueSize: 10, slots: DEFAULT_SLOTS });
    expect(r.sp).toBe(0);
    expect(r.rp).toBe(0);
    expect(r.byPos.OF).toBe(0);
    expect(r.byPos.DH).toBe(0);
  });
});

describe('batterReplacement', () => {
  const byPos = { C: 100, OF: 350, '1B': 300, '2B': 180, SS: 190, '3B': 200, DH: 400 };
  it('picks the lowest replacement among eligible positions', () => {
    expect(batterReplacement('OF, C', byPos)).toBe(100);
    expect(batterReplacement('1B, OF', byPos)).toBe(300);
    expect(batterReplacement('2B, SS', byPos)).toBe(180);
  });
  it('pure-DH player uses the (high) UTIL bar', () => {
    expect(batterReplacement('DH', byPos)).toBe(400);
  });
});
