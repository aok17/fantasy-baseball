export function buildCombinedRankings(pitcherScores, batterScores, espnAdp, velocityDeltas) {
  const rows = [];

  for (const p of pitcherScores) {
    rows.push({
      name: p.name, team: p.team,
      position: p.display_position,
      score: p.raw_score,
      adj_score: p.adj_2020_value,
      espn_adp: espnAdp[p.name] ?? null,
      velocity_delta: velocityDeltas[p.name] ?? null,
      per_game_efficiency: p.pts_per_appearance,
    });
  }

  for (const b of batterScores) {
    rows.push({
      name: b.name, team: b.team,
      position: b.position,
      score: b.raw_score,
      adj_score: b.adj_score,
      espn_adp: espnAdp[b.name] ?? null,
      velocity_delta: null,
      per_game_efficiency: b.pts_per_game,
    });
  }

  rows.sort((a, b) => {
    if (b.adj_score !== a.adj_score) return b.adj_score - a.adj_score;
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return rows.map((row, i) => ({
    ...row,
    rank: i + 1,
    value_gap: row.espn_adp != null ? (i + 1) - row.espn_adp : null,
  }));
}
