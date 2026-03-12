export function convertLastFirst(name) {
  const commaIdx = name.indexOf(',');
  if (commaIdx === -1) return name;
  const last = name.substring(0, commaIdx).trim();
  const first = name.substring(commaIdx + 1).trim();
  return `${first} ${last}`;
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
