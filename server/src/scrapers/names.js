export function convertLastFirst(name) {
  const commaIdx = name.indexOf(',');
  if (commaIdx === -1) return name;
  const last = name.substring(0, commaIdx).trim();
  const first = name.substring(commaIdx + 1).trim();
  return `${first} ${last}`;
}

function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function reconcileName(name, replacements) {
  return replacements[name] || name;
}

export function loadReplacements(db) {
  const rows = db.prepare('SELECT alt_name, canonical_name FROM name_replacements').all();
  const map = {};
  for (const r of rows) map[r.alt_name] = r.canonical_name;
  return map;
}

/**
 * Build a map from accent-stripped names to canonical (accented) names
 * using the batters_raw + pitchers_raw tables as the canonical source.
 */
export function buildAccentMap(db) {
  const map = {};
  for (const table of ['batters_raw', 'pitchers_raw']) {
    const rows = db.prepare(`SELECT DISTINCT name FROM ${table}`).all();
    for (const r of rows) {
      const stripped = stripAccents(r.name);
      if (stripped !== r.name) {
        map[stripped] = r.name;
      }
    }
  }
  return map;
}
