const ROSTER_SLOTS = {
  C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 3, UTIL: 1, SP: 5, RP: 3,
};

function getPositionNeeds(myPicks, rankings) {
  const filled = {};
  for (const pick of myPicks) {
    const player = rankings.find(r => r.name === pick.player_name);
    if (!player?.position) continue;
    const pos = player.position.split(',')[0].trim();
    // Map display positions to roster slots
    const slot = pos === 'SP, RP' ? 'SP' : pos;
    filled[slot] = (filled[slot] || 0) + 1;
  }

  const needs = [];
  for (const [pos, count] of Object.entries(ROSTER_SLOTS)) {
    const have = filled[pos] || 0;
    const remaining = count - have;
    if (remaining > 0) {
      for (let i = 0; i < remaining; i++) needs.push(pos);
    }
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
