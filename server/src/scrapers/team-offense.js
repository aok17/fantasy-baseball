// MLB team offense (runs scored) for the planning view.
// Two cheap StatsAPI calls: league-wide team hitting totals + the team list for
// abbreviations. Verified shapes:
//   /api/v1/teams/stats?season=Y&sportIds=1&stats=season&group=hitting
//     -> json.stats[0].splits[] each { team: { id, name }, stat: { gamesPlayed, runs, ... } }
//   /api/v1/teams?sportId=1&season=Y
//     -> json.teams[] each { id, name, abbreviation }

const TEAM_STATS_BASE = 'https://statsapi.mlb.com/api/v1/teams/stats';
const TEAMS_BASE = 'https://statsapi.mlb.com/api/v1/teams';

// Fetch every MLB club's season-to-date offense.
// Returns [{ team_id, abbr, name, games, runs, runs_per_game }] (unranked, any order).
export async function fetchTeamOffense(season) {
  const statsUrl = `${TEAM_STATS_BASE}?season=${season}&sportIds=1&stats=season&group=hitting`;
  const statsRes = await fetch(statsUrl);
  if (!statsRes.ok) throw new Error(`Team offense fetch failed: ${statsRes.status}`);
  const statsJson = await statsRes.json();

  const teamsUrl = `${TEAMS_BASE}?sportId=1&season=${season}`;
  const teamsRes = await fetch(teamsUrl);
  if (!teamsRes.ok) throw new Error(`Teams fetch failed: ${teamsRes.status}`);
  const teamsJson = await teamsRes.json();

  const metaById = new Map();
  for (const t of teamsJson.teams || []) {
    if (t?.id == null) continue;
    metaById.set(Number(t.id), { abbr: t.abbreviation || null, name: t.name || null });
  }

  const rows = [];
  for (const split of statsJson.stats?.[0]?.splits || []) {
    const teamId = split.team?.id;
    if (teamId == null) continue;
    const meta = metaById.get(Number(teamId)) || {};
    const games = Number(split.stat?.gamesPlayed) || 0;
    const runs = Number(split.stat?.runs) || 0;
    rows.push({
      team_id: Number(teamId),
      abbr: meta.abbr || null,
      name: split.team?.name || meta.name || null,
      games,
      runs,
      runs_per_game: games > 0 ? runs / games : 0,
    });
  }
  return rows;
}

// Idempotent table creation — schema.sql is owned elsewhere, so this module
// creates its own table on first use.
export function ensureTeamOffenseTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_team_offense (
      team_id INTEGER PRIMARY KEY,
      season INTEGER,
      abbr TEXT,
      name TEXT,
      games INTEGER,
      runs INTEGER,
      runs_per_game REAL,
      runs_rank INTEGER,
      updated_at TEXT
    )
  `);
}

// Rank 1 = best offense (most runs per game), 30 = worst.
// Ties broken by total runs; teams equal on both share a rank and the next
// rank skips accordingly (standard competition ranking: 1, 2, 2, 4).
// Returns a new array sorted best-first with runs_rank attached.
export function rankTeamOffense(rows) {
  const sorted = [...rows].map(r => ({
    ...r,
    runs_per_game: r.runs_per_game != null
      ? Number(r.runs_per_game)
      : (Number(r.games) > 0 ? Number(r.runs) / Number(r.games) : 0),
  }));
  sorted.sort((a, b) => (b.runs_per_game - a.runs_per_game) || (b.runs - a.runs) || (a.team_id - b.team_id));

  let prev = null;
  let prevRank = 0;
  sorted.forEach((r, i) => {
    const tied = prev && prev.runs_per_game === r.runs_per_game && prev.runs === r.runs;
    r.runs_rank = tied ? prevRank : i + 1;
    prevRank = r.runs_rank;
    prev = r;
  });
  return sorted;
}

// Persist team offense rows with computed ranks. Returns count upserted.
export function upsertTeamOffense(db, rows, season) {
  ensureTeamOffenseTable(db);
  const ranked = rankTeamOffense(rows || []);
  const updatedAt = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO mlb_team_offense
      (team_id, season, abbr, name, games, runs, runs_per_game, runs_rank, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id) DO UPDATE SET
      season=excluded.season, abbr=excluded.abbr, name=excluded.name,
      games=excluded.games, runs=excluded.runs, runs_per_game=excluded.runs_per_game,
      runs_rank=excluded.runs_rank, updated_at=excluded.updated_at
  `);
  let n = 0;
  db.transaction(() => {
    for (const r of ranked) {
      if (r.team_id == null) continue;
      stmt.run(r.team_id, season ?? r.season ?? null, r.abbr ?? null, r.name ?? null,
        Number(r.games) || 0, Number(r.runs) || 0, r.runs_per_game, r.runs_rank, updatedAt);
      n++;
    }
  })();
  return n;
}

// Map<team_id, { abbr, name, runs_per_game, runs_rank }> for joins elsewhere.
export function getTeamOffenseMap(db) {
  ensureTeamOffenseTable(db);
  const map = new Map();
  const rows = db.prepare(
    'SELECT team_id, abbr, name, runs_per_game, runs_rank FROM mlb_team_offense'
  ).all();
  for (const r of rows) {
    map.set(r.team_id, {
      abbr: r.abbr,
      name: r.name,
      runs_per_game: r.runs_per_game,
      runs_rank: r.runs_rank,
    });
  }
  return map;
}

// Convenience for the refresh path: fetch + persist in one call.
export async function refreshTeamOffense(db, season) {
  const rows = await fetchTeamOffense(season);
  const n = upsertTeamOffense(db, rows, season);
  return { teams: n };
}
