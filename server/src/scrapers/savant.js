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

export async function fetchSavant(db) {
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'season_year'").get();
  const currentYear = Number(row?.value) || new Date().getFullYear();
  const fetches = [
    { season: currentYear - 1, gameType: 'R', seasonType: 'regular' },
    { season: currentYear, gameType: 'S', seasonType: 'spring' },
  ];

  const allRows = [];
  for (const { season, gameType, seasonType } of fetches) {
    const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfGT=${gameType}%7C&hfSea=${season}%7C&player_type=pitcher&min_pitches=0&min_results=0&group_by=pitch-type&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&min_pas=0`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Savant fetch failed for ${season} ${seasonType}: ${res.status}`);
    const csv = await res.text();
    const rows = await parseSavantCsv(csv, season, seasonType);
    allRows.push(...rows);
  }

  if (allRows.length === 0) {
    console.warn('Savant returned 0 rows — keeping existing data');
    return { rows: 0, skipped: true };
  }

  const insert = db.prepare(`INSERT INTO statcast_pitches
    (player_id, player_name, season, season_type, pitch_type, velocity, spin_rate, whiff_pct, barrel_pct, xwoba)
    VALUES (@player_id, @player_name, @season, @season_type, @pitch_type, @velocity, @spin_rate, @whiff_pct, @barrel_pct, @xwoba)`);

  db.transaction(() => {
    db.prepare('DELETE FROM statcast_pitches').run();
    for (const r of allRows) insert.run(r);
  })();

  return { rows: allRows.length };
}
