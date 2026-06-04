import { reconcileName, loadReplacements, buildAccentMap } from './names.js';

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
    return {
      name: p.player?.fullName || '',
      espn_id: p.player?.id ?? p.id ?? null,
      adp_rank: p.player?.draftRanksByRankType?.STANDARD?.rank ?? null,
      projected_points: p.ratings?.['0']?.totalRating ?? null,
      positions,
    };
  }).filter(p => p.name);
}

// Fetch a single batch of players from ESPN
async function fetchEspnBatch(url, offset, limit) {
  const res = await fetch(url, {
    headers: {
      'x-fantasy-filter': JSON.stringify({
        players: { limit, offset, sortPercOwned: { sortAsc: false, sortPriority: 1 } },
      }),
    },
  });
  if (!res.ok) throw new Error(`ESPN fetch failed: ${res.status}`);
  let json = await res.json();
  const players = parseEspnResponse(json);
  json = null; // free ~12MB per batch
  return players;
}

export async function fetchEspn(db) {
  const year = db.prepare("SELECT value FROM app_config WHERE key='season_year'").get()?.value || '2026';
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leaguedefaults/3?view=kona_player_info`;

  const replacements = loadReplacements(db);
  const accentMap = buildAccentMap(db);
  const source = `espn_${year}`;

  const insertAdp = db.prepare(
    'INSERT INTO espn_rank (name, espn_id, adp_rank, projected_points) VALUES (?, ?, ?, ?)'
  );
  const insertPos = db.prepare(
    'INSERT OR IGNORE INTO position_eligibility (name, espn_id, source, position) VALUES (?, ?, ?, ?)'
  );

  // Clear tables before batch inserts
  db.prepare('DELETE FROM espn_rank').run();
  db.prepare('DELETE FROM position_eligibility WHERE source = ?').run(source);

  // First pass: fetch all batches to find bestByName for accent mapping.
  // Only store the minimal data needed (name → pts) to keep memory low.
  const BATCH_SIZE = 100;
  // Track best ESPN rank per reconciled name for accent mapping
  // (lower rank = better; use rank not projected_points which can be negative)
  const bestRankByName = {};
  let totalPlayers = 0;

  for (let offset = 0; offset < 1500; offset += BATCH_SIZE) {
    const batch = await fetchEspnBatch(url, offset, BATCH_SIZE);
    for (const p of batch) {
      const n = reconcileName(p.name, replacements);
      const rank = p.adp_rank ?? 99999;
      if (!bestRankByName[n] || rank < bestRankByName[n]) bestRankByName[n] = rank;
    }
    // Insert this batch immediately and discard
    db.transaction(() => {
      for (const p of batch) {
        let name = reconcileName(p.name, replacements);
        // Defer accent mapping to second pass
        insertAdp.run(name, p.espn_id, p.adp_rank, p.projected_points);
        for (const pos of p.positions) {
          insertPos.run(name, p.espn_id, source, pos);
        }
      }
    })();
    totalPlayers += batch.length;
    if (global.gc) global.gc();
    if (batch.length < BATCH_SIZE) break;
  }

  if (totalPlayers === 0) {
    console.warn('ESPN returned 0 players — keeping existing data');
    return { players: 0, positions: 0, skipped: true };
  }

  // Second pass (in-DB): apply accent mapping to the best-ranked player per name
  for (const [stripped, accented] of Object.entries(accentMap)) {
    const bestRank = bestRankByName[stripped];
    if (bestRank == null) continue;
    db.prepare('UPDATE espn_rank SET name = ? WHERE name = ? AND adp_rank <= ?')
      .run(accented, stripped, bestRank);
  }
  // Sync position_eligibility names from espn_rank via espn_id
  // (avoids renaming the wrong player when two share a name, e.g. two "Julio Rodriguez")
  db.exec(`
    UPDATE position_eligibility SET name = (
      SELECT er.name FROM espn_rank er WHERE er.espn_id = position_eligibility.espn_id
    ) WHERE source = '${source}' AND espn_id IS NOT NULL
  `);

  return { players: totalPlayers, positions: 0 };
}
