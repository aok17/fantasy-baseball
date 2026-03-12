import { parse } from 'csv-parse/sync';

function parseNumeric(val) {
  if (val === '' || val === null || val === undefined) return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

export async function parsePitcherCsv(csvText) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  return records.map(r => ({
    name: r.Name, team: r.Team,
    GS: parseNumeric(r.GS), G: parseNumeric(r.G), IP: parseNumeric(r.IP),
    W: parseNumeric(r.W), L: parseNumeric(r.L), QS: parseNumeric(r.QS),
    SV: parseNumeric(r.SV), HLD: parseNumeric(r.HLD),
    H: parseNumeric(r.H), ER: parseNumeric(r.ER), HR: parseNumeric(r.HR),
    SO: parseNumeric(r.SO), BB: parseNumeric(r.BB),
    WHIP: parseNumeric(r.WHIP), K9: parseNumeric(r['K/9']), BB9: parseNumeric(r['BB/9']),
    ERA: parseNumeric(r.ERA), FIP: parseNumeric(r.FIP),
    WAR: parseNumeric(r.WAR), RA9WAR: parseNumeric(r['RA9-WAR']),
    player_id: r.playerid || null,
  }));
}

export async function parseBatterCsv(csvText) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  return records.map(r => ({
    name: r.Name, team: r.Team,
    G: parseNumeric(r.G), PA: parseNumeric(r.PA), AB: parseNumeric(r.AB),
    H: parseNumeric(r.H), '2B': parseNumeric(r['2B']), '3B': parseNumeric(r['3B']),
    HR: parseNumeric(r.HR), R: parseNumeric(r.R), RBI: parseNumeric(r.RBI),
    BB: parseNumeric(r.BB), SO: parseNumeric(r.SO), HBP: parseNumeric(r.HBP),
    SB: parseNumeric(r.SB), CS: parseNumeric(r.CS),
    AVG: parseNumeric(r.AVG), OBP: parseNumeric(r.OBP), SLG: parseNumeric(r.SLG),
    OPS: parseNumeric(r.OPS), wOBA: parseNumeric(r.wOBA), wRC: parseNumeric(r['wRC+']),
    BsR: parseNumeric(r.BsR), Fld: parseNumeric(r.Fld),
    Off: parseNumeric(r.Off), Def: parseNumeric(r.Def), WAR: parseNumeric(r.WAR),
    player_id: r.playerid || null,
  }));
}

export async function fetchFanGraphs(db) {
  const email = process.env.FANGRAPHS_EMAIL;
  const password = process.env.FANGRAPHS_PASSWORD;
  if (!email || !password) throw new Error('FanGraphs credentials not configured in .env');

  const projSystem = db.prepare("SELECT value FROM app_config WHERE key='projection_system'").get()?.value || 'steamer';

  const loginRes = await fetch('https://www.fangraphs.com/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) throw new Error(`FanGraphs login failed: ${loginRes.status}`);
  const cookies = loginRes.headers.getSetCookie?.() || [];
  const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');

  const pitUrl = `https://www.fangraphs.com/api/projections?type=${projSystem}&stats=pit&pos=all&team=&lg=all&players=0&download=true`;
  const pitRes = await fetch(pitUrl, { headers: { Cookie: cookieHeader } });
  if (!pitRes.ok) throw new Error(`FanGraphs pitcher fetch failed: ${pitRes.status}`);
  const pitchers = await parsePitcherCsv(await pitRes.text());

  const batUrl = `https://www.fangraphs.com/api/projections?type=${projSystem}&stats=bat&pos=all&team=&lg=all&players=0&download=true`;
  const batRes = await fetch(batUrl, { headers: { Cookie: cookieHeader } });
  if (!batRes.ok) throw new Error(`FanGraphs batter fetch failed: ${batRes.status}`);
  const batters = await parseBatterCsv(await batRes.text());

  db.prepare('DELETE FROM pitchers_raw').run();
  const insertPit = db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB, WHIP, K9, BB9, ERA, FIP, WAR, RA9WAR, player_id) VALUES (@name, @team, @GS, @G, @IP, @W, @L, @QS, @SV, @HLD, @H, @ER, @HR, @SO, @BB, @WHIP, @K9, @BB9, @ERA, @FIP, @WAR, @RA9WAR, @player_id)`);
  for (const p of pitchers) insertPit.run(p);

  db.prepare('DELETE FROM batters_raw').run();
  const insertBat = db.prepare(`INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS, AVG, OBP, SLG, OPS, wOBA, wRC, BsR, Fld, Off, Def, WAR, player_id) VALUES (@name, @team, @G, @PA, @AB, @H, @2B, @3B, @HR, @R, @RBI, @BB, @SO, @HBP, @SB, @CS, @AVG, @OBP, @SLG, @OPS, @wOBA, @wRC, @BsR, @Fld, @Off, @Def, @WAR, @player_id)`);
  for (const b of batters) insertBat.run(b);

  return { pitchers: pitchers.length, batters: batters.length };
}
