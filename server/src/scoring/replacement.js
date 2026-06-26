// Value-Over-Replacement baselines, derived entirely from the current projection
// distribution + the league's real roster construction. No hand-tuned constants.
//
// Batter replacement is computed by SIMULATING the league's starting lineups: assign
// the best batters to real lineup slots (each player taking exactly ONE slot,
// respecting multi-position flex slots MI/CI/UTIL), then the replacement level at a
// position = the best UNROSTERED batter still eligible there. This dedupes
// multi-position players (a 2B/SS bat fills one slot, not two) and folds in the flex
// slots, so middle-infield/corner depth is counted correctly. The old C70..DH10 ladder
// and the 237/+215/+71 pitcher floors fall out of the data instead of being guessed.

// ESPN baseball lineupSlotId -> starting-slot capacity per pool.
//   0 C, 1 1B, 2 2B, 3 3B, 4 SS, 5 OF (+8/9/10 LF/CF/RF), 6 MI (2B/SS), 7 CI (1B/3B),
//   11 DH + 12 UTIL (any batter), 13 P + 14 SP (starter capacity), 15 RP.
//   Bench(16)/IL(17) never count (not starting depth). Flex P(13) is starter capacity
//   (points leagues fill it with SP).
export function slotsFromEspn(lineupSlotCounts) {
  const n = (id) => Number(lineupSlotCounts?.[id]) || 0;
  return {
    C: n(0), '1B': n(1), '2B': n(2), '3B': n(3), SS: n(4),
    OF: n(5) + n(8) + n(9) + n(10),
    MI: n(6), CI: n(7),
    UTIL: n(11) + n(12),
    SP: n(13) + n(14),
    RP: n(15),
  };
}

// Sensible default if league settings haven't been scraped yet (real ESPN league 133164).
export const DEFAULT_SLOTS = { C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 5, MI: 1, CI: 1, UTIL: 1, SP: 8, RP: 1 };

const REAL_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'OF'];

// Which batters a slot type can roster, given a batter's eligible-position list.
const SLOT_ELIG = {
  C: (e) => e.includes('C'),
  '1B': (e) => e.includes('1B'),
  '2B': (e) => e.includes('2B'),
  '3B': (e) => e.includes('3B'),
  SS: (e) => e.includes('SS'),
  OF: (e) => e.includes('OF'),
  MI: (e) => e.includes('2B') || e.includes('SS'),
  CI: (e) => e.includes('1B') || e.includes('3B'),
  UTIL: () => true,
};
// Fill scarce dedicated slots first, then the dual-eligible flex slots, then UTIL —
// so a position-locked bat isn't crowded out of his only slot by a flexible one.
const FILL_ORDER = ['C', 'SS', '2B', '3B', '1B', 'OF', 'MI', 'CI', 'UTIL'];

function eligible(positionString) {
  return (positionString || 'DH').split(',').map((s) => s.trim()).filter(Boolean);
}

// Greedy roster fill: best batters claim lineup slots (one each); returns the leftover
// free agents, still sorted best-first. The marginal free agent at a position is its
// replacement level.
function assignStarters(batters, leagueSize, slots) {
  const sz = Number(leagueSize) || 0;
  const remaining = {};
  for (const t of FILL_ORDER) remaining[t] = sz * (slots[t] || 0);

  const ranked = batters
    .map((b) => ({ raw: b.raw_score, elig: eligible(b.position) }))
    .sort((a, b) => b.raw - a.raw);

  const freeAgents = [];
  for (const p of ranked) {
    let placed = false;
    for (const t of FILL_ORDER) {
      if (remaining[t] > 0 && SLOT_ELIG[t](p.elig)) { remaining[t] -= 1; placed = true; break; }
    }
    if (!placed) freeAgents.push(p);
  }
  return freeAgents; // sorted desc by raw
}

// Value at a given roster depth in a descending-sorted pool (used for pitchers). Pool
// thinner than rank -> last available value; empty -> 0.
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

  // Batter replacement = best free agent after the league's starting lineups are filled.
  const freeAgents = assignStarters(batters, sz, slots);
  const byPos = {};
  for (const pos of REAL_POSITIONS) {
    const fa = freeAgents.find((p) => p.elig.includes(pos));
    byPos[pos] = fa ? fa.raw : 0;
  }
  // DH/UTIL bar = best free agent overall (any batter fills UTIL) -> highest bar, least premium.
  byPos.DH = freeAgents.length ? freeAgents[0].raw : 0;

  return { sp, rp, byPos };
}

// A multi-eligible batter is rostered at his scarcest slot, so his replacement is the
// LOWEST replacement among the positions he qualifies for (-> highest VOR).
export function batterReplacement(positionString, byPos) {
  const els = eligible(positionString);
  const repls = els.map((pos) => (pos in byPos ? byPos[pos] : byPos.DH ?? 0));
  return repls.length ? Math.min(...repls) : (byPos.DH ?? 0);
}
