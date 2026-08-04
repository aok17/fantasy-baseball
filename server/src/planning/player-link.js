// Resolve (or create) the players row for an mlbam id discovered in the MLB
// schedule.
//
// Why this exists: players.mlbam_id is only ever stamped on by the Savant /
// statcast scrapers, which cover players who cleared a playing-time threshold
// and whose name matched exactly. Every other player either has no mlbam_id
// (so the planning join `WHERE p.mlbam_id IS NOT NULL` silently drops him) or
// has no players row at all (call-ups, streamers, back-end starters who were
// never in a ranking file). Both cases made the player invisible on the
// Planning tab even though the schedule knows he is starting on Thursday.
//
// Strategy, in order:
//   1. Already mapped by mlbam_id -> use it.
//   2. Exactly one unmapped players row with the same normalized name (and no
//      contradicting team) -> adopt it, backfilling mlbam_id. This reconnects
//      ranked players the scrapers failed to map, so they keep their rank.
//   3. Otherwise insert a new players row from the StatsAPI identity.
// Ambiguous names (two or more unmapped rows) are never adopted — creating a
// duplicate row is a far cheaper mistake than mis-linking two players.

// FanGraphs/ESPN vs StatsAPI team abbreviations disagree for a handful of clubs.
const TEAM_ALIASES = {
  CHW: 'CWS', CWS: 'CWS', KCR: 'KC', KC: 'KC', SDP: 'SD', SD: 'SD',
  SFG: 'SF', SF: 'SF', TBR: 'TB', TB: 'TB', WSN: 'WSH', WSH: 'WSH',
  ARI: 'AZ', AZ: 'AZ', ATH: 'OAK', OAK: 'OAK',
};

export function canonTeam(team) {
  if (!team) return null;
  const t = String(team).trim().toUpperCase();
  return TEAM_ALIASES[t] || t;
}

// Accent/punctuation/suffix-insensitive name key. "José Ramírez Jr." -> "jose ramirez".
export function normalizeName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'`]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// excludeIds: players.id values that must never be adopted (e.g. rows known to
// be position players when we're only resolving pitchers).
export function createPlayerLinker(db, { excludeIds = new Set() } = {}) {
  const byMlbam = new Map(
    db.prepare('SELECT id, mlbam_id FROM players WHERE mlbam_id IS NOT NULL').all()
      .map(r => [String(r.mlbam_id), r.id])
  );

  // Adoption candidates: rows the scrapers never managed to map. null value
  // marks an ambiguous key (more than one candidate) -> never adopt.
  const unmapped = new Map(); // normName -> { id, team } | null
  for (const r of db.prepare('SELECT id, name, team FROM players WHERE mlbam_id IS NULL').all()) {
    if (excludeIds.has(r.id)) continue;
    const k = normalizeName(r.name);
    if (!k) continue;
    unmapped.set(k, unmapped.has(k) ? null : { id: r.id, team: r.team });
  }

  const setMlbam = db.prepare('UPDATE players SET mlbam_id = ? WHERE id = ? AND mlbam_id IS NULL');
  const insert = db.prepare('INSERT INTO players (name, team, mlbam_id) VALUES (?, ?, ?)');
  const findExact = db.prepare('SELECT id, mlbam_id FROM players WHERE name = ? AND team IS ?');

  const stats = { adopted: 0, created: 0 };

  const claim = (key, row) => {
    if (!row || excludeIds.has(row.id) || row.mlbam_id != null) return null;
    if (!setMlbam.run(key, row.id).changes) return null;
    byMlbam.set(key, row.id);
    stats.adopted++;
    return row.id;
  };

  return {
    stats,
    get(mlbam) { return byMlbam.get(String(mlbam)) ?? null; },

    // Returns a players.id for this mlbam id, creating/adopting a row if needed.
    // null only when every candidate slot is occupied by a row we must not touch.
    ensure(mlbam, { name = null, team = null } = {}) {
      const key = String(mlbam);
      const known = byMlbam.get(key);
      if (known) return known;

      // 1. Adopt the one unmapped row with this normalized name, unless the two
      //    sides both claim a team and those teams disagree.
      const nk = normalizeName(name);
      const cand = nk ? unmapped.get(nk) : null;
      if (cand) {
        const a = canonTeam(cand.team);
        const b = canonTeam(team);
        if (!a || !b || a === b) {
          const id = claim(key, { id: cand.id, mlbam_id: null });
          if (id) { unmapped.delete(nk); return id; }
        }
      }

      // 2. Insert a fresh row. UNIQUE(name, team) can collide with a row step 1
      //    rejected (ambiguous name, excluded id); claim it when that is safe,
      //    otherwise retry team-less rather than hijacking someone else's row.
      const label = name || `MLB ${key}`;
      for (const t of (team ? [team, null] : [null])) {
        const clash = findExact.get(label, t);
        if (clash) {
          const id = claim(key, clash);
          if (id) return id;
          continue;
        }
        const id = Number(insert.run(label, t, key).lastInsertRowid);
        stats.created++;
        byMlbam.set(key, id);
        return id;
      }
      return null;
    },
  };
}
