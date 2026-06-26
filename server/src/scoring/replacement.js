// Value-Over-Replacement baselines, derived entirely from the current projection
// distribution + the league's real roster construction. No hand-tuned constants.
//
// Replacement level at a position = the projected value of the player sitting at the
// depth the league actually rosters: rank = leagueSize * startingSlots[position].
// Example (10-team league): 1 catcher slot -> the 10th-best catcher is replacement;
// 5 OF slots -> the 50th-best OF; 8 flex-P slots -> the ~80th starter; 1 RP slot ->
// the 10th-best reliever. Scarce positions have a low replacement (big premium for
// good ones); deep positions have a high replacement (little premium). The old
// C70..DH10 ladder and the 237/+215/+71 pitcher floors fall out of the data instead
// of being guessed.

// ESPN baseball lineupSlotId -> which pool its starting slots feed.
// Flex P (13) is counted as SP capacity (points leagues fill flex with starters);
// UTIL (12) as DH capacity. Bench(16)/IL(17) never count (not starting depth).
export function slotsFromEspn(lineupSlotCounts) {
  const n = (id) => Number(lineupSlotCounts?.[id]) || 0;
  return {
    C: n(0), '1B': n(1), '2B': n(2), '3B': n(3), SS: n(4),
    OF: n(5) + n(8) + n(9) + n(10),
    DH: n(11) + n(12),
    SP: n(13) + n(14),
    RP: n(15),
  };
}

// Sensible default if league settings haven't been scraped yet (10-team standard).
export const DEFAULT_SLOTS = { C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 5, DH: 1, SP: 8, RP: 1 };

const BATTER_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'OF', 'DH'];

function eligible(positionString) {
  return (positionString || 'DH').split(',').map((s) => s.trim()).filter(Boolean);
}

// Value at a given roster depth in a descending-sorted pool. If the pool is thinner
// than the rank (early season, sparse position), the worst rostered-depth player we
// have IS the replacement — return the last value. Empty pool -> 0 (no baseline,
// VOR collapses to raw, which is the correct "we don't know yet" behavior).
function valueAtDepth(sortedDesc, rank) {
  if (sortedDesc.length === 0) return 0;
  if (rank <= 0) return sortedDesc[sortedDesc.length - 1];
  const idx = Math.min(rank, sortedDesc.length) - 1;
  return sortedDesc[idx];
}

// pitchers: raw-scored pitcher objects (need display_position, scoring_position,
//           starting_pts, relief_pts). batters: need position, raw_score.
export function computeReplacement(pitchers, batters, { leagueSize, slots }) {
  const sz = Number(leagueSize) || 0;

  const spVals = pitchers
    .filter((p) => /SP/.test(p.display_position || ''))
    .map((p) => p.starting_pts)
    .sort((a, b) => b - a);
  const rpVals = pitchers
    .filter((p) => /RP/.test(p.display_position || '') || p.scoring_position === 'CLOSER')
    .map((p) => p.relief_pts)
    .sort((a, b) => b - a);

  const sp = valueAtDepth(spVals, sz * (slots.SP || 0));
  const rp = valueAtDepth(rpVals, sz * (slots.RP || 0));

  // Depth of a generic everyday bat = every batter starting slot in the lineup.
  // This is the bar for the DH/UTIL slot, which any batter can fill.
  const totalBatterSlots = BATTER_POSITIONS.reduce((s, p) => s + (slots[p] || 0), 0);

  const byPos = {};
  for (const pos of BATTER_POSITIONS) {
    // DH/UTIL is fillable by ANY batter, so its pool is the whole batter set and its
    // depth is all batter slots -> a high bar, small premium (least scarce slot). A
    // real position (C, OF, ...) draws only position-eligible players at its own depth.
    const isUtil = pos === 'DH';
    const pool = isUtil ? batters : batters.filter((b) => eligible(b.position).includes(pos));
    const vals = pool.map((b) => b.raw_score).sort((a, b) => b - a);
    const rank = isUtil ? sz * totalBatterSlots : sz * (slots[pos] || 0);
    byPos[pos] = valueAtDepth(vals, rank);
  }

  return { sp, rp, byPos };
}

// A multi-eligible batter is rostered at his scarcest slot, so his replacement is the
// LOWEST replacement among the positions he qualifies for (-> highest VOR).
export function batterReplacement(positionString, byPos) {
  const els = eligible(positionString);
  const repls = els.map((pos) => (pos in byPos ? byPos[pos] : byPos.DH ?? 0));
  return repls.length ? Math.min(...repls) : (byPos.DH ?? 0);
}
