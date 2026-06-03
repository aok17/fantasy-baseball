// Pure date math for fantasy-week bucketing. No DB, no network.

const DOW = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

// Parse 'YYYY-MM-DD' to a UTC-midnight Date (avoids local-tz drift).
export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000);
}

// Produce numWeeks consecutive fantasy weeks starting with the week that contains `today`.
// weekStartDay: 'monday' (default) etc. Returns [{ week_index, start, end }] with inclusive dates.
export function weekBoundaries(today, weekStartDay = 'monday', numWeeks = 4) {
  const startDow = DOW[String(weekStartDay).toLowerCase()] ?? 1;
  const todayDate = parseDate(today);
  const todayDow = todayDate.getUTCDay();
  const daysSinceStart = (todayDow - startDow + 7) % 7;
  const week0Start = addDays(todayDate, -daysSinceStart);

  const weeks = [];
  for (let i = 0; i < numWeeks; i++) {
    const start = addDays(week0Start, i * 7);
    const end = addDays(start, 6);
    weeks.push({ week_index: i, start: formatDate(start), end: formatDate(end) });
  }
  return weeks;
}

// Group games into weeks by game_date (inclusive). Games outside the window are dropped.
// games: [{ game_date, ... }]. Returns Map<week_index, game[]>.
export function bucketGamesByWeek(games, boundaries) {
  const buckets = new Map();
  for (const w of boundaries) buckets.set(w.week_index, []);
  for (const g of games) {
    for (const w of boundaries) {
      if (g.game_date >= w.start && g.game_date <= w.end) {
        buckets.get(w.week_index).push(g);
        break;
      }
    }
  }
  return buckets;
}
