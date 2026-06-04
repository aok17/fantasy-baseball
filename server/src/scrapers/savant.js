import { parse } from 'csv-parse/sync';
import { convertLastFirst } from './names.js';

function num(val) {
  if (val === '' || val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

export async function parseSavantCsv(csvText, season, seasonType) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  return records.map(r => ({
    player_id: r.player_id || null,
    player_name: convertLastFirst(r.player_name?.replace(/"/g, '') || ''),
    season,
    season_type: seasonType,
    pitch_type: r.pitch_type || null,
    velocity: num(r.velocity),
    spin_rate: num(r.spin_rate),
    whiff_pct: num(r.whiff_percent) ?? num(r.whiffs),
    barrel_pct: num(r.barrels_per_bbe_percent) ?? num(r.barrel_batted_rate),
    xwoba: num(r.xwoba),
  }));
}

async function fetchExpectedStats(db, year) {
  const insert = db.prepare(`INSERT OR REPLACE INTO savant_expected
    (mlbam_id, player_name, player_type, pa, xwoba, woba, xwoba_diff)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  let total = 0;
  for (const type of ['batter', 'pitcher']) {
    const url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=${type}&year=${year}&position=&team=&min=1&csv=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Savant expected stats (${type}) failed: ${res.status}`);
    let csv = await res.text();
    // Strip BOM if present
    csv = csv.replace(/^\uFEFF/, '');
    if (!csv.trim() || csv.includes('No data')) continue;
    const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });

    db.transaction(() => {
      for (const r of records) {
        const mlbamId = r.player_id;
        // Column is "last_name, first_name" (single field with comma)
        const nameField = r['last_name, first_name'] || r.player_name || '';
        const name = convertLastFirst(nameField.replace(/"/g, ''));
        const xwoba = num(r.est_woba);
        const woba = num(r.woba);
        const diff = xwoba != null && woba != null ? Math.round((xwoba - woba) * 1000) / 1000 : null;
        insert.run(mlbamId, name, type, num(r.pa) ?? num(r.batters_faced), xwoba, woba, diff);
        total++;
      }
    })();
  }

  // Populate mlbam_id on players from savant data (covers batters too)
  db.exec(`
    UPDATE players SET mlbam_id = (
      SELECT se.mlbam_id FROM savant_expected se
      WHERE se.player_name = players.name AND se.mlbam_id IS NOT NULL
      LIMIT 1
    ) WHERE mlbam_id IS NULL;
  `);

  // Populate player_id FK on savant_expected
  db.exec(`
    UPDATE savant_expected SET player_id = (
      SELECT p.id FROM players p WHERE p.mlbam_id = savant_expected.mlbam_id
    ) WHERE player_id IS NULL;
  `);

  return total;
}

export async function fetchSavant(db) {
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'season_year'").get();
  const currentYear = Number(row?.value) || new Date().getFullYear();
  const fetches = [
    { season: currentYear - 1, gameType: 'R', seasonType: 'regular' },
    { season: currentYear, gameType: 'S', seasonType: 'spring' },
  ];

  // Delete all existing data first
  db.prepare('DELETE FROM statcast_pitches').run();

  const insert = db.prepare(`INSERT INTO statcast_pitches
    (player_id, player_name, season, season_type, pitch_type, velocity, spin_rate, whiff_pct, barrel_pct, xwoba)
    VALUES (@player_id, @player_name, @season, @season_type, @pitch_type, @velocity, @spin_rate, @whiff_pct, @barrel_pct, @xwoba)`);

  let total = 0;
  for (const { season, gameType, seasonType } of fetches) {
    const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfGT=${gameType}%7C&hfSea=${season}%7C&player_type=pitcher&min_pitches=0&min_results=0&group_by=pitch-type&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&min_pas=0`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Savant fetch failed for ${season} ${seasonType}: ${res.status}`);
    const csv = await res.text();
    const rows = await parseSavantCsv(csv, season, seasonType);

    // Insert this season's data in its own transaction, then discard
    if (rows.length > 0) {
      db.transaction(() => {
        for (const r of rows) insert.run(r);
      })();
    }
    total += rows.length;
  }

  if (total === 0) {
    console.warn('Savant returned 0 rows across all seasons');
  }

  // Fetch expected stats (xwOBA) for current season
  db.prepare('DELETE FROM savant_expected').run();
  let expectedTotal = 0;
  try {
    expectedTotal = await fetchExpectedStats(db, currentYear);
  } catch (e) {
    console.warn('Savant expected stats fetch failed:', e.message);
  }

  return { rows: total, expected: expectedTotal };
}
