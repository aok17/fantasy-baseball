const ROSTER_SLOTS = {
  C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 5,
  MI: 1, CI: 1, UTIL: 1, P: 8, RP: 1,
};

// Maps a player's primary position to which roster slots it can fill, in priority order.
const SLOT_ORDER = {
  C: ['C', 'UTIL'],
  '1B': ['1B', 'CI', 'UTIL'],
  '2B': ['2B', 'MI', 'UTIL'],
  '3B': ['3B', 'CI', 'UTIL'],
  SS: ['SS', 'MI', 'UTIL'],
  OF: ['OF', 'UTIL'],
  DH: ['UTIL'],
  SP: ['P'],
  RP: ['P', 'RP'],
};

function getPositionNeeds(myPicks, rankings) {
  const remaining = {};
  for (const [pos, count] of Object.entries(ROSTER_SLOTS)) {
    remaining[pos] = count;
  }

  for (const pick of myPicks) {
    const player = rankings.find(r => r.name === pick.player_name);
    if (!player?.position) continue;
    const pos = player.position.split(',')[0].trim();
    const slots = SLOT_ORDER[pos] || ['UTIL'];
    // Fill the first available slot
    for (const slot of slots) {
      if (remaining[slot] > 0) {
        remaining[slot]--;
        break;
      }
    }
  }

  const needs = [];
  for (const [pos, left] of Object.entries(remaining)) {
    for (let i = 0; i < left; i++) needs.push(pos);
  }
  return needs;
}

export default function RosterSidebar({ picks, rankings }) {
  const myPicks = picks.filter(p => p.drafted_by === 'me');

  const byPosition = {};
  for (const pick of myPicks) {
    const player = rankings.find(r => r.name === pick.player_name);
    const pos = player?.position?.split(',')[0]?.trim() || '?';
    if (!byPosition[pos]) byPosition[pos] = [];
    byPosition[pos].push(pick);
  }

  const needs = getPositionNeeds(myPicks, rankings);

  return (
    <div className="w-56 ml-4 border-l border-gray-200 pl-4">
      <h3 className="font-semibold text-sm text-gray-700 mb-2">My Roster ({myPicks.length})</h3>
      {needs.length > 0 && (
        <div className="mb-3 p-2 bg-amber-50 border border-amber-200 rounded text-xs">
          <span className="font-semibold text-amber-700">Need: </span>
          <span className="text-amber-600">{needs.join(', ')}</span>
        </div>
      )}
      {Object.entries(byPosition).map(([pos, positionPicks]) => (
        <div key={pos} className="mb-2">
          <div className="text-xs font-bold text-gray-500 uppercase">{pos}</div>
          {positionPicks.map(p => (
            <div key={p.id} className="text-sm text-gray-700 truncate">
              #{p.pick_number} {p.player_name}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
