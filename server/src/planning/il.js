// Build per-player injured-list (IL) intervals from MLB transaction events, so
// the batter playing-time model can EXCLUDE games a player missed due to injury
// (an IL day is not a "rest" day — counting it as a non-start wrongly drags the
// start rate down, badly so right after a player returns since recent games are
// weighted heaviest). Pure: transaction events in, intervals out. No network.

// "... retroactive to April 1" -> 'YYYY-MM-DD' using the event's year. Falls
// back to the event date when there's no retroactive clause.
function effectiveStart(event) {
  const m = /retroactive to ([A-Z][a-z]+\.?\s+\d{1,2})/.exec(event.description || '');
  if (m) {
    const d = new Date(`${m[1].replace('.', '')}, ${event.date.slice(0, 4)}`);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return event.date;
}

// events: [{ mlbam, date: 'YYYY-MM-DD', description }] (any order).
// Returns Map<mlbam, [{ start, end }]> where end is exclusive and null means
// "still on the IL" (open-ended).
export function buildIlIntervals(events) {
  const sorted = [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const openStart = new Map();  // mlbam -> start date of the currently-open stint
  const intervals = new Map();  // mlbam -> [{ start, end }]
  const push = (mlbam, iv) => {
    if (!intervals.has(mlbam)) intervals.set(mlbam, []);
    intervals.get(mlbam).push(iv);
  };

  for (const e of sorted) {
    const desc = e.description || '';
    const placed = /placed\b.*\bon the\b.*\binjured list\b/i.test(desc);
    const activated = /(activated|reinstated)\b.*\bfrom the\b.*\binjured list\b/i.test(desc);
    if (placed) {
      // Ignore a re-placement (e.g. transfer 10-day -> 60-day) while already open.
      if (!openStart.has(e.mlbam)) openStart.set(e.mlbam, effectiveStart(e));
    } else if (activated) {
      if (openStart.has(e.mlbam)) {
        push(e.mlbam, { start: openStart.get(e.mlbam), end: e.date });
        openStart.delete(e.mlbam);
      }
    }
  }
  // Stints with no activation yet are still ongoing.
  for (const [mlbam, start] of openStart) push(mlbam, { start, end: null });
  return intervals;
}

// Was this player on the IL on the given game date? end is exclusive: a player
// activated on date D is available to start D's game.
export function isOnIl(intervals, mlbam, date) {
  const ivs = intervals.get(String(mlbam));
  if (!ivs) return false;
  for (const iv of ivs) {
    if (date >= iv.start && (iv.end == null || date < iv.end)) return true;
  }
  return false;
}
