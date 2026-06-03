import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import PositionFilter from '../components/PositionFilter';

const ROSTER_OPTIONS = [
  { label: 'All', value: null },
  { label: 'Mine + FA', value: 'mine+fa' },
  { label: 'Mine', value: 'mine' },
  { label: 'Available', value: 'available' },
  { label: 'Taken', value: 'taken' },
];

// Mirror the ownership + position filtering from PlayerTable so Planning behaves
// identically to Rankings. fantasy_team === 'me' marks the user's own team
// (set in the roster scraper); falsy means free agent.
function applyFilters(players, { rosterFilter, positionFilter }) {
  let d = players;
  if (rosterFilter === 'mine') {
    d = d.filter(r => r.fantasy_team === 'me');
  } else if (rosterFilter === 'available') {
    d = d.filter(r => !r.fantasy_team);
  } else if (rosterFilter === 'taken') {
    d = d.filter(r => r.fantasy_team && r.fantasy_team !== 'me');
  } else if (rosterFilter === 'mine+fa') {
    d = d.filter(r => !r.fantasy_team || r.fantasy_team === 'me');
  }
  if (positionFilter) {
    const POSITION_EXPAND = {
      MI: ['2B', 'SS'],
      CI: ['1B', '3B'],
      DH: ['DH'],
      UTIL: null, // all hitters
    };
    const expanded = POSITION_EXPAND[positionFilter];
    if (expanded === null) {
      d = d.filter(r => r.position && !['SP', 'RP'].includes(r.position.split(',')[0].trim()));
    } else if (expanded) {
      d = d.filter(r => expanded.some(p => r.position?.includes(p)));
    } else {
      d = d.filter(r => r.position?.includes(positionFilter));
    }
  }
  return d;
}

// "2026-06-01" -> "Jun 1"
function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m)]} ${Number(d)}`;
}

function pct(x) {
  if (x == null) return '–';
  return `${Math.round(x * 100)}%`;
}

// One pitcher week: expected starts, two-start highlight, confidence dot.
function PitcherCell({ wk }) {
  if (!wk || wk.games_in_week === 0) {
    return <div className="text-center text-gray-300 text-xs">–</div>;
  }
  const two = wk.two_start === 1;
  const announced = wk.confidence === 'announced';
  return (
    <div className={`text-center rounded py-1 ${two ? 'bg-amber-100' : ''}`}>
      <div className={`text-lg font-semibold tabular-nums ${two ? 'text-amber-700' : 'text-gray-800'}`}>
        {wk.exp_starts ?? 0}
      </div>
      <div className="flex items-center justify-center gap-1 text-[10px] text-gray-400">
        <span
          title={announced ? 'Announced probable' : 'Projected'}
          className={`inline-block w-1.5 h-1.5 rounded-full ${announced ? 'bg-blue-500' : 'border border-gray-400'}`}
        />
        {two ? '2-start' : `${wk.games_in_week}g`}
      </div>
    </div>
  );
}

// One hitter week: expected games started out of team games.
function HitterCell({ wk }) {
  if (!wk || wk.games_in_week === 0) {
    return <div className="text-center text-gray-300 text-xs">–</div>;
  }
  const exp = wk.exp_games ?? 0;
  // Shade by share of team games started.
  const share = wk.games_in_week ? exp / wk.games_in_week : 0;
  const dim = share < 0.5;
  return (
    <div className="text-center py-1">
      <div className={`text-lg font-semibold tabular-nums ${dim ? 'text-gray-400' : 'text-gray-800'}`}>
        {exp.toFixed(1)}
      </div>
      <div className="text-[10px] text-gray-400">of {wk.games_in_week}</div>
    </div>
  );
}

function PlatoonBadge({ player }) {
  if (player.player_type !== 'B') {
    return player.throw_hand ? <span className="text-[10px] text-gray-400">{player.throw_hand}HP</span> : null;
  }
  const w0 = player.weeks[0];
  if (!w0 || w0.vs_lhp_rate == null) return null;
  return (
    <span className="text-[10px] text-gray-400 whitespace-nowrap">
      vL {pct(w0.vs_lhp_rate)} · vR {pct(w0.vs_rhp_rate)}
    </span>
  );
}

export default function Planning() {
  const [data, setData] = useState({ weeks: [], players: [] });
  const [rosterFilter, setRosterFilter] = useState('mine');
  const [posFilter, setPosFilter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch the full player set once; filter client-side like Rankings.
  useEffect(() => {
    setLoading(true);
    setError(null);
    api.getPlanning('all')
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const { weeks } = data;
  const players = useMemo(
    () => applyFilters(data.players, { rosterFilter, positionFilter: posFilter }),
    [data.players, rosterFilter, posFilter]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-xl font-bold text-gray-900">Planning</h1>
        <div className="h-5 w-px bg-gray-300" />
        <PositionFilter value={posFilter} onChange={setPosFilter} />
        <div className="flex items-center gap-1">
          {ROSTER_OPTIONS.map(opt => (
            <button
              key={opt.value ?? 'all'}
              onClick={() => setRosterFilter(opt.value)}
              className={`px-2 py-0.5 text-xs rounded ${rosterFilter === opt.value ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {opt.label}
            </button>
          ))}
        </div>
        <span className="text-sm text-gray-400 ml-auto">{players.length} players</span>
      </div>

      {loading && <div className="p-4 text-gray-500">Loading projections...</div>}
      {error && <div className="p-4 text-red-500 text-sm">Error: {error}</div>}
      {!loading && !error && players.length === 0 && data.players.length === 0 && (
        <div className="p-4 text-gray-500 text-sm">
          No projections yet. Run <span className="font-mono">Refresh Weekly Planning</span> in Settings to fetch the schedule and build them.
        </div>
      )}
      {!loading && !error && players.length === 0 && data.players.length > 0 && (
        <div className="p-4 text-gray-500 text-sm">No players match the current filters.</div>
      )}

      {!loading && !error && players.length > 0 && (
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
          <table className="text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left font-medium text-gray-500 w-10">#</th>
                <th className="sticky left-10 z-10 bg-gray-50 px-3 py-2 text-left font-medium text-gray-500 min-w-[180px]">Player</th>
                {weeks.map(w => (
                  <th key={w.week_index} className="px-3 py-2 text-center font-medium text-gray-500 min-w-[72px]">
                    <div>{shortDate(w.week_start)}</div>
                    <div className="text-[10px] text-gray-400 font-normal">to {shortDate(w.week_end)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {players.map(p => (
                <tr key={p.player_id} className="border-b border-gray-100 hover:bg-blue-50/40">
                  <td className="sticky left-0 z-10 bg-white px-3 py-2 text-gray-400 tabular-nums">{p.rank}</td>
                  <td className="sticky left-10 z-10 bg-white px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900">{p.name}</span>
                      {p.injury && <span className="text-[10px] px-1 rounded bg-red-100 text-red-600">IL</span>}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <span>{p.position} · {p.team}</span>
                      <PlatoonBadge player={p} />
                    </div>
                  </td>
                  {weeks.map(w => {
                    const wk = p.weeks.find(x => x.week_index === w.week_index);
                    return (
                      <td key={w.week_index} className="px-2 py-1 align-middle">
                        {p.player_type === 'P'
                          ? <PitcherCell wk={wk} />
                          : <HitterCell wk={wk} />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
