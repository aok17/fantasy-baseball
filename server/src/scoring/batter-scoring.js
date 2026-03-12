function safeDivide(a, b) {
  return b === 0 ? 0 : a / b;
}

const POSITION_COLUMNS = [
  'pos_espn_2025', 'pos_yahoo_2025', 'pos_espn_2024',
  'pos_yahoo_2024', 'pos_fantrax_2025', 'pos_manual',
];

export function resolvePosition(positionRow) {
  for (const col of POSITION_COLUMNS) {
    if (positionRow[col]) return positionRow[col];
  }
  return 'Other';
}

function primaryPosition(positionString) {
  return positionString.split(',')[0].trim();
}

export function computeBatterScores(batters, weights, posAdj) {
  return batters.map(b => {
    const raw_score =
      (b.H || 0) * weights.H +
      (b['2B'] || 0) * weights['2B'] +
      (b['3B'] || 0) * weights['3B'] +
      (b.HR || 0) * weights.HR +
      (b.R || 0) * weights.R +
      (b.RBI || 0) * weights.RBI +
      (b.BB || 0) * weights.BB +
      (b.SO || 0) * weights.SO +
      (b.SB || 0) * weights.SB;

    const position = b.position || 'Other';
    const primary = primaryPosition(position);
    const adjustment = posAdj[primary] ?? posAdj.Other ?? 10;
    const adj_score = raw_score + adjustment;
    const pts_per_game = safeDivide(raw_score, b.G);

    return {
      name: b.name, team: b.team, position,
      raw_score, adjustment, adj_score, pts_per_game,
    };
  });
}
