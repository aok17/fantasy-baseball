import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import PlayerTable from '../components/PlayerTable';
import PositionFilter from '../components/PositionFilter';
import SearchBar from '../components/SearchBar';

const RANK_OPTIONS = [100, 250, 500, 1000, null];

export default function Rankings() {
  const [players, setPlayers] = useState([]);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState(null);
  const [rankLimit, setRankLimit] = useState(1000);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getRankings().then(setPlayers).finally(() => setLoading(false));
  }, []);

  const handleNoteChange = useCallback((playerId, note) => {
    api.updatePlayerNote(playerId, note);
    setPlayers(prev => prev.map(p => p.player_id === playerId ? { ...p, note } : p));
  }, []);

  if (loading) return <div className="p-4 text-gray-500">Loading rankings...</div>;

  const displayCount = rankLimit ? Math.min(players.length, rankLimit) : players.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-xl font-bold text-gray-900">Rankings</h1>
        <div className="h-5 w-px bg-gray-300" />
        <SearchBar value={search} onChange={setSearch} />
        <PositionFilter value={posFilter} onChange={setPosFilter} />
        <div className="flex items-center gap-1 ml-2">
          <span className="text-xs text-gray-500">Top:</span>
          {RANK_OPTIONS.map(opt => (
            <button
              key={opt ?? 'all'}
              onClick={() => setRankLimit(opt)}
              className={`px-2 py-0.5 text-xs rounded ${rankLimit === opt ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {opt ?? 'All'}
            </button>
          ))}
        </div>
        <span className="text-sm text-gray-400 ml-auto">{displayCount} players</span>
      </div>
      <PlayerTable data={players} globalFilter={search} positionFilter={posFilter} rankLimit={rankLimit} onNoteChange={handleNoteChange} />
    </div>
  );
}
