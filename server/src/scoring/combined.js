export function buildCombinedRankings(pitcherScores, batterScores, espnRank, velocityDeltas, idMap) {
  const rows = [];

  for (const p of pitcherScores) {
    const pid = idMap[`${p.name}|${p.team}`] || null;
    rows.push({
      player_id: pid,
      name: p.name, team: p.team,
      position: p.display_position,
      score: p.raw_score,
      adj_score: p.adj_2020_value,
      espn_rank: pid ? (espnRank[pid] ?? null) : null,
      velocity_delta: pid ? (velocityDeltas[pid]?.delta ?? null) : null,
      velo_prev: pid ? (velocityDeltas[pid]?.velo_prev ?? null) : null,
      velo_curr: pid ? (velocityDeltas[pid]?.velo_curr ?? null) : null,
      velo_n: pid ? (velocityDeltas[pid]?.velo_n ?? null) : null,
      per_game_efficiency: p.pts_per_appearance,
    });
  }

  for (const b of batterScores) {
    const pid = idMap[`${b.name}|${b.team}`] || null;
    rows.push({
      player_id: pid,
      name: b.name, team: b.team,
      position: b.position,
      score: b.raw_score,
      adj_score: b.adj_score,
      espn_rank: pid ? (espnRank[pid] ?? null) : null,
      velocity_delta: null,
      velo_prev: null,
      velo_curr: null,
      velo_n: null,
      per_game_efficiency: b.pts_per_game,
    });
  }

  rows.sort((a, b) => {
    if (b.adj_score !== a.adj_score) return b.adj_score - a.adj_score;
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  const posCount = {};
  return rows.map((row, i) => {
    const primary = row.position?.split(',')[0]?.trim() || 'DH';
    posCount[primary] = (posCount[primary] || 0) + 1;
    return {
      ...row,
      rank: i + 1,
      pos_rank: posCount[primary],
      value_gap: row.espn_rank != null ? (i + 1) - row.espn_rank : null,
    };
  });
}
