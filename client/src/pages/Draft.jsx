import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import PlayerTable from '../components/PlayerTable';
import PositionFilter from '../components/PositionFilter';
import SearchBar from '../components/SearchBar';
import SessionSelector from '../components/SessionSelector';
import RosterSidebar from '../components/RosterSidebar';

function SyncStatusBar({ sessionId }) {
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!sessionId) return;
    const poll = () => api.getSyncStatus(sessionId).then(setStatus).catch(() => {});
    poll();
    intervalRef.current = setInterval(poll, 3000);
    return () => clearInterval(intervalRef.current);
  }, [sessionId]);

  const handleStart = async () => {
    setSyncing(true);
    try {
      const result = await api.startSync(sessionId);
      setStatus(result);
    } catch (e) {
      setStatus({ connected: false, error: e.message });
    }
    setSyncing(false);
  };

  const handleStop = async () => {
    await api.stopSync(sessionId);
    setStatus({ connected: false, pickCount: 0, lastPick: null, onTheClock: null, error: null });
  };

  if (!status) return null;

  return (
    <div className="flex items-center gap-3 text-xs px-3 py-1.5 bg-gray-50 border border-gray-200 rounded">
      <span className={`inline-block w-2 h-2 rounded-full ${status.connected ? 'bg-green-500' : status.error ? 'bg-red-500' : 'bg-gray-400'}`} />
      {status.connected ? (
        <>
          <span className="text-green-700 font-medium">ESPN Sync Active</span>
          <span className="text-gray-500">Picks: {status.pickCount}</span>
          {status.onTheClock && (
            <span className="text-amber-600 font-medium">On clock: {status.onTheClock.team}</span>
          )}
          {status.lastPick && (
            <span className="text-gray-500">Last: {status.lastPick.player_name} &rarr; {status.lastPick.drafted_by}</span>
          )}
          <button onClick={handleStop} className="text-red-500 hover:text-red-700 ml-auto">Stop</button>
        </>
      ) : (
        <>
          <span className="text-gray-500">{status.error ? `Error: ${status.error}` : 'ESPN Sync Off'}</span>
          <button onClick={handleStart} disabled={syncing}
            className="text-blue-600 hover:text-blue-800 ml-auto disabled:opacity-50">
            {syncing ? 'Connecting...' : 'Start Sync'}
          </button>
        </>
      )}
    </div>
  );
}

export default function Draft() {
  const [rankings, setRankings] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [picks, setPicks] = useState([]);
  const [search, setSearch] = useState('');
  const [posFilter, setPosFilter] = useState(null);
  const [hideTaken, setHideTaken] = useState(true);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef(null);

  useEffect(() => {
    Promise.all([api.getRankings(), api.getDraftSessions()]).then(([r, s]) => {
      setRankings(r);
      setSessions(s);
      if (s.length > 0) setActiveSession(s[0].id);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!activeSession) return;
    const poll = () => api.getDraftPicks(activeSession).then(setPicks);
    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
  }, [activeSession]);

  const takenNames = new Set(picks.map(p => p.player_name));
  const nextPick = picks.length > 0 ? Math.max(...picks.map(p => p.pick_number)) + 1 : 1;

  const displayData = hideTaken ? rankings.filter(r => !takenNames.has(r.name)) : rankings.map(r => ({
    ...r, _taken: takenNames.has(r.name),
  }));

  const handleNoteChange = useCallback((name, note) => {
    api.updatePlayerNote(name, note);
    setRankings(prev => prev.map(p => p.name === name ? { ...p, note } : p));
  }, []);

  const handleDraft = useCallback(async (player) => {
    if (!activeSession) return;
    const result = window.prompt(`Who drafted ${player.name}? (leave blank for "me")`);
    if (result === null) return;
    const drafted_by = result || 'me';
    await api.createDraftPick(activeSession, {
      player_name: player.name,
      pick_number: nextPick,
      drafted_by,
    });
    setPicks(await api.getDraftPicks(activeSession));
  }, [activeSession, nextPick]);

  const handleCreateSession = async (name) => {
    const s = await api.createDraftSession(name);
    setSessions(prev => [{ ...s, created_at: new Date().toISOString() }, ...prev]);
    setActiveSession(s.id);
  };

  if (loading) return <div className="p-4 text-gray-500">Loading...</div>;

  return (
    <div className="flex">
      <div className="flex-1 space-y-4">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-xl font-bold text-gray-900">Draft</h1>
          <div className="h-5 w-px bg-gray-300" />
          <SessionSelector sessions={sessions} activeId={activeSession}
            onSelect={setActiveSession} onCreate={handleCreateSession} />
          <SearchBar value={search} onChange={setSearch} />
          <PositionFilter value={posFilter} onChange={setPosFilter} />
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={hideTaken} onChange={e => setHideTaken(e.target.checked)} />
            Hide taken
          </label>
          <span className="text-sm text-gray-500">Next pick: #{nextPick}</span>
        </div>
        <SyncStatusBar sessionId={activeSession} />
        <PlayerTable data={displayData} globalFilter={search} positionFilter={posFilter}
          onRowClick={handleDraft} onNoteChange={handleNoteChange}
          rowClassName={r => r._taken ? 'opacity-40 line-through' : ''} />
      </div>
      <RosterSidebar picks={picks} rankings={rankings} />
    </div>
  );
}
