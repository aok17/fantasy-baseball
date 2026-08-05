// Rotation-turn projection engine. Pure: schedule + start history in, per-game
// starter assignments out. No DB, no network.
//
// Handles: 5- vs 6-man rotations (inferred), openers (don't claim a slot),
// skipped starters (queue re-aligns by who's most "due"), announced-probable
// anchoring + re-sync, and IL removal.

const MAX_CYCLE_LOOKBACK = 12; // don't read cadence from more than ~2 turns of history
const MIN_ROTATION = 4;
const MAX_ROTATION = 6;

// Infer the active rotation for one team from its recent non-opener starts.
// pastStarts: [{ game_date, sp_mlbam }] in ANY order; we sort descending here.
// Returns { members: [{ mlbam, lastStart }], size } ordered by lastStart asc (most due first).
//
// Method: cadence/cycle detection. Walk the most recent starts and add distinct
// starters until the first one repeats — that repeat marks one full turn through
// the rotation, so the distinct starters before it ARE the active rotation and
// their count IS the rotation size. This reads the actual turn instead of
// counting distinct names over a fixed window. Counting over-estimates badly:
// any spot start, call-up, or 6th-starter cameo in the window inflates the size
// (empirically that pushed ~80% of MLB teams to a phantom 6-man rotation, which
// spreads the turn so legit two-start weeks vanish). Off-days, demotions, and
// stale spot starters don't corrupt cadence detection because it's ordinal.
export function inferRotation(pastStarts, { openerIds = new Set(), injured = new Set(), rotationSizeDefault = 5 } = {}) {
  // Most-recent first. Drop openers and injured up front: an injured starter's
  // slot is already being taken by whoever replaced him, so his old starts
  // should not anchor the cadence.
  const sorted = [...pastStarts]
    .filter(s => s.sp_mlbam && !openerIds.has(s.sp_mlbam) && !injured.has(s.sp_mlbam))
    .sort((a, b) => (a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : 0));

  // Walk recent starts until a pitcher repeats (one completed turn).
  const lastStart = new Map(); // mlbam -> most recent start date; insertion order = recency
  for (const s of sorted.slice(0, MAX_CYCLE_LOOKBACK)) {
    if (lastStart.has(s.sp_mlbam)) break; // first repeat -> full turn seen
    lastStart.set(s.sp_mlbam, s.game_date);
  }

  let members = [...lastStart.entries()].map(([mlbam, ls]) => ({ mlbam, lastStart: ls }));

  // Guard rail: if the cadence signal is too thin (early season, or a
  // doubleheader caused an early repeat), backfill with the next most-recent
  // distinct starters up to the default size.
  if (members.length < MIN_ROTATION) {
    const seen = new Set(members.map(m => m.mlbam));
    for (const s of sorted) {
      if (members.length >= rotationSizeDefault) break;
      if (seen.has(s.sp_mlbam)) continue;
      seen.add(s.sp_mlbam);
      members.push({ mlbam: s.sp_mlbam, lastStart: s.game_date });
    }
  }
  if (members.length > MAX_ROTATION) members = members.slice(0, MAX_ROTATION);

  // Order by who is most "due" next = oldest lastStart first.
  members.sort((a, b) => (a.lastStart < b.lastStart ? -1 : a.lastStart > b.lastStart ? 1 : 0));
  return { members, size: members.length };
}

// Roll the rotation forward over one team's future games.
// futureGames: [{ game_pk, game_date, announced_sp }] (announced_sp = mlbam or null), date order.
// Returns [{ game_pk, game_date, sp_mlbam, confidence }]; sp_mlbam null if unprojectable (bullpen game).
// opts.departed: pitchers who have since moved to another club. They are removed
// AFTER the rotation is inferred, never before — dropping their starts from the
// history would corrupt the cadence walk and shrink the detected rotation size,
// the same way a missing rain-shortened game did. Without this a traded pitcher
// stays in his old club's queue while also joining his new one, and the two
// clubs' schedules stack: Dean Kremer drew three starts in a single week, one of
// them against Baltimore, the team he was still listed on.
export function projectTeamRotation(pastStarts, futureGames, opts = {}) {
  const { openerIds = new Set(), injured = new Set(), rotationSizeDefault = 5, departed = new Set() } = opts;
  const { members } = inferRotation(pastStarts, { openerIds, injured, rotationSizeDefault });

  // Mutable queue of { mlbam, lastStart }; "most due" = smallest lastStart.
  const queue = members.filter(m => !departed.has(m.mlbam)).map(m => ({ ...m }));

  // No starter goes on fewer than three days' rest. Without this the queue is
  // the only limit, so a rotation thinned by injuries or trades cycles fast
  // enough to hand one arm three starts in a week — Landen Roupp drew three in
  // the Aug 24 week. A four-day minimum gap caps any seven-day span at two.
  const MIN_REST_DAYS = 3;
  const daysBetween = (a, b) =>
    Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

  const pickNextDue = (gameDate) => {
    // queue is kept sorted asc by lastStart; first eligible is most due.
    for (let i = 0; i < queue.length; i++) {
      const q = queue[i];
      if (injured.has(q.mlbam)) continue;
      if (q.lastStart && daysBetween(q.lastStart, gameDate) <= MIN_REST_DAYS) continue;
      return q;
    }
    return null;
  };

  const resort = () => queue.sort((a, b) => (a.lastStart < b.lastStart ? -1 : a.lastStart > b.lastStart ? 1 : 0));

  const games = [...futureGames].sort((a, b) =>
    a.game_date < b.game_date ? -1 : a.game_date > b.game_date ? 1 : 0
  );

  const out = [];
  for (const g of games) {
    const announced = g.announced_sp && !injured.has(g.announced_sp) ? g.announced_sp : null;

    if (announced) {
      out.push({ game_pk: g.game_pk, game_date: g.game_date, sp_mlbam: announced, confidence: 'announced' });
      if (openerIds.has(announced)) continue; // opener doesn't advance the rotation turn
      // Re-sync: this pitcher just went; make him least-due. Add if not present.
      let m = queue.find(q => q.mlbam === announced);
      if (!m) { m = { mlbam: announced, lastStart: g.game_date }; queue.push(m); }
      else m.lastStart = g.game_date;
      resort();
      continue;
    }

    const due = pickNextDue(g.game_date);
    if (!due) {
      out.push({ game_pk: g.game_pk, game_date: g.game_date, sp_mlbam: null, confidence: 'projected' });
      continue;
    }
    out.push({ game_pk: g.game_pk, game_date: g.game_date, sp_mlbam: due.mlbam, confidence: 'projected' });
    due.lastStart = g.game_date; // he just pitched -> back of the line
    resort();
  }
  return out;
}
