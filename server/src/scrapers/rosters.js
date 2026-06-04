import { reconcileName, loadReplacements } from './names.js';

export async function fetchRosters(db) {
  const year = db.prepare("SELECT value FROM app_config WHERE key='season_year'").get()?.value || '2026';
  const leagueId = db.prepare("SELECT value FROM app_config WHERE key='espn_league_id'").get()?.value;
  const myTeamId = Number(db.prepare("SELECT value FROM app_config WHERE key='espn_team_id'").get()?.value);

  if (!leagueId) throw new Error('espn_league_id not configured');

  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leagues/${leagueId}?view=mRoster&view=mTeam`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN roster fetch failed: ${res.status}`);
  const data = await res.json();

  // Build member ID → first name map
  const members = {};
  for (const m of (data.members || [])) {
    members[m.id] = m.firstName;
  }

  // Extract roster entries from each team
  const entries = [];
  for (const team of (data.teams || [])) {
    const teamName = team.name || team.abbrev || `Team ${team.id}`;
    for (const entry of (team.roster?.entries || [])) {
      const playerId = entry.playerId;
      const playerName = entry.playerPoolEntry?.player?.fullName || `Unknown (#${playerId})`;
      entries.push({
        espn_player_id: playerId,
        player_name: playerName,
        team_id: team.id,
        team_name: team.id === myTeamId ? 'me' : teamName,
      });
    }
  }

  if (entries.length === 0) {
    console.warn('ESPN returned 0 roster entries');
    return { teams: 0, players: 0 };
  }

  const insert = db.prepare(
    'INSERT OR REPLACE INTO rosters (espn_player_id, player_name, team_id, team_name) VALUES (?, ?, ?, ?)'
  );

  db.transaction(() => {
    db.prepare('DELETE FROM rosters').run();
    for (const e of entries) {
      insert.run(e.espn_player_id, e.player_name, e.team_id, e.team_name);
    }
  })();

  const teamCount = new Set(entries.map(e => e.team_id)).size;
  return { teams: teamCount, players: entries.length };
}
