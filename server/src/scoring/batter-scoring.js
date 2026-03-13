import { safeDivide } from './utils.js';

// Priority order for position sources. Entries are prefix-matched against
// source strings (e.g. 'espn' matches 'espn_2025', 'espn_2026', etc.).
// When multiple sources share a prefix, the most recent year wins.
const SOURCE_PRIORITY = ['manual', 'espn', 'yahoo', 'fantrax'];

export function resolvePosition(positionRows) {
  if (!positionRows || positionRows.length === 0) return 'Other';
  for (const prefix of SOURCE_PRIORITY) {
    // Gather all rows matching this prefix, sort by source descending so newest year wins
    const matching = positionRows
      .filter(r => r.source === prefix || r.source.startsWith(prefix + '_'))
      .sort((a, b) => b.source.localeCompare(a.source));
    if (matching.length === 0) continue;
    // Use positions from the best (newest) source only
    const bestSource = matching[0].source;
    const positions = matching
      .filter(r => r.source === bestSource)
      .map(r => r.position);
    if (positions.length > 0) return positions.join(', ');
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
