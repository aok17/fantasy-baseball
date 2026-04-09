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

// Sub-model 1: Strikeout rate (aggressive)
// xK% = 1.2 * SwStr% + 0.6 * CStr% - 4.0
function estimateKPct(starts) {
  const totalPitches = rollingSum(starts, 'total_pitches');
  const whiffs = rollingSum(starts, 'whiffs');
  const calledStrikes = rollingSum(starts, 'called_strikes');
  if (totalPitches === 0) return null;

  const swstrPct = (whiffs / totalPitches) * 100;
  const cstrPct = (calledStrikes / totalPitches) * 100;
  const xk = 1.2 * swstrPct + 0.6 * cstrPct - 4.0;
  return Math.max(0, Math.min(xk / 100, 0.60));
}

// Sub-model 2: Walk rate (aggressive)
// xBB% from ball rate: xBB% = 0.8 * ball_pct - 0.15
function estimateBBPct(starts) {
  const totalPitches = rollingSum(starts, 'total_pitches');
  const takes = rollingSum(starts, 'takes');
  const calledStrikes = rollingSum(starts, 'called_strikes');
  if (totalPitches === 0) return null;

  const ballPct = (takes - calledStrikes) / totalPitches;
  const xbb = 0.8 * ballPct - 0.15;
  return Math.max(0.01, Math.min(xbb, 0.25));
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

// Sub-model 4: IP/start (derived from K%, BB%, pitches/start)
function estimateIP(starts, estKPct, estBBPct) {
  const avgPitches = rollingAvg(starts, 'total_pitches');
  if (!avgPitches || estKPct == null || estBBPct == null) return rollingAvg(starts, 'ip');

  const bipPct = 1 - estKPct - estBBPct;
  const P_BIP = 3.5, P_K = 5.0, P_BB = 5.5;
  const pitchesPerBatter = bipPct * P_BIP + estKPct * P_K + estBBPct * P_BB;
  const outsPerBatter = bipPct * 0.72 + estKPct * 1.0;
  const pitchesPerOut = safeDivide(pitchesPerBatter, outsPerBatter);
  if (pitchesPerOut === 0) return rollingAvg(starts, 'ip');

  return safeDivide(avgPitches, pitchesPerOut * 3);
}

// Sub-model 5: ERA via FIP
function estimateERA(estK, estBB, estHR, estIP, fipConstant) {
  if (!estIP || estIP === 0) return null;
  return safeDivide((13 * estHR) + (3 * estBB) - (2 * estK), estIP) + fipConstant;
}

// Sub-model 6: Win probability via Pythagorean expectation
function estimateWinProb(starts, estERA, lgRunsPerGame) {
  if (estERA == null) return { pWin: null, pLoss: null };

  const runsAllowed = estERA;
  const lgR = lgRunsPerGame;
  const pythWinPct = safeDivide(lgR * lgR, lgR * lgR + runsAllowed * runsAllowed);

  const totalStarts = starts.length;
  const wins = rollingSum(starts, 'won');
  const decisionRate = totalStarts > 0 ? Math.min((wins + (totalStarts - wins) * 0.4) / totalStarts, 0.75) : 0.6;

  return {
    pWin: pythWinPct * decisionRate,
    pLoss: (1 - pythWinPct) * decisionRate,
  };
}

// Sub-model 7: QS probability
function estimateQSProb(starts, estIP, estERA) {
  if (estIP == null || estERA == null) return null;

  const totalStarts = starts.length;
  const qsCount = rollingSum(starts, 'qs');
  const rollingQsRate = totalStarts > 0 ? qsCount / totalStarts : 0;

  const estERin6 = estERA * 6 / 9;
  const modelQs = (estIP >= 6 && estERin6 <= 3) ? 0.7 :
                  (estIP >= 5.5 && estERin6 <= 3.5) ? 0.4 :
                  0.15;

  return rollingQsRate * 0.5 + modelQs * 0.5;
}

function computeForWindow(db, playerId, windowSize, config, weights) {
  const starts = getRecentStarts(db, playerId, windowSize);
  if (starts.length === 0) return null;

  const xkPct = estimateKPct(starts);
  const xbbPct = estimateBBPct(starts);
  const regBabip = regressedBABIP(starts, config.lgBabip);
  const regHr9 = regressedHR9(starts, config.lgHrFb);
  const estIP = estimateIP(starts, xkPct, xbbPct);
  const estPA = rollingAvg(starts, 'pa') || 25;

  const estK = (xkPct || 0.20) * estPA;
  const estBB = (xbbPct || 0.077) * estPA;
  const estBIP = estPA - estK - estBB;
  const estHR = (regHr9 || 1.2) * (estIP || 6) / 9;
  const estH = regBabip * Math.max(estBIP, 0) + estHR;

  const estERA = estimateERA(estK, estBB, estHR, estIP, config.fipConstant);
  const estER = estERA != null ? estERA * (estIP || 6) / 9 : null;

  const { pWin, pLoss } = estimateWinProb(starts, estERA, config.lgRunsPerGame);
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
        const result = computeForWindow(db, player_id, w, config, weights);
        if (result) {
          upsert.run(result);
          count++;
        }
      }
    }
  })();

  return { models: count, pitchers: pitchers.length };
}
