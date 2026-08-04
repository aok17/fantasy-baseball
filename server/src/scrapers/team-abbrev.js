// One place for club abbreviations, because every feed spells them differently
// and players.team is keyed on the FanGraphs style that seeded the database.
// rescore() links raw rows to players by `name|team`, so a mismatch here
// silently orphans a whole club.
//
//   Razzball  : KC  SD  SF  TB  WSH            (ARI and CHW already match)
//   StatsAPI  : KC  SD  SF  TB  WSH  AZ  CWS  ATH
//   players   : KCR SDP SFG TBR WSN  ARI CHW  ATH
const TO_FANGRAPHS = {
  KC: 'KCR', SD: 'SDP', SF: 'SFG', TB: 'TBR', WSH: 'WSN',
  AZ: 'ARI', CWS: 'CHW',
  // Already canonical, listed so the map doubles as documentation.
  KCR: 'KCR', SDP: 'SDP', SFG: 'SFG', TBR: 'TBR', WSN: 'WSN',
  ARI: 'ARI', CHW: 'CHW', ATH: 'ATH', OAK: 'ATH',
};

// Feed abbreviation -> the abbreviation used in players.team.
// Returns null for "no club" (free agents), which is distinct from "unknown".
export function toFgAbbrev(abbr) {
  const s = String(abbr ?? '').trim().toUpperCase();
  if (!s || s === 'FA' || s === '-' || s === '--') return null;
  return TO_FANGRAPHS[s] || s;
}
