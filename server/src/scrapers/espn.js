import { reconcileName, loadReplacements } from './names.js';

export const ESPN_SLOT_TO_POSITION = {
  0: 'C',
  1: '1B',
  2: '2B',
  3: '3B',
  4: 'SS',
  5: 'OF',
};

const PITCHER_POSITION_IDS = new Set([1, 11]);

export function parseEspnResponse(json) {
  if (!json?.players) return [];
  return json.players.map(p => {
    const isPitcher = PITCHER_POSITION_IDS.has(p.player?.defaultPositionId);
    const slots = p.player?.eligibleSlots || [];
    const positions = isPitcher
      ? []
      : slots
          .filter(s => s in ESPN_SLOT_TO_POSITION)
          .map(s => ESPN_SLOT_TO_POSITION[s]);
    const adp = p.player?.ownership?.averageDraftPosition ?? null;
    return {
      name: p.player?.fullName || '',
      adp_rank: adp ? Math.round(adp) : null,
      projected_points: p.ratings?.['0']?.totalRating ?? null,
      positions,
    };
  }).filter(p => p.name);
}

export async function fetchEspn(db) {
  const year = db.prepare("SELECT value FROM app_config WHERE key='season_year'").get()?.value || '2026';
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leaguedefaults/3?view=kona_player_info`;

  const res = await fetch(url, {
    headers: {
      'x-fantasy-filter': JSON.stringify({
        players: {
          limit: 1500,
          sortPercOwned: { sortAsc: false, sortPriority: 1 },
        },
      }),
    },
  });
  if (!res.ok) throw new Error(`ESPN fetch failed: ${res.status}`);
  const json = await res.json();
  const players = parseEspnResponse(json);

  const replacements = loadReplacements(db);
  const source = `espn_${year}`;

  db.prepare('DELETE FROM espn_adp').run();
  db.prepare('DELETE FROM position_eligibility WHERE source = ?').run(source);

  const insertAdp = db.prepare(
    'INSERT INTO espn_adp (name, adp_rank, projected_points) VALUES (?, ?, ?)'
  );
  const insertPos = db.prepare(
    'INSERT OR IGNORE INTO position_eligibility (name, source, position) VALUES (?, ?, ?)'
  );

  for (const p of players) {
    const name = reconcileName(p.name, replacements);
    insertAdp.run(name, p.adp_rank, p.projected_points);
    for (const pos of p.positions) {
      insertPos.run(name, source, pos);
    }
  }

  return { players: players.length, positions: players.filter(p => p.positions.length > 0).length };
}
