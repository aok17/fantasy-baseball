function num(val) {
  if (val === '' || val === null || val === undefined) return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

export function mapPitcher(r) {
  return {
    name: r.PlayerName, team: r.Team,
    GS: num(r.GS), G: num(r.G), IP: num(r.IP),
    W: num(r.W), L: num(r.L), QS: num(r.QS),
    SV: num(r.SV), HLD: num(r.HLD),
    H: num(r.H), ER: num(r.ER), HR: num(r.HR),
    SO: num(r.SO), BB: num(r.BB),
    WHIP: num(r.WHIP), K9: num(r['K/9']), BB9: num(r['BB/9']),
    ERA: num(r.ERA), FIP: num(r.FIP),
    WAR: num(r.WAR), RA9WAR: num(r['RA9-WAR']),
    player_id: r.playerid || null,
  };
}

export function mapBatter(r) {
  return {
    name: r.PlayerName, team: r.Team,
    G: num(r.G), PA: num(r.PA), AB: num(r.AB),
    H: num(r.H), '2B': num(r['2B']), '3B': num(r['3B']),
    HR: num(r.HR), R: num(r.R), RBI: num(r.RBI),
    BB: num(r.BB), SO: num(r.SO), HBP: num(r.HBP),
    SB: num(r.SB), CS: num(r.CS),
    AVG: num(r.AVG), OBP: num(r.OBP), SLG: num(r.SLG),
    OPS: num(r.OPS), wOBA: num(r.wOBA), wRC: num(r['wRC+']),
    BsR: num(r.wBsR), Fld: num(r.Def),
    Off: num(r.Off), Def: num(r.Def), WAR: num(r.WAR),
    player_id: r.playerid || null,
  };
}

export async function fetchFanGraphs(db) {
  const projSystem = db.prepare("SELECT value FROM app_config WHERE key='projection_system'").get()?.value || 'steamer';

  const pitUrl = `https://www.fangraphs.com/api/projections?type=${projSystem}&stats=pit&pos=all`;
  const pitRes = await fetch(pitUrl);
  if (!pitRes.ok) throw new Error(`FanGraphs pitcher fetch failed: ${pitRes.status}`);
  const pitchers = (await pitRes.json()).map(mapPitcher);

  const batUrl = `https://www.fangraphs.com/api/projections?type=${projSystem}&stats=bat&pos=all`;
  const batRes = await fetch(batUrl);
  if (!batRes.ok) throw new Error(`FanGraphs batter fetch failed: ${batRes.status}`);
  const batters = (await batRes.json()).map(mapBatter);

  if (pitchers.length === 0 && batters.length === 0) {
    console.warn('FanGraphs returned 0 pitchers and 0 batters — keeping existing data');
    return { pitchers: 0, batters: 0, skipped: true };
  }

  db.transaction(() => {
    if (pitchers.length > 0) {
      db.prepare('DELETE FROM pitchers_raw').run();
      const insertPit = db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB, WHIP, K9, BB9, ERA, FIP, WAR, RA9WAR, player_id) VALUES (@name, @team, @GS, @G, @IP, @W, @L, @QS, @SV, @HLD, @H, @ER, @HR, @SO, @BB, @WHIP, @K9, @BB9, @ERA, @FIP, @WAR, @RA9WAR, @player_id)`);
      for (const p of pitchers) insertPit.run(p);
    }

    if (batters.length > 0) {
      db.prepare('DELETE FROM batters_raw').run();
      const insertBat = db.prepare(`INSERT INTO batters_raw (name, team, G, PA, AB, H, "2B", "3B", HR, R, RBI, BB, SO, HBP, SB, CS, AVG, OBP, SLG, OPS, wOBA, wRC, BsR, Fld, Off, Def, WAR, player_id) VALUES (@name, @team, @G, @PA, @AB, @H, @2B, @3B, @HR, @R, @RBI, @BB, @SO, @HBP, @SB, @CS, @AVG, @OBP, @SLG, @OPS, @wOBA, @wRC, @BsR, @Fld, @Off, @Def, @WAR, @player_id)`);
      for (const b of batters) insertBat.run(b);
    }
  })();

  return { pitchers: pitchers.length, batters: batters.length };
}
