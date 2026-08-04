// MLB StatsAPI fetchers for the planning view.
// One ranged schedule call (probablePitcher + lineups) covers schedule, actual/announced
// starters, and ground-truth batter starts. One batched people call covers handedness + team.

const SCHEDULE_BASE = 'https://statsapi.mlb.com/api/v1/schedule';
const PEOPLE_BASE = 'https://statsapi.mlb.com/api/v1/people';
const TRANSACTIONS_BASE = 'https://statsapi.mlb.com/api/v1/transactions';

// Fetch the full season schedule, chunked by month to bound memory.
// Returns games[] each with { game_pk, game_date, season, home_team_id, away_team_id,
//   home_sp_mlbam, away_sp_mlbam, status, home_lineup:[mlbam], away_lineup:[mlbam] }.
export async function fetchSchedule(season, { months = [3, 4, 5, 6, 7, 8, 9, 10] } = {}) {
  const games = [];
  for (const m of months) {
    const start = `${season}-${String(m).padStart(2, '0')}-01`;
    const endDay = new Date(Date.UTC(season, m, 0)).getUTCDate(); // last day of month m
    const end = `${season}-${String(m).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
    const url = `${SCHEDULE_BASE}?sportId=1&startDate=${start}&endDate=${end}&hydrate=probablePitcher,lineups`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Schedule fetch failed (${start}..${end}): ${res.status}`);
    const json = await res.json();
    for (const dt of json.dates || []) {
      for (const g of dt.games || []) {
        if (g.gameType !== 'R') continue; // regular season only
        const lu = g.lineups || {};
        games.push({
          game_pk: g.gamePk,
          game_date: g.officialDate || (g.gameDate || '').slice(0, 10),
          season,
          home_team_id: g.teams?.home?.team?.id ?? null,
          away_team_id: g.teams?.away?.team?.id ?? null,
          home_sp_mlbam: g.teams?.home?.probablePitcher?.id ? String(g.teams.home.probablePitcher.id) : null,
          away_sp_mlbam: g.teams?.away?.probablePitcher?.id ? String(g.teams.away.probablePitcher.id) : null,
          status: g.status?.detailedState || null,
          home_lineup: (lu.homePlayers || []).map(p => String(p.id)),
          away_lineup: (lu.awayPlayers || []).map(p => String(p.id)),
        });
      }
    }
  }
  return games;
}

// Batch-fetch handedness + identity for a list of mlbam ids.
// Returns Map<mlbam, { bat_hand, throw_hand, mlb_team_id, full_name, position, team_abbrev }>.
// full_name/position/team_abbrev let the planning compute create a players row
// for a starter who exists in the schedule but in no ranking file (streamers,
// call-ups, back-end starters) — see planning/player-link.js.
export async function fetchHandedness(mlbamIds, { batchSize = 300 } = {}) {
  const ids = [...new Set(mlbamIds.filter(Boolean).map(String))];
  const map = new Map();
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const url = `${PEOPLE_BASE}?personIds=${chunk.join(',')}&hydrate=currentTeam`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`People fetch failed: ${res.status}`);
    const json = await res.json();
    for (const p of json.people || []) {
      map.set(String(p.id), {
        bat_hand: p.batSide?.code || null,
        throw_hand: p.pitchHand?.code || null,
        mlb_team_id: p.currentTeam?.id ?? null,
        full_name: p.fullName || null,
        position: p.primaryPosition?.abbreviation || null,
        team_abbrev: p.currentTeam?.abbreviation || null,
      });
    }
  }
  return map;
}

// Fetch IL placement/activation transaction events for a set of teams.
// Per-team (not league-wide) to bound the response size on a 256MB VM — a
// full-league window can be thousands of rows. Filters to injured-list events.
// Returns [{ mlbam, date, description }] (any order).
export async function fetchIlTransactions(season, teamIds, { endDate } = {}) {
  const start = `${season}-01-01`;
  const end = endDate || `${season}-12-31`;
  const events = [];
  for (const teamId of [...new Set(teamIds.filter(Boolean))]) {
    const url = `${TRANSACTIONS_BASE}?teamId=${teamId}&startDate=${start}&endDate=${end}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Transactions fetch failed (team ${teamId}): ${res.status}`);
    const json = await res.json();
    for (const t of json.transactions || []) {
      if (!t.person?.id || !/injured list/i.test(t.description || '')) continue;
      events.push({
        mlbam: String(t.person.id),
        date: (t.effectiveDate || t.date || '').slice(0, 10),
        description: t.description,
      });
    }
  }
  return events;
}

// Persist schedule rows. Returns count upserted.
export function upsertSchedule(db, games) {
  const stmt = db.prepare(`
    INSERT INTO mlb_schedule
      (game_pk, game_date, season, home_team_id, away_team_id, home_sp_mlbam, away_sp_mlbam, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_pk) DO UPDATE SET
      game_date=excluded.game_date, home_sp_mlbam=excluded.home_sp_mlbam,
      away_sp_mlbam=excluded.away_sp_mlbam, status=excluded.status
  `);
  let n = 0;
  db.transaction(() => {
    for (const g of games) {
      if (!g.game_pk || !g.home_team_id || !g.away_team_id) continue;
      stmt.run(g.game_pk, g.game_date, g.season, g.home_team_id, g.away_team_id,
        g.home_sp_mlbam, g.away_sp_mlbam, g.status);
      n++;
    }
  })();
  return n;
}
