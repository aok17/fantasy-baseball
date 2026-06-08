// =============================================================================
// PITCHER MODEL — PARAMETER PROVENANCE
// =============================================================================
//
// FITTED FROM DATA (recomputed each run from pitcher_starts):
//   - K% coefficients (a, b, c in xK% = a * SwStr% + b * CStr% + c) — OLS on all starts
//   - BB% coefficients (a, b in xBB% = a * ball_pct + b) — OLS on all starts
//   - League-wide IP std dev — std dev of IP across all starts
//   - League-wide ER std dev — std dev of ER across all starts
//
//   The K% model was previously hardcoded from FanGraphs multivariate research
//   (xK% = 1.2*SwStr% + 0.6*CStr% - 4.0, Alex Chamberlain). Those coefficients
//   under-predicted K% on this data source across the board — worst for high-whiff
//   arms — so K% is now fit per run like BB%. The published coefficients remain the
//   fallback when there are too few starts to fit.
//
// FROM PUBLISHED RESEARCH:
//   - BABIP regression k=3700
//     Source: Tom Tango, "Inside The Book" / tangotiger.com
//   - HR/FB regression k=170
//     Source: Tom Tango stabilization research (r=0.50 at 170 FB)
//   - FIP coefficients: 13 (HR), 3 (BB), -2 (K) — fixed linear run weights
//     Source: FanGraphs library, validated independently
//   - Pythagorean win%: W% = R²/(R² + RA²)
//     Source: Bill James, standard sabermetric formula
//
// FROM app_config (adjustable):
//   - lg_babip (0.300) — FanGraphs league average
//   - lg_hr_fb (0.095) — FanGraphs league average
//   - lg_runs_per_game (4.5) — FanGraphs league average
//   - fip_constant (3.15) — FanGraphs Guts! table, varies by year
//
// ESTIMATED / APPROXIMATE:
//   - BIP out rate = 1 - regressed_BABIP
//     Approximate: ignores errors, fielder's choices, sac flies.
//     Real out rate on BIP is slightly lower (~0.68 vs 0.70).
//   - FB% ≈ 35% of BIP (used for HR/FB regression denominator)
//     Approximate: league average is ~34-36%, varies by pitcher.
//   - Win prob decision rate heuristic:
//     min((wins + (starts-wins)*0.4) / starts, 0.75)
//     Made up. ~60% of starts result in a decision is roughly right.
//   - QS model P(ER<=3) uses 3.5 as threshold (not 3)
//     Intentional: accounts for discrete ER values (3 ER = QS, 3.5 midpoint)
// =============================================================================

import { safeDivide } from './utils.js';

function getConfig(db, key, fallback) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? Number(row.value) : fallback;
}

function getWeights(db) {
  const rows = db.prepare("SELECT stat, weight FROM scoring_config WHERE category = 'pitcher'").all();
  const w = {};
  for (const r of rows) w[r.stat] = r.weight;
  return w;
}

function getRecentStarts(db, playerId, n) {
  return db.prepare(`
    SELECT * FROM pitcher_starts
    WHERE player_id = ? AND ip IS NOT NULL
    ORDER BY game_date DESC LIMIT ?
  `).all(playerId, n);
}

function rollingAvg(starts, field) {
  const vals = starts.map(s => s[field]).filter(v => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function rollingSum(starts, field) {
  return starts.reduce((sum, s) => sum + (s[field] || 0), 0);
}

// Sub-model 1: Strikeout rate
// xK% = a * SwStr% + b * CStr% + c, coefficients fit from all starts via OLS
function estimateKPct(starts, kCoeffs) {
  const totalPitches = rollingSum(starts, 'total_pitches');
  const whiffs = rollingSum(starts, 'whiffs');
  const calledStrikes = rollingSum(starts, 'called_strikes');
  if (totalPitches === 0) return null;

  const swstrPct = (whiffs / totalPitches) * 100;
  const cstrPct = (calledStrikes / totalPitches) * 100;
  const xk = kCoeffs.a * swstrPct + kCoeffs.b * cstrPct + kCoeffs.c;
  return Math.max(0, Math.min(xk / 100, 0.60));
}

// Fit OLS: k_pct = a * swstr_pct + b * cstr_pct + c from all starts.
// Mirrors fitBBCoefficients but with two predictors. The previously hardcoded
// "published research" coefficients (1.2, 0.6, -4.0) under-predicted K% league-wide
// on this data source — worst for high-whiff arms (Skenes came out ~9 K% too low) —
// because the fitted slope/intercept differ from the source population. Fitting per
// run removes that bias. Falls back to the published coefficients on too few starts.
export function fitKCoefficients(db) {
  const rows = db.prepare(`
    SELECT total_pitches, whiffs, called_strikes, so, pa
    FROM pitcher_starts
    WHERE total_pitches > 0 AND pa > 0 AND whiffs IS NOT NULL AND called_strikes IS NOT NULL
  `).all();

  const fallback = { a: 1.2, b: 0.6, c: -4.0 };
  if (rows.length < 10) return fallback;

  // Normal equations for y = a*x1 + b*x2 + c over features [x1=SwStr%, x2=CStr%, 1].
  let s11 = 0, s12 = 0, s1 = 0, s22 = 0, s2 = 0, n = 0, s1y = 0, s2y = 0, sy = 0;
  for (const r of rows) {
    const x1 = (r.whiffs / r.total_pitches) * 100;
    const x2 = (r.called_strikes / r.total_pitches) * 100;
    const y = (r.so / r.pa) * 100;
    s11 += x1 * x1; s12 += x1 * x2; s1 += x1;
    s22 += x2 * x2; s2 += x2;
    s1y += x1 * y; s2y += x2 * y; sy += y;
    n++;
  }

  const sol = solve3(
    [[s11, s12, s1], [s12, s22, s2], [s1, s2, n]],
    [s1y, s2y, sy]
  );
  if (!sol) return fallback;

  const [a, b, c] = sol;
  console.log(`K% model fit: xK% = ${a.toFixed(4)} * SwStr% + ${b.toFixed(4)} * CStr% + ${c.toFixed(4)} (n=${n})`);
  return { a, b, c };
}

// Gaussian elimination with partial pivoting for a 3x3 system. Returns null if singular.
function solve3(M, rhs) {
  const A = M.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k < 4; k++) A[r][k] -= f * A[col][k];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

// Sub-model 2: Walk rate (aggressive)
// xBB% = a * ball_pct + b, coefficients fit from all starts via OLS
function estimateBBPct(starts, bbCoeffs) {
  const totalPitches = rollingSum(starts, 'total_pitches');
  const takes = rollingSum(starts, 'takes');
  const calledStrikes = rollingSum(starts, 'called_strikes');
  if (totalPitches === 0) return null;

  const ballPct = (takes - calledStrikes) / totalPitches;
  const xbb = bbCoeffs.a * ballPct + bbCoeffs.b;
  return Math.max(0.01, Math.min(xbb, 0.25));
}

// Fit OLS: bb_pct = a * ball_pct + b from all starts
function fitBBCoefficients(db) {
  const rows = db.prepare(`
    SELECT total_pitches, takes, called_strikes, bb, pa
    FROM pitcher_starts
    WHERE total_pitches > 0 AND pa > 0 AND takes IS NOT NULL AND called_strikes IS NOT NULL
  `).all();

  if (rows.length < 10) return { a: 0.5, b: -0.10 }; // fallback

  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0, n = 0;
  for (const r of rows) {
    const ballPct = (r.takes - r.called_strikes) / r.total_pitches;
    const bbPct = r.bb / r.pa;
    sumX += ballPct;
    sumY += bbPct;
    sumXX += ballPct * ballPct;
    sumXY += ballPct * bbPct;
    n++;
  }

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { a: 0.5, b: -0.10 };

  const a = (n * sumXY - sumX * sumY) / denom;
  const b = (sumY - a * sumX) / n;

  console.log(`BB% model fit: xBB% = ${a.toFixed(4)} * ball_pct + ${b.toFixed(4)} (n=${n})`);
  return { a, b };
}

// Sub-model 3: BABIP (conservative, heavy regression)
function regressedBABIP(starts, lgBabip) {
  const bip = rollingSum(starts, 'bip');
  const hits = rollingSum(starts, 'hits');
  const hrs = rollingSum(starts, 'hrs');
  if (bip === 0) return lgBabip;

  const hitsOnBip = hits - hrs;
  const observedBabip = safeDivide(hitsOnBip, bip);
  const k = 3700;
  return (bip * observedBabip + k * lgBabip) / (bip + k);
}

// Sub-model 3b: HR rate (conservative, heavy regression)
function regressedHR9(starts, lgHrFb) {
  const bip = rollingSum(starts, 'bip');
  const hrs = rollingSum(starts, 'hrs');
  if (bip === 0) return lgHrFb;

  const fb = bip * 0.35;
  const observedHrFb = safeDivide(hrs, fb);
  const k = 170;
  const regHrFb = (fb * observedHrFb + k * lgHrFb) / (fb + k);

  const ip = rollingSum(starts, 'ip');
  if (ip === 0) return regHrFb * 0.35 * 3 * 9;
  const bipPer9 = bip * 9 / ip;
  return regHrFb * 0.35 * bipPer9;
}

// Sub-model 4: IP/start (from rolling PA and estimated out rate)
// Uses actual BIP-to-out rate computed from the pitcher's own data in the window,
// combined with estimated K% and BB% to project outs per batter faced.
function estimateIP(starts, estKPct, estBBPct, regBabip) {
  const avgPA = rollingAvg(starts, 'pa');
  if (!avgPA || estKPct == null || estBBPct == null) return rollingAvg(starts, 'ip');

  const bipPct = 1 - estKPct - estBBPct;
  // Out rate on BIP = 1 - BABIP (approximately — ignores errors/FC but those are small)
  const bipOutRate = 1 - (regBabip || 0.300);
  const outsPerBatter = estKPct * 1.0 + bipPct * bipOutRate;
  const totalOuts = avgPA * outsPerBatter;
  return totalOuts / 3;
}

// Sub-model 5: ERA via FIP
function estimateERA(estK, estBB, estHR, estIP, fipConstant) {
  if (!estIP || estIP === 0) return null;
  return safeDivide((13 * estHR) + (3 * estBB) - (2 * estK), estIP) + fipConstant;
}

// Sub-model 6: Win probability via Pythagorean expectation
// P(W) is gated by P(IP >= 5) (SP win eligibility rule) so it stays consistent
// with the QS model — both respond to the same IP/ERA skill signals rather than
// to small-sample recent W/L noise.
function estimateWinProb(estIP, estERA, lgRunsPerGame) {
  if (estERA == null || estIP == null) return { pWin: null, pLoss: null };

  const lgR = lgRunsPerGame;
  const pythWinPct = safeDivide(lgR * lgR, lgR * lgR + estERA * estERA);

  const ipSd = estimateQSProb._ipSd || 1.2;
  const pIP5 = 1 - normCdf((5 - estIP) / ipSd);
  const decisionRate = 0.55 + 0.20 * pIP5;

  return {
    pWin: pIP5 * pythWinPct,
    pLoss: decisionRate * (1 - pythWinPct),
  };
}

// Normal CDF approximation (Abramowitz & Stegun)
function normCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// Sub-model 7: QS probability from model estimates + league-wide variance
// P(QS) = P(IP >= 6) * P(ER <= 3 | IP >= 6)
// Uses normal distribution centered on model estimates with variance computed
// from ALL starts in the database (stable, not noisy per-pitcher small samples).
function estimateQSProb(starts, estIP, estERA) {
  if (estIP == null || estERA == null) return null;
  if (starts.length === 0) return null;

  // ipSd and erSd are set once from league-wide data (see computePitcherModel)
  // and passed via closure. Fall back to reasonable defaults.
  const ipSd = estimateQSProb._ipSd || 1.2;
  const erSd = estimateQSProb._erSd || 1.5;

  // P(IP >= 6)
  const pIP6 = 1 - normCdf((6 - estIP) / ipSd);

  // Expected ER in a 6+ IP start
  const estERin6 = estERA * 6 / 9;
  const pER3 = normCdf((3.5 - estERin6) / erSd);

  return pIP6 * pER3;
}

function computeForWindow(db, playerId, windowSize, config, weights, bbCoeffs, kCoeffs) {
  const starts = getRecentStarts(db, playerId, windowSize);
  if (starts.length === 0) return null;

  const xkPct = estimateKPct(starts, kCoeffs);
  const xbbPct = estimateBBPct(starts, bbCoeffs);
  const regBabip = regressedBABIP(starts, config.lgBabip);
  const regHr9 = regressedHR9(starts, config.lgHrFb);
  const estIP = estimateIP(starts, xkPct, xbbPct, regBabip);
  const estPA = rollingAvg(starts, 'pa') || 25;

  const estK = (xkPct || 0.20) * estPA;
  const estBB = (xbbPct || 0.077) * estPA;
  const estBIP = estPA - estK - estBB;
  const estHR = (regHr9 || 1.2) * (estIP || 6) / 9;
  const estH = regBabip * Math.max(estBIP, 0) + estHR;

  const estERA = estimateERA(estK, estBB, estHR, estIP, config.fipConstant);
  const estER = estERA != null ? estERA * (estIP || 6) / 9 : null;

  const { pWin, pLoss } = estimateWinProb(estIP, estERA, config.lgRunsPerGame);
  const pQS = estimateQSProb(starts, estIP, estERA);

  let pts = 0;
  if (estIP != null) pts += estIP * (weights.IP || 0);
  pts += estK * (weights.SO || 0);
  pts += estBB * (weights.BB || 0);
  pts += estH * (weights.H || 0);
  if (estER != null) pts += estER * (weights.ER || 0);
  if (pWin != null) pts += pWin * (weights.W || 0);
  if (pLoss != null) pts += pLoss * (weights.L || 0);
  if (pQS != null) pts += pQS * (weights.QS || 0);

  return {
    player_id: playerId,
    window: windowSize,
    starts_in_window: starts.length,
    xk_pct: xkPct,
    xbb_pct: xbbPct,
    regressed_babip: regBabip,
    regressed_hr9: regHr9,
    est_ip: estIP,
    est_era: estERA,
    est_k_per_start: estK,
    est_bb_per_start: estBB,
    est_h_per_start: estH,
    est_er_per_start: estER,
    p_win: pWin,
    p_loss: pLoss,
    p_qs: pQS,
    pts_per_start: pts,
  };
}

export function computePitcherModel(db) {
  const config = {
    lgBabip: getConfig(db, 'lg_babip', 0.300),
    lgHrFb: getConfig(db, 'lg_hr_fb', 0.095),
    lgRunsPerGame: getConfig(db, 'lg_runs_per_game', 4.5),
    fipConstant: getConfig(db, 'fip_constant', 3.15),
  };
  const weights = getWeights(db);

  // Compute league-wide IP and ER standard deviations from all starts
  const allStarts = db.prepare('SELECT ip, er FROM pitcher_starts WHERE ip IS NOT NULL AND er IS NOT NULL').all();
  if (allStarts.length >= 2) {
    const ipMean = allStarts.reduce((s, r) => s + r.ip, 0) / allStarts.length;
    const ipVar = allStarts.reduce((s, r) => s + (r.ip - ipMean) ** 2, 0) / (allStarts.length - 1);
    estimateQSProb._ipSd = Math.max(Math.sqrt(ipVar), 0.5);

    const erMean = allStarts.reduce((s, r) => s + r.er, 0) / allStarts.length;
    const erVar = allStarts.reduce((s, r) => s + (r.er - erMean) ** 2, 0) / (allStarts.length - 1);
    estimateQSProb._erSd = Math.max(Math.sqrt(erVar), 0.5);
  }

  // Fit BB% and K% regressions from all starts
  const bbCoeffs = fitBBCoefficients(db);
  const kCoeffs = fitKCoefficients(db);

  const pitchers = db.prepare(`
    SELECT DISTINCT player_id FROM pitcher_starts WHERE player_id IS NOT NULL AND ip IS NOT NULL
  `).all();

  const upsert = db.prepare(`
    INSERT INTO pitcher_model
      (player_id, window, starts_in_window, xk_pct, xbb_pct,
       regressed_babip, regressed_hr9, est_ip, est_era,
       est_k_per_start, est_bb_per_start, est_h_per_start, est_er_per_start,
       p_win, p_loss, p_qs, pts_per_start)
    VALUES (@player_id, @window, @starts_in_window, @xk_pct, @xbb_pct,
       @regressed_babip, @regressed_hr9, @est_ip, @est_era,
       @est_k_per_start, @est_bb_per_start, @est_h_per_start, @est_er_per_start,
       @p_win, @p_loss, @p_qs, @pts_per_start)
    ON CONFLICT(player_id, window) DO UPDATE SET
       starts_in_window=excluded.starts_in_window, xk_pct=excluded.xk_pct,
       xbb_pct=excluded.xbb_pct, regressed_babip=excluded.regressed_babip,
       regressed_hr9=excluded.regressed_hr9, est_ip=excluded.est_ip,
       est_era=excluded.est_era, est_k_per_start=excluded.est_k_per_start,
       est_bb_per_start=excluded.est_bb_per_start, est_h_per_start=excluded.est_h_per_start,
       est_er_per_start=excluded.est_er_per_start, p_win=excluded.p_win,
       p_loss=excluded.p_loss, p_qs=excluded.p_qs, pts_per_start=excluded.pts_per_start
  `);

  let count = 0;
  db.transaction(() => {
    for (const { player_id } of pitchers) {
      for (const w of [3, 10, 30]) {
        const result = computeForWindow(db, player_id, w, config, weights, bbCoeffs, kCoeffs);
        if (result) {
          upsert.run(result);
          count++;
        }
      }
    }
  })();

  return { models: count, pitchers: pitchers.length };
}
