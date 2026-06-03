import { describe, it, expect } from 'vitest';
import {
  recencyWeightedRate, shrinkHandSplit, batterRates, expGamesForBatter,
} from '../../src/planning/batter-rate.js';

const asOf = '2026-06-03';

describe('recencyWeightedRate', () => {
  it('all-started yields rate 1, all-benched yields 0', () => {
    const started = [{ game_date: '2026-06-01', started: 1, opp_sp_hand: 'R' }];
    const benched = [{ game_date: '2026-06-01', started: 0, opp_sp_hand: 'R' }];
    expect(recencyWeightedRate(started, 21, asOf).start_rate).toBeCloseTo(1, 6);
    expect(recencyWeightedRate(benched, 21, asOf).start_rate).toBeCloseTo(0, 6);
  });

  it('empty history yields null rate', () => {
    expect(recencyWeightedRate([], 21, asOf).start_rate).toBeNull();
  });

  it('recent games dominate older ones (role change shows up fast)', () => {
    // Benched long ago, started recently -> rate should lean high.
    const games = [
      { game_date: '2026-03-01', started: 0, opp_sp_hand: 'R' }, // ~94 days old
      { game_date: '2026-06-01', started: 1, opp_sp_hand: 'R' }, // 2 days old
    ];
    const r = recencyWeightedRate(games, 21, asOf);
    expect(r.start_rate).toBeGreaterThan(0.9);
  });

  it('splits effective sample size by opposing hand', () => {
    const games = [
      { game_date: '2026-06-01', started: 1, opp_sp_hand: 'L' },
      { game_date: '2026-06-02', started: 0, opp_sp_hand: 'R' },
    ];
    const r = recencyWeightedRate(games, 21, asOf);
    expect(r.eff_n_lhp).toBeGreaterThan(0);
    expect(r.eff_n_rhp).toBeGreaterThan(0);
    expect(r.vs_lhp_rate_raw).toBeCloseTo(1, 6);
    expect(r.vs_rhp_rate_raw).toBeCloseTo(0, 6);
  });

  it('ignores future-dated rows', () => {
    const r = recencyWeightedRate([{ game_date: '2026-12-01', started: 1, opp_sp_hand: 'R' }], 21, asOf);
    expect(r.start_rate).toBeNull();
  });
});

describe('shrinkHandSplit', () => {
  it('zero same-hand sample returns the overall rate exactly', () => {
    expect(shrinkHandSplit(null, 0, 0.7)).toBe(0.7);
  });

  it('large same-hand sample returns ~raw split', () => {
    expect(shrinkHandSplit(0.2, 1000, 0.7, 10)).toBeCloseTo(0.2, 2);
  });

  it('midpoint blends raw and overall by effective N', () => {
    // handEffN == k -> exactly halfway
    expect(shrinkHandSplit(0.2, 10, 0.8, 10)).toBeCloseTo(0.5, 6);
  });

  it('null overall rate returns null', () => {
    expect(shrinkHandSplit(0.2, 5, null)).toBeNull();
  });
});

describe('batterRates', () => {
  it('shrinks a thin platoon split toward overall instead of reading 0/100%', () => {
    // Many vs-RHP games started; a single vs-LHP benched game.
    const games = [
      { game_date: '2026-05-20', started: 1, opp_sp_hand: 'R' },
      { game_date: '2026-05-22', started: 1, opp_sp_hand: 'R' },
      { game_date: '2026-05-25', started: 1, opp_sp_hand: 'R' },
      { game_date: '2026-05-28', started: 1, opp_sp_hand: 'R' },
      { game_date: '2026-05-30', started: 0, opp_sp_hand: 'L' }, // lone LHP game
    ];
    const r = batterRates(games, { halfLife: 21, asOfDate: asOf, shrinkK: 10 });
    expect(r.start_rate).toBeGreaterThan(0.7);
    // Not pinned to 0 despite the single benched LHP game:
    expect(r.vs_lhp_rate).toBeGreaterThan(0.5);
  });
});

describe('expGamesForBatter', () => {
  const rates = { start_rate: 0.8, vs_lhp_rate: 0.3, vs_rhp_rate: 0.9 };

  it('sums P(start) by opposing hand across the week', () => {
    const week = [{ opp_sp_hand: 'R' }, { opp_sp_hand: 'R' }, { opp_sp_hand: 'L' }];
    expect(expGamesForBatter(week, rates)).toBeCloseTo(0.9 + 0.9 + 0.3, 6);
  });

  it('uses overall rate when opposing hand unknown', () => {
    expect(expGamesForBatter([{ opp_sp_hand: null }], rates)).toBeCloseTo(0.8, 6);
  });

  it('injured batter projects zero', () => {
    expect(expGamesForBatter([{ opp_sp_hand: 'R' }], rates, true)).toBe(0);
  });

  it('null start_rate (no data) projects zero', () => {
    expect(expGamesForBatter([{ opp_sp_hand: 'R' }], { start_rate: null })).toBe(0);
  });
});
