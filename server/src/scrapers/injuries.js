export async function fetchInjuries(db) {
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'season_year'").get();
  const season = Number(row?.value) || new Date().getFullYear();

  const url = `https://www.fangraphs.com/api/roster-resource/injury-report/data?groupby=team&timeframe=current&season=${season}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FanGraphs injury fetch failed: ${res.status}`);
  const data = await res.json();

  if (!Array.isArray(data)) throw new Error('Injury API returned non-array response');

  const current = data.filter(r => r.isNotCurrent === 0 && r.playerName1);

  if (current.length === 0) {
    console.warn('Injury scrape returned 0 results — keeping existing data');
    return { injuries: 0, skipped: true };
  }

  const insert = db.prepare(`INSERT OR REPLACE INTO injuries (name, team, position, injury, status, latest_update, mlbam_id)
    VALUES (@name, @team, @position, @injury, @status, @latest_update, @mlbam_id)`);

  db.transaction(() => {
    db.prepare('DELETE FROM injuries').run();
    for (const r of current) {
      insert.run({
        name: r.playerName1,
        team: r.team || null,
        position: r.position || null,
        injury: r.injurySurgery || null,
        status: r.status || null,
        latest_update: r.currentLatestUpdate || r.latestUpdate || null,
        mlbam_id: r.mlbamid ? String(r.mlbamid) : null,
      });
    }
  })();

  return { injuries: current.length };
}
