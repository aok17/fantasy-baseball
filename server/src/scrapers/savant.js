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
    barrel_pct: num(r.barrel_batted_rate),
    xwoba: num(r.xwoba),
  }));
}

export async function fetchSavant(db) {
  const fetches = [
    { season: 2024, gameType: 'R', seasonType: 'regular' },
    { season: 2025, gameType: 'ST', seasonType: 'spring' },
  ];

  db.prepare('DELETE FROM statcast_pitches').run();
  const insert = db.prepare(`INSERT INTO statcast_pitches
    (player_id, player_name, season, season_type, pitch_type, velocity, spin_rate, whiff_pct, barrel_pct, xwoba)
    VALUES (@player_id, @player_name, @season, @season_type, @pitch_type, @velocity, @spin_rate, @whiff_pct, @barrel_pct, @xwoba)`);

  let total = 0;
  for (const { season, gameType, seasonType } of fetches) {
    const url = `https://baseballsavant.mlb.com/leaderboard/custom?n=abs&stats=pit&qual=1&type=1&season=${season}&month=0&game_type=${gameType}&min=10&csv=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Savant fetch failed for ${season} ${seasonType}: ${res.status}`);
    const csv = await res.text();
    const rows = await parseSavantCsv(csv, season, seasonType);
    for (const r of rows) insert.run(r);
    total += rows.length;
  }

  return { rows: total };
}
