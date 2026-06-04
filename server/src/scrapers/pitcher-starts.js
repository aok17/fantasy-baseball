import { parse } from 'csv-parse/sync';
import { convertLastFirst } from './names.js';

function num(val) {
  if (val === '' || val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

function parseSavantGameLog(csvText) {
  let csv = csvText.replace(/^\uFEFF/, '');
  if (!csv.trim() || csv.includes('No data')) return [];
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
  return records.map(r => ({
    mlbam_id: r.player_id || null,
    player_name: convertLastFirst(r.player_name?.replace(/"/g, '') || ''),
    game_date: r.game_date || null,
    total_pitches: num(r.total_pitches),
    pa: num(r.pa),
    bip: num(r.bip),
    hits: num(r.hits),
    hrs: num(r.hrs),
    so: num(r.so),
    bb: num(r.bb),
    whiffs: num(r.whiffs),
    swings: num(r.swings),
    takes: num(r.takes),
    babip: num(r.babip),
    woba: num(r.woba),
    xwoba: num(r.xwoba),
  }));
}

function parseCalledStrikes(csvText) {
  let csv = csvText.replace(/^\uFEFF/, '');
  if (!csv.trim() || csv.includes('No data')) return new Map();
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
  const map = new Map();
  for (const r of records) {
    const key = `${r.player_id}|${r.game_date}`;
    map.set(key, num(r.pitches) || 0);
  }
  return map;
}

async function fetchSavantGameLogs(season, sinceDate) {
  const base = 'https://baseballsavant.mlb.com/statcast_search/csv';
  let params = `?all=true&hfGT=R%7C&hfSea=${season}%7C&player_type=pitcher&group_by=name-date&min_pitches=40&min_results=0&min_pas=0&sort_col=pitches&sort_order=desc&chk_stats_pa=on&chk_stats_abs=on&chk_stats_bip=on&chk_stats_hits=on&chk_stats_hrs=on&chk_stats_so=on&chk_stats_k_percent=on&chk_stats_bb=on&chk_stats_bb_percent=on&chk_stats_whiffs=on&chk_stats_swings=on&chk_stats_ba=on&chk_stats_babip=on&chk_stats_woba=on&chk_stats_xwoba=on`;

  // Only fetch games after sinceDate if we have prior data
  if (sinceDate) {
    params += `&game_date_gt=${sinceDate}`;
    console.log(`Incremental Savant fetch: games after ${sinceDate}`);
  }

  const mainRes = await fetch(`${base}${params}`);
  if (!mainRes.ok) throw new Error(`Savant game log fetch failed: ${mainRes.status}`);
  const mainCsv = await mainRes.text();
  const starts = parseSavantGameLog(mainCsv);

  // Second fetch for called strikes (same date filter)
  const csRes = await fetch(`${base}${params}&hfPR=called_strike%7C`);
  if (!csRes.ok) throw new Error(`Savant called-strike fetch failed: ${csRes.status}`);
  const csCsv = await csRes.text();
  const csMap = parseCalledStrikes(csCsv);

  // Merge called strikes into main data
  for (const s of starts) {
    const key = `${s.mlbam_id}|${s.game_date}`;
    s.called_strikes = csMap.get(key) || 0;
  }

  return starts;
}

async function fetchMlbGameLog(mlbamId, season) {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbamId}/stats?stats=gameLog&season=${season}&group=pitching`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  const splits = json.stats?.[0]?.splits || [];
  return splits
    .filter(s => s.stat.gamesStarted > 0 && s.gameType === 'R')
    .map(s => ({
      date: s.date,
      ip: parseIP(s.stat.inningsPitched),
      er: s.stat.earnedRuns || 0,
      won: s.stat.wins > 0 ? 1 : 0,
      loss: s.stat.losses > 0 ? 1 : 0,
      pitches: s.stat.numberOfPitches || 0,
    }));
}

// Parse "5.2" (5 and 2/3 innings) to 5.667
function parseIP(ipStr) {
  if (!ipStr) return 0;
  const parts = String(ipStr).split('.');
  const full = parseInt(parts[0]) || 0;
  const partial = parseInt(parts[1]) || 0;
  return full + partial / 3;
}

export async function fetchPitcherStarts(db, onProgress) {
  const progress = onProgress || (() => {});
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'season_year'").get();
  const season = Number(row?.value) || new Date().getFullYear();

  // Check for most recent start we already have — fetch from 3 days before
  // to ensure we don't miss late-processed data. Duplicates handled by UPSERT.
  const lastStart = db.prepare(
    'SELECT MAX(game_date) as last_date FROM pitcher_starts WHERE season = ?'
  ).get(season);
  let sinceDate = null;
  if (lastStart?.last_date) {
    const d = new Date(lastStart.last_date);
    d.setDate(d.getDate() - 3);
    sinceDate = d.toISOString().slice(0, 10);
  }

  // 1. Fetch Savant game logs (incremental if we have prior data)
  progress(0, 3, sinceDate ? `Fetching new starts since ${sinceDate}...` : 'Fetching Savant game logs...');
  const savantStarts = await fetchSavantGameLogs(season, sinceDate);
  progress(1, 3, `Savant: ${savantStarts.length} new starts`);
  console.log(`Savant game logs: ${savantStarts.length} new starts${sinceDate ? ` (since ${sinceDate})` : ''}`);

  // If no new starts, skip MLB API calls entirely
  if (savantStarts.length === 0) {
    progress(3, 3, 'No new starts found');
    console.log('No new starts — skipping MLB API');
    return { starts: 0, pitchers: 0, incremental: true };
  }

  // 2. Get SP mlbam_ids from combined_rankings
  const sps = db.prepare(`
    SELECT DISTINCT p.mlbam_id FROM combined_rankings cr
    JOIN players p ON p.id = cr.player_id
    WHERE cr.position LIKE '%SP%' AND p.mlbam_id IS NOT NULL
  `).all();
  const spIds = new Set(sps.map(r => r.mlbam_id));

  // Fetch MLB API for pitchers with new Savant starts + any with missing IP data
  const pitchersWithNewStarts = new Set(savantStarts.map(s => s.mlbam_id).filter(id => spIds.has(id)));
  const pitchersMissingIP = db.prepare(
    'SELECT DISTINCT mlbam_id FROM pitcher_starts WHERE ip IS NULL AND season = ?'
  ).all(season).map(r => r.mlbam_id);
  const fetchIds = new Set([...pitchersWithNewStarts, ...pitchersMissingIP]);
  if (fetchIds.size === 0 && savantStarts.length > 0) {
    // First run or no SP matches — fetch all
    for (const id of spIds) fetchIds.add(id);
  }

  const total = 2 + fetchIds.size + 1;
  progress(2, total, `Fetching MLB API for ${fetchIds.size} pitchers...`);

  // 3. Fetch MLB API game logs only for pitchers with new data
  const mlbLogs = new Map();
  let mlbTotal = 0;
  let i = 0;
  for (const mlbamId of fetchIds) {
    const logs = await fetchMlbGameLog(mlbamId, season);
    for (const g of logs) {
      mlbLogs.set(`${mlbamId}|${g.date}`, g);
      mlbTotal++;
    }
    i++;
    if (i % 10 === 0 || i === fetchIds.size) {
      progress(2 + i, total, `MLB API: ${i}/${fetchIds.size} pitchers`);
    }
  }
  console.log(`MLB API game logs: ${mlbTotal} starts for ${fetchIds.size} pitchers`);

  progress(total - 1, total, 'Writing to database...');

  // 4. Join and upsert into pitcher_starts
  const findPlayer = db.prepare('SELECT id FROM players WHERE mlbam_id = ?');
  const upsert = db.prepare(`
    INSERT INTO pitcher_starts
      (player_id, mlbam_id, player_name, game_date, season,
       total_pitches, pa, bip, hits, hrs, so, bb,
       whiffs, swings, takes, called_strikes,
       babip, woba, xwoba, ip, er, won, qs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mlbam_id, game_date) DO UPDATE SET
      player_id=excluded.player_id, total_pitches=excluded.total_pitches,
      pa=excluded.pa, bip=excluded.bip, hits=excluded.hits, hrs=excluded.hrs,
      so=excluded.so, bb=excluded.bb, whiffs=excluded.whiffs, swings=excluded.swings,
      takes=excluded.takes, called_strikes=excluded.called_strikes,
      babip=excluded.babip, woba=excluded.woba, xwoba=excluded.xwoba,
      ip=excluded.ip, er=excluded.er, won=excluded.won, qs=excluded.qs
  `);

  let inserted = 0;
  db.transaction(() => {
    for (const s of savantStarts) {
      if (!s.mlbam_id || !s.game_date) continue;

      // Try to find MLB API data for this start
      const mlb = mlbLogs.get(`${s.mlbam_id}|${s.game_date}`);

      // Skip if no MLB API data (not a confirmed start) and not in our SP list
      if (!mlb && !spIds.has(s.mlbam_id)) continue;

      const ip = mlb?.ip ?? null;
      const er = mlb?.er ?? null;
      const won = mlb?.won ?? 0;
      const qs = (ip != null && er != null && ip >= 6 && er <= 3) ? 1 : 0;
      const playerId = findPlayer.get(s.mlbam_id)?.id ?? null;

      upsert.run(
        playerId, s.mlbam_id, s.player_name, s.game_date, season,
        s.total_pitches, s.pa, s.bip, s.hits, s.hrs, s.so, s.bb,
        s.whiffs, s.swings, s.takes, s.called_strikes,
        s.babip, s.woba, s.xwoba, ip, er, won, qs
      );
      inserted++;
    }
  })();

  return { starts: inserted, pitchers: spIds.size };
}
