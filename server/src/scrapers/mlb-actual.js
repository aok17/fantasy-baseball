// Season-to-date actual stats from the MLB StatsAPI.
//
// Why this exists: fetchFanGraphsActual() reads FanGraphs' leaders endpoint,
// which now sits behind the same Cloudflare bot challenge as the rest of their
// site and returns 403. StatsAPI is the same source the planning pipeline
// already uses, is unauthenticated, and carries every counting stat the
// rankings table displays.
//
// Two differences from the FanGraphs feed it replaces:
//   - Quality starts are not a StatsAPI stat. They're recovered from the
//     pitcher_starts table (Savant-derived, one row per start with a qs flag).
//   - WAR / RA9-WAR / wOBA / wRC+ / BsR / Off / Def don't exist here and are
//     written as 0, same as the Razzball projections.
//
// Players are linked by MLBAM id rather than name, which is what the StatsAPI
// returns natively and is far stronger than the old fg_id/name matching.

import { toFgAbbrev } from './team-abbrev.js';

const STATS_BASE = 'https://statsapi.mlb.com/api/v1/stats';
const TEAMS_BASE = 'https://statsapi.mlb.com/api/v1/teams';
const PAGE = 1000;

function num(v) {
  if (v === '' || v == null || v === '-.--' || v === '.---') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// StatsAPI reports innings as "184.2" meaning 184 innings and 2 outs.
export function parseInnings(ip) {
  const s = String(ip ?? '0');
  const [whole, frac] = s.split('.');
  const outs = frac ? Number(frac[0]) || 0 : 0;
  return Number(whole || 0) + outs / 3;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`StatsAPI fetch failed (${res.status}): ${url}`);
  return res.json();
}

// id -> FanGraphs-style abbreviation, so rows land on the same club spelling
// the rest of the database uses.
async function teamAbbrevMap(season) {
  const j = await getJson(`${TEAMS_BASE}?sportId=1&season=${season}`);
  const m = new Map();
  for (const t of j.teams || []) if (t?.id != null) m.set(t.id, toFgAbbrev(t.abbreviation));
  return m;
}

// Every player's season line for one group, following pagination.
export async function fetchSeasonSplits(season, group) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${STATS_BASE}?stats=season&group=${group}&season=${season}&sportId=1&limit=${PAGE}&offset=${offset}&playerPool=all`;
    const j = await getJson(url);
    const splits = j.stats?.[0]?.splits || [];
    out.push(...splits);
    const total = j.stats?.[0]?.totalSplits ?? out.length;
    if (splits.length === 0 || out.length >= total) break;
  }
  return out;
}

export function mapPitcherSplit(s, teams, { fipConstant = 3.15 } = {}) {
  const st = s.stat || {};
  const IP = parseInnings(st.inningsPitched);
  const SO = num(st.strikeOuts), BB = num(st.baseOnBalls);
  const HR = num(st.homeRuns), HBP = num(st.hitBatsmen);
  return {
    mlbam_id: s.player?.id != null ? String(s.player.id) : null,
    name: s.player?.fullName || '',
    team: teams.get(s.team?.id) ?? null,
    GS: num(st.gamesStarted), G: num(st.gamesPitched || st.gamesPlayed), IP: Number(IP.toFixed(1)),
    W: num(st.wins), L: num(st.losses),
    QS: 0, // not a StatsAPI stat — backfilled from pitcher_starts below
    SV: num(st.saves), HLD: num(st.holds),
    H: num(st.hits), ER: num(st.earnedRuns), HR, SO, BB,
    WHIP: num(st.whip),
    K9: num(st.strikeoutsPer9Inn), BB9: num(st.walksPer9Inn),
    ERA: num(st.era),
    FIP: IP > 0
      ? Number((((13 * HR) + (3 * (BB + HBP)) - (2 * SO)) / IP + fipConstant).toFixed(2))
      : 0,
    WAR: 0, RA9WAR: 0,
    fg_id: null,
  };
}

export function mapBatterSplit(s, teams) {
  const st = s.stat || {};
  return {
    mlbam_id: s.player?.id != null ? String(s.player.id) : null,
    name: s.player?.fullName || '',
    team: teams.get(s.team?.id) ?? null,
    G: num(st.gamesPlayed), PA: num(st.plateAppearances), AB: num(st.atBats),
    H: num(st.hits), '2B': num(st.doubles), '3B': num(st.triples),
    HR: num(st.homeRuns), R: num(st.runs), RBI: num(st.rbi),
    BB: num(st.baseOnBalls), SO: num(st.strikeOuts), HBP: num(st.hitByPitch),
    SB: num(st.stolenBases), CS: num(st.caughtStealing),
    AVG: num(st.avg), OBP: num(st.obp), SLG: num(st.slg), OPS: num(st.ops),
    wOBA: 0, wRC: 0, BsR: 0, Fld: 0, Off: 0, Def: 0, WAR: 0,
    fg_id: null,
  };
}

export async function fetchMlbActual(db, onProgress) {
  const progress = onProgress || (() => {});
  const season = Number(db.prepare("SELECT value FROM app_config WHERE key='season_year'").get()?.value)
    || new Date().getFullYear();
  const fipConstant = Number(
    db.prepare("SELECT value FROM app_config WHERE key='fip_constant'").get()?.value ?? 3.15
  );

  progress(0, 3, 'Fetching MLB team list...');
  const teams = await teamAbbrevMap(season);

  progress(1, 3, 'Fetching season pitching stats...');
  const pitchers = (await fetchSeasonSplits(season, 'pitching'))
    .map(s => mapPitcherSplit(s, teams, { fipConstant }))
    .filter(p => p.name);

  progress(2, 3, 'Fetching season hitting stats...');
  const batters = (await fetchSeasonSplits(season, 'hitting'))
    .map(s => mapBatterSplit(s, teams))
    .filter(b => b.name);

  if (pitchers.length === 0 && batters.length === 0) {
    console.warn('StatsAPI returned no season stats — keeping existing data');
    return { pitchers: 0, batters: 0, skipped: true };
  }

  // MLBAM id -> players.id, so actuals link by id instead of by name.
  const byMlbam = new Map(
    db.prepare('SELECT id, mlbam_id FROM players WHERE mlbam_id IS NOT NULL').all()
      .map(r => [String(r.mlbam_id), r.id])
  );
  // Quality starts, recovered per player from the Savant-derived start log.
  const qsByPlayer = new Map(
    db.prepare('SELECT player_id, SUM(qs) qs FROM pitcher_starts WHERE player_id IS NOT NULL GROUP BY player_id')
      .all().map(r => [r.player_id, Number(r.qs) || 0])
  );

  let linked = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM pitchers_actual').run();
    const insP = db.prepare(`INSERT INTO pitchers_actual (player_id, name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB, WHIP, K9, BB9, ERA, FIP, WAR, RA9WAR, fg_id) VALUES (@player_id, @name, @team, @GS, @G, @IP, @W, @L, @QS, @SV, @HLD, @H, @ER, @HR, @SO, @BB, @WHIP, @K9, @BB9, @ERA, @FIP, @WAR, @RA9WAR, @fg_id)`);
    for (const p of pitchers) {
      const player_id = byMlbam.get(p.mlbam_id) ?? null;
      if (player_id) linked++;
      const { mlbam_id, ...row } = p;
      insP.run({ ...row, player_id, QS: player_id ? (qsByPlayer.get(player_id) ?? 0) : 0 });
    }

    db.prepare('DELETE FROM batters_actual').run();
    const insB = db.prepare(`INSERT INTO batters_actual (player_id, name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS, AVG, OBP, SLG, OPS, wOBA, wRC, BsR, Fld, Off, Def, WAR, fg_id) VALUES (@player_id, @name, @team, @G, @PA, @AB, @H, @2B, @3B, @HR, @R, @RBI, @BB, @SO, @HBP, @SB, @CS, @AVG, @OBP, @SLG, @OPS, @wOBA, @wRC, @BsR, @Fld, @Off, @Def, @WAR, @fg_id)`);
    for (const b of batters) {
      const player_id = byMlbam.get(b.mlbam_id) ?? null;
      if (player_id) linked++;
      const { mlbam_id, ...row } = b;
      insB.run({ ...row, player_id });
    }
  })();

  progress(3, 3, 'Done');
  return { pitchers: pitchers.length, batters: batters.length, linked };
}
