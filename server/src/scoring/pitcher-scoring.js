import { safeDivide } from './utils.js';

// Per-pitcher raw components. Replacement-agnostic: VOR is applied separately
// (applyPitcherVOR) once the whole pool exists, since "replacement level" is a
// population concept, not a per-player one.
export function computePitcherScores(pitchers, weights) {
  return pitchers.map(p => {
    const raw_score =
      (p.IP || 0) * weights.IP +
      (p.W || 0) * weights.W +
      (p.L || 0) * weights.L +
      (p.QS || 0) * weights.QS +
      (p.SV || 0) * weights.SV +
      (p.H || 0) * weights.H +
      (p.ER || 0) * weights.ER +
      (p.SO || 0) * weights.SO +
      (p.BB || 0) * weights.BB;

    const scoring_position = p.SV > 0 ? 'CLOSER' : 'SP';

    let display_position;
    if (p.GS === p.G) display_position = 'SP';
    else if (p.GS === 0) display_position = 'RP';
    else display_position = 'SP, RP';

    // Split raw value into start-derived and relief-derived points (prorated by the
    // share of appearances that were relief). Each is valued against its own role's
    // replacement level so closers/swingmen aren't measured against starter depth.
    const relief_pts = safeDivide(raw_score * (p.G - p.GS), p.IP);
    const starting_pts = raw_score - relief_pts;
    const pts_per_appearance = safeDivide(raw_score, p.G);

    return {
      name: p.name, team: p.team,
      scoring_position, display_position,
      raw_score, starting_pts, relief_pts, pts_per_appearance,
    };
  });
}

// Value Over Replacement, role-split: a pitcher is worth the better of his value as a
// starter (above SP replacement) or as a reliever (above RP replacement). repl =
// { sp, rp } from computeReplacement. `adj_2020_value` is the board sort key; the
// stored `adjustment`/`adj_score` columns are kept as derived views of it (no magic).
export function applyPitcherVOR(scored, repl) {
  return scored.map(p => {
    const sp_vor = p.starting_pts - (repl.sp || 0);
    const rp_vor = p.relief_pts - (repl.rp || 0);
    const adj_2020_value = Math.max(sp_vor, rp_vor);
    return {
      ...p,
      sp_vor, rp_vor, adj_2020_value,
      adj_score: adj_2020_value,
      adjustment: adj_2020_value - p.raw_score,
    };
  });
}
