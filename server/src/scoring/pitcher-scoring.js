import { safeDivide } from './utils.js';

export function computePitcherScores(pitchers, weights, replacementLevel) {
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

    const adjustment = scoring_position === 'CLOSER'
      ? -10
      : -Math.min(raw_score * 3 / 7, replacementLevel * 10 / 7 * 3 / 7) + 165;

    const adj_score = raw_score + adjustment;

    const relief_pts = safeDivide(raw_score * (p.G - p.GS), p.IP);
    const starting_pts = raw_score - relief_pts;

    const sp_value = -Math.min(starting_pts * 3 / 7, replacementLevel * 10 / 7 * 3 / 7) + 215 + starting_pts;
    const rp_value = relief_pts + 71;
    const adj_2020_value = Math.max(sp_value, rp_value);

    const pts_per_appearance = safeDivide(raw_score, p.G);

    return {
      name: p.name, team: p.team,
      scoring_position, display_position,
      raw_score, adjustment, adj_score,
      starting_pts, relief_pts, adj_2020_value, pts_per_appearance,
    };
  });
}
