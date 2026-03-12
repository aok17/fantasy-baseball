import { useState, useEffect } from 'react';
import { api } from '../api';
import PlayerTable from '../components/PlayerTable';
import PositionFilter from '../components/PositionFilter';
import SearchBar from '../components/SearchBar';

export default function Rankings() {
  const [players, setPlayers] = useState([]);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getRankings().then(setPlayers).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-4 text-gray-500">Loading rankings...</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold">Rankings</h1>
        <SearchBar value={search} onChange={setSearch} />
        <PositionFilter value={posFilter} onChange={setPosFilter} />
      </div>
      <PlayerTable data={players} globalFilter={search} positionFilter={posFilter} />
    </div>
  );
}
