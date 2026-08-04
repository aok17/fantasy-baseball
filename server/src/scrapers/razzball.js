// Razzball Steamer projections scraper.
//
// Why this exists: FanGraphs put their site behind a Cloudflare bot challenge,
// so fetchFanGraphs() now 403s for any non-browser client, and FanGraphs'
// stated policy is that the only supported export is a member's one-click CSV.
// Razzball publishes the same underlying Steamer projections as plain
// server-rendered HTML tables, which carry every stat the scoring engine
// actually reads.
//
// Two things this must reconcile with the existing data:
//   1. Team abbreviations. Razzball uses KC/SD/SF/TB/WSH where the FanGraphs
//      data already in players.team uses KCR/SDP/SFG/TBR/WSN. rescore() links
//      raw rows to players by `name|team`, so an un-normalized import would
//      orphan every player on those five clubs.
//   2. Missing advanced stats. Razzball has no WAR/wOBA/wRC+/Off/Def/BsR.
//      K/9, BB/9 and FIP are all derivable from counting stats and are computed
//      here; the rest are written as 0 (display-only columns in the UI).

const HITTER_URL = 'https://razzball.com/steamer-hitter-projections/';
const PITCHER_URL = 'https://razzball.com/steamer-pitcher-projections/';

// Razzball abbreviation -> the FanGraphs-style abbreviation already in players.team.
const TEAM_MAP = {
  KC: 'KCR', SD: 'SDP', SF: 'SFG', TB: 'TBR', WSH: 'WSN',
};

export function normalizeTeam(t) {
  const s = String(t ?? '').trim().toUpperCase();
  if (!s || s === 'FA') return null; // free agent — no club
  return TEAM_MAP[s] || s;
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

function cellText(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function num(v) {
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(/[$,%]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Parse the largest <table> on the page into { headers, rows }.
// Razzball renders plain server-side tables (<th> header row, <td> data cells),
// so this stays dependency-free rather than pulling a DOM lib onto a 256MB VM.
export function parseTable(html, { minRows = 20 } = {}) {
  const tables = String(html ?? '').match(/<table[\s\S]*?<\/table>/gi) || [];
  let best = null, bestCount = 0;
  for (const t of tables) {
    const n = (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).length;
    if (n > bestCount) { best = t; bestCount = n; }
  }
  if (!best || bestCount < minRows) {
    throw new Error(`No projection table found (largest had ${bestCount} rows)`);
  }

  const trs = best.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const headers = (trs[0].match(/<th[\s\S]*?<\/th>/gi) || []).map(cellText);
  if (headers.length < 5) throw new Error(`Header row looks wrong: ${headers.join(',')}`);

  const rows = [];
  for (const tr of trs.slice(1)) {
    const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(cellText);
    if (cells.length !== headers.length) continue; // skip ad/spacer rows
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    rows.push(row);
  }
  if (!rows.length) throw new Error('Projection table had no usable data rows');
  return { headers, rows };
}

// Razzball's trailing id column is a MIXED id space, not purely MLBAM:
//   - 6 digits  -> a real MLBAM id (1448 of 1661 rows; all 1448 verified against
//                  the StatsAPI people endpoint, zero mismatches)
//   - 4-5 digits-> a FanGraphs id for longer-tenured players (Nola 16149,
//                  deGrom 10954), NOT an MLBAM id
//   - 7 digits  -> a suffixed duplicate for two-way players (Ohtani 6602710,
//                  whose real MLBAM is 660271) so his bat and arm rows differ
// Only the 6-digit form is accepted. A wrong id here would silently attach
// another player's handedness and schedule in the planning pipeline, so
// anything outside the verified shape is dropped rather than guessed at.
export function mlbamOf(r) {
  const v = String(r.RazzID ?? r.RazzId ?? '').trim();
  return /^\d{6}$/.test(v) ? v : null;
}

export function mapRazzPitcher(r, { fipConstant = 3.15 } = {}) {
  const IP = num(r.IP);
  const SO = num(r.K !== undefined ? r.K : r.SO);
  const BB = num(r.BB);
  const HR = num(r.HR);
  const HBP = num(r.HBP);
  return {
    name: cellText(r.Name), team: normalizeTeam(r.Team),
    GS: num(r.GS), G: num(r.G), IP,
    W: num(r.W), L: num(r.L), QS: num(r.QS),
    SV: num(r.SV), HLD: num(r.HLD),
    H: num(r.H), ER: num(r.ER), HR, SO, BB,
    WHIP: num(r.WHIP),
    // Derived — Razzball publishes the counting stats but not the rates.
    K9: IP > 0 ? Number((SO * 9 / IP).toFixed(2)) : 0,
    BB9: IP > 0 ? Number((BB * 9 / IP).toFixed(2)) : 0,
    ERA: num(r.ERA),
    FIP: IP > 0
      ? Number((((13 * HR) + (3 * (BB + HBP)) - (2 * SO)) / IP + fipConstant).toFixed(2))
      : 0,
    // Not published by Razzball; display-only in the rankings table.
    WAR: 0, RA9WAR: 0,
    fg_id: null,
    mlbam_id: mlbamOf(r),
  };
}

export function mapRazzBatter(r) {
  return {
    name: cellText(r.Name), team: normalizeTeam(r.Team),
    G: num(r.G), PA: num(r.PA), AB: num(r.AB),
    H: num(r.H), '2B': num(r['2B']), '3B': num(r['3B']),
    HR: num(r.HR), R: num(r.R), RBI: num(r.RBI),
    BB: num(r.BB), SO: num(r.SO), HBP: num(r.HBP),
    SB: num(r.SB), CS: num(r.CS),
    AVG: num(r.AVG), OBP: num(r.OBP), SLG: num(r.SLG), OPS: num(r.OPS),
    // Not published by Razzball; display-only in the rankings table.
    wOBA: 0, wRC: 0, BsR: 0, Fld: 0, Off: 0, Def: 0, WAR: 0,
    fg_id: null,
    mlbam_id: mlbamOf(r),
  };
}

async function getHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'fantasy-baseball/1.0' } });
  if (!res.ok) throw new Error(`Razzball fetch failed (${url}): ${res.status}`);
  return res.text();
}

// Fetch + persist both projection sets. Mirrors fetchFanGraphs(): rewrites the
// raw tables in one transaction, and refuses to wipe on an empty parse.
export async function fetchRazzball(db, onProgress) {
  const progress = onProgress || (() => {});
  const fipConstant = Number(
    db.prepare("SELECT value FROM app_config WHERE key='fip_constant'").get()?.value ?? 3.15
  );

  progress(0, 2, 'Fetching Razzball pitcher projections...');
  const pitRows = parseTable(await getHtml(PITCHER_URL)).rows;
  const pitchers = pitRows.map(r => mapRazzPitcher(r, { fipConstant })).filter(p => p.name);

  progress(1, 2, 'Fetching Razzball hitter projections...');
  const batRows = parseTable(await getHtml(HITTER_URL)).rows;
  const batters = batRows.map(mapRazzBatter).filter(b => b.name);

  if (pitchers.length === 0 && batters.length === 0) {
    console.warn('Razzball returned 0 pitchers and 0 batters — keeping existing data');
    return { pitchers: 0, batters: 0, skipped: true };
  }

  db.transaction(() => {
    if (pitchers.length > 0) {
      db.prepare('DELETE FROM pitchers_raw').run();
      const ins = db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB, WHIP, K9, BB9, ERA, FIP, WAR, RA9WAR, fg_id, mlbam_id) VALUES (@name, @team, @GS, @G, @IP, @W, @L, @QS, @SV, @HLD, @H, @ER, @HR, @SO, @BB, @WHIP, @K9, @BB9, @ERA, @FIP, @WAR, @RA9WAR, @fg_id, @mlbam_id)`);
      for (const p of pitchers) ins.run(p);
    }
    if (batters.length > 0) {
      db.prepare('DELETE FROM batters_raw').run();
      const ins = db.prepare(`INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS, AVG, OBP, SLG, OPS, wOBA, wRC, BsR, Fld, Off, Def, WAR, fg_id, mlbam_id) VALUES (@name, @team, @G, @PA, @AB, @H, @2B, @3B, @HR, @R, @RBI, @BB, @SO, @HBP, @SB, @CS, @AVG, @OBP, @SLG, @OPS, @wOBA, @wRC, @BsR, @Fld, @Off, @Def, @WAR, @fg_id, @mlbam_id)`);
      for (const b of batters) ins.run(b);
    }
  })();

  progress(2, 2, 'Done');
  return { pitchers: pitchers.length, batters: batters.length };
}
