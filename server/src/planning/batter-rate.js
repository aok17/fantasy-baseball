// Recency-weighted batter start-rate model with platoon splits + shrinkage.
// Pure functions: game history in, rates out. No DB, no network.

import { parseDate } from './weeks.js';

function ageDays(asOfDate, gameDate) {
  return (parseDate(asOfDate).getTime() - parseDate(gameDate).getTime()) / 86400000;
}

// Exponential recency weighting. Older games count less; half-life in days.
// games: [{ game_date, started (1/0), opp_sp_hand: 'L'|'R'|null }]
// Returns overall + per-hand rates and the *effective* (weighted) sample sizes.
export function recencyWeightedRate(games, halfLife = 21, asOfDate) {
  let wSum = 0, wStarted = 0;
  let wL = 0, wStartedL = 0;
  let wR = 0, wStartedR = 0;

  for (const g of games) {
    const age = ageDays(asOfDate, g.game_date);
    if (age < 0) continue; // ignore future-dated rows
    const w = Math.exp(-age / halfLife);
    wSum += w;
    wStarted += w * g.started;
    if (g.opp_sp_hand === 'L') { wL += w; wStartedL += w * g.started; }
    else if (g.opp_sp_hand === 'R') { wR += w; wStartedR += w * g.started; }
  }

  const start_rate = wSum > 0 ? wStarted / wSum : null;
  return {
    start_rate,
    vs_lhp_rate_raw: wL > 0 ? wStartedL / wL : null,
    vs_rhp_rate_raw: wR > 0 ? wStartedR / wR : null,
    eff_n: wSum,
    eff_n_lhp: wL,
    eff_n_rhp: wR,
  };
}

// Regress a thin hand-split toward the overall rate by effective sample size.
// k = pseudo-count (how many weighted games of "prior" to mix in).
// handEffN=0 -> returns overallRate exactly; large handEffN -> returns handRate.
export function shrinkHandSplit(handRateRaw, handEffN, overallRate, k = 10) {
  if (overallRate == null) return null;
  if (handRateRaw == null || handEffN <= 0) return overallRate;
  return (handEffN * handRateRaw + k * overallRate) / (handEffN + k);
}

// Build the final rate bundle a batter uses for projection.
export function batterRates(games, { halfLife = 21, asOfDate, shrinkK = 10 } = {}) {
  const r = recencyWeightedRate(games, halfLife, asOfDate);
  return {
    start_rate: r.start_rate,
    vs_lhp_rate: shrinkHandSplit(r.vs_lhp_rate_raw, r.eff_n_lhp, r.start_rate, shrinkK),
    vs_rhp_rate: shrinkHandSplit(r.vs_rhp_rate_raw, r.eff_n_rhp, r.start_rate, shrinkK),
    eff_n: r.eff_n,
  };
}

// Expected games started in a week = Σ over the week's games of P(start | opposing-SP hand).
// weekGames: [{ opp_sp_hand: 'L'|'R'|null }]. Injured -> 0. Missing hand -> overall rate.
export function expGamesForBatter(weekGames, rates, isInjured = false) {
  if (isInjured || rates.start_rate == null) return 0;
  let sum = 0;
  for (const g of weekGames) {
    if (g.opp_sp_hand === 'L' && rates.vs_lhp_rate != null) sum += rates.vs_lhp_rate;
    else if (g.opp_sp_hand === 'R' && rates.vs_rhp_rate != null) sum += rates.vs_rhp_rate;
    else sum += rates.start_rate;
  }
  return sum;
}
