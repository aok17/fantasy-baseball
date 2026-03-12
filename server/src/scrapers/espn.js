import { reconcileName, loadReplacements } from './names.js';

export function parseEspnResponse(json) {
  if (!json?.players) return [];
  return json.players.map(p => ({
    name: p.player?.fullName || '',
    adp_rank: p.ratings?.['0']?.positionalRanking ?? null,
    projected_points: p.ratings?.['0']?.totalRating ?? null,
  })).filter(p => p.name);
}

export async function fetchEspn(db) {
  const year = db.prepare("SELECT value FROM app_config WHERE key='season_year'").get()?.value || '2026';
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leaguedefaults/3?view=kona_player_info`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN fetch failed: ${res.status}`);
  const json = await res.json();
  const players = parseEspnResponse(json);

  const replacements = loadReplacements(db);
  db.prepare('DELETE FROM espn_adp').run();
  const insert = db.prepare('INSERT INTO espn_adp (name, adp_rank, projected_points) VALUES (?, ?, ?)');
  for (const p of players) {
    const name = reconcileName(p.name, replacements);
    insert.run(name, p.adp_rank, p.projected_points);
  }

  return { players: players.length };
}
