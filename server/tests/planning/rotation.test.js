import { describe, it, expect } from 'vitest';
import { inferRotation, projectTeamRotation } from '../../src/planning/rotation.js';

// A 5-man staff, each having pitched once over the last 5 days.
const fiveMan = [
  { game_date: '2026-05-30', sp_mlbam: 'A' },
  { game_date: '2026-05-31', sp_mlbam: 'B' },
  { game_date: '2026-06-01', sp_mlbam: 'C' },
  { game_date: '2026-06-02', sp_mlbam: 'D' },
  { game_date: '2026-06-03', sp_mlbam: 'E' },
];

const dailyGames = (dates) => dates.map((d, i) => ({ game_pk: i + 1, game_date: d, announced_sp: null }));

describe('inferRotation', () => {
  it('infers a clean 5-man rotation, ordered most-due first', () => {
    const r = inferRotation(fiveMan);
    expect(r.size).toBe(5);
    expect(r.members.map(m => m.mlbam)).toEqual(['A', 'B', 'C', 'D', 'E']); // A pitched longest ago
  });

  it('infers a 6-man rotation when six regulars appear', () => {
    const sixMan = [...fiveMan, { game_date: '2026-06-04', sp_mlbam: 'F' }];
    expect(inferRotation(sixMan).size).toBe(6);
  });

  it('clamps to 6 even if more distinct starters appear', () => {
    const many = [...fiveMan,
      { game_date: '2026-06-04', sp_mlbam: 'F' },
      { game_date: '2026-06-05', sp_mlbam: 'G' },
    ];
    expect(inferRotation(many).size).toBe(6);
  });

  it('excludes openers from the rotation', () => {
    const withOpener = [...fiveMan, { game_date: '2026-06-04', sp_mlbam: 'OPENER' }];
    const r = inferRotation(withOpener, { openerIds: new Set(['OPENER']) });
    expect(r.members.map(m => m.mlbam)).not.toContain('OPENER');
  });

  it('excludes injured pitchers from the active cycle', () => {
    const r = inferRotation(fiveMan, { injured: new Set(['C']) });
    expect(r.members.map(m => m.mlbam)).not.toContain('C');
    expect(r.size).toBe(4);
  });

  // Regression: the real TEX/PIT bug. A team runs a clean 5-man turn, but a
  // single stale spot starter ('X') appears earlier in the window. Counting
  // distinct names would call this 6-man and erase two-start weeks. Cadence
  // detection stops at the first repeat (the 6th-most-recent start repeats a
  // current member), so 'X' never enters the rotation.
  it('reads 5-man cadence and ignores a stale spot starter in the window', () => {
    const starts = [
      { game_date: '2026-05-19', sp_mlbam: 'X' }, // 14 days stale: long reliever / demoted
      { game_date: '2026-05-28', sp_mlbam: 'E' },
      { game_date: '2026-05-29', sp_mlbam: 'A' },
      { game_date: '2026-05-30', sp_mlbam: 'B' },
      { game_date: '2026-05-31', sp_mlbam: 'C' },
      { game_date: '2026-06-01', sp_mlbam: 'D' },
      { game_date: '2026-06-02', sp_mlbam: 'E' }, // E repeats -> one full turn = 5
    ];
    const r = inferRotation(starts);
    expect(r.size).toBe(5);
    expect(r.members.map(m => m.mlbam).sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(r.members.map(m => m.mlbam)).not.toContain('X');
  });

  // The two-start week this restores: 5-man turn rolled over a 6-game week
  // (with a Monday off-day) gives the most-due starter a second turn.
  it('a true 5-man rotation yields one two-start pitcher across a 6-game week', () => {
    const starts = [
      { game_date: '2026-05-29', sp_mlbam: 'A' },
      { game_date: '2026-05-30', sp_mlbam: 'B' },
      { game_date: '2026-05-31', sp_mlbam: 'C' },
      { game_date: '2026-06-01', sp_mlbam: 'D' },
      { game_date: '2026-06-02', sp_mlbam: 'E' },
      { game_date: '2026-05-28', sp_mlbam: 'E' }, // repeat -> 5-man
      { game_date: '2026-05-23', sp_mlbam: 'X' }, // stale, ignored
    ];
    // 6-game week, Monday (06-08) off.
    const future = dailyGames(['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14']);
    const out = projectTeamRotation(starts, future);
    const counts = {};
    for (const o of out) counts[o.sp_mlbam] = (counts[o.sp_mlbam] || 0) + 1;
    const twoStart = Object.entries(counts).filter(([, c]) => c >= 2).map(([m]) => m);
    expect(twoStart).toHaveLength(1);
    expect(counts['X']).toBeUndefined();
  });

  // A genuine 6-man rotation (six distinct, no repeat within a turn) is still
  // recognized — we don't force 5-man.
  it('still recognizes a true 6-man rotation', () => {
    const sixMan = [...fiveMan, { game_date: '2026-06-04', sp_mlbam: 'F' }];
    expect(inferRotation(sixMan).size).toBe(6);
  });
});

describe('projectTeamRotation', () => {
  it('rolls a clean cycle forward in rotation order', () => {
    const future = dailyGames(['2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08']);
    const out = projectTeamRotation(fiveMan, future);
    expect(out.map(o => o.sp_mlbam)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(out.every(o => o.confidence === 'projected')).toBe(true);
  });

  it('an off-day does not break the cycle (queue continues)', () => {
    const future = dailyGames(['2026-06-04', '2026-06-06']); // skip 6-05
    const out = projectTeamRotation(fiveMan, future);
    expect(out.map(o => o.sp_mlbam)).toEqual(['A', 'B']);
  });

  it('announced probable overrides projection and re-syncs the cycle', () => {
    const future = [
      { game_pk: 1, game_date: '2026-06-04', announced_sp: 'C' }, // would have been A
      { game_pk: 2, game_date: '2026-06-05', announced_sp: null },
      { game_pk: 3, game_date: '2026-06-06', announced_sp: null },
    ];
    const out = projectTeamRotation(fiveMan, future);
    expect(out[0]).toMatchObject({ sp_mlbam: 'C', confidence: 'announced' });
    expect(out[1].sp_mlbam).toBe('A'); // A still most due after C pulled forward
    expect(out[2].sp_mlbam).toBe('B');
  });

  it('an announced opener does not advance the rotation turn', () => {
    const future = [
      { game_pk: 1, game_date: '2026-06-04', announced_sp: 'OPENER' },
      { game_pk: 2, game_date: '2026-06-05', announced_sp: null },
    ];
    const out = projectTeamRotation(fiveMan, future, { openerIds: new Set(['OPENER']) });
    expect(out[0]).toMatchObject({ sp_mlbam: 'OPENER', confidence: 'announced' });
    expect(out[1].sp_mlbam).toBe('A'); // bulk turn untouched -> A still due
  });

  it('ignores an announced pitcher who is on the IL and projects next-man-up', () => {
    const future = [{ game_pk: 1, game_date: '2026-06-04', announced_sp: 'C' }];
    const out = projectTeamRotation(fiveMan, future, { injured: new Set(['C']) });
    expect(out[0]).toMatchObject({ sp_mlbam: 'A', confidence: 'projected' });
  });

  it('assigns two different starters for a doubleheader', () => {
    const future = [
      { game_pk: 1, game_date: '2026-06-04', announced_sp: null },
      { game_pk: 2, game_date: '2026-06-04', announced_sp: null },
    ];
    const out = projectTeamRotation(fiveMan, future);
    expect(out[0].sp_mlbam).toBe('A');
    expect(out[1].sp_mlbam).toBe('B');
  });

  it('returns null starter for an unprojectable (whole staff injured) game', () => {
    const future = dailyGames(['2026-06-04']);
    const out = projectTeamRotation(fiveMan, future, { injured: new Set(['A', 'B', 'C', 'D', 'E']) });
    expect(out[0].sp_mlbam).toBeNull();
  });
});
