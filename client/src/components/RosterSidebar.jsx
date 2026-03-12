export default function RosterSidebar({ picks, rankings }) {
  const myPicks = picks.filter(p => p.drafted_by === 'me');
  const grouped = {};
  for (const pick of myPicks) {
    const player = rankings.find(r => r.name === pick.player_name);
    const pos = player?.position || 'Unknown';
    if (!grouped[pos]) grouped[pos] = [];
    grouped[pos].push({ ...pick, position: pos });
  }

  return (
    <div className="w-56 border-l bg-white p-3 overflow-auto max-h-[80vh]">
      <h3 className="font-bold text-sm mb-2">My Roster ({myPicks.length})</h3>
      {Object.entries(grouped).sort().map(([pos, players]) => (
        <div key={pos} className="mb-2">
          <div className="text-xs font-semibold text-gray-500 uppercase">{pos}</div>
          {players.map(p => (
            <div key={p.id} className="text-sm">#{p.pick_number} {p.player_name}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
