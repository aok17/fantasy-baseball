import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import PositionFilter from '../components/PositionFilter';
import { StartLine, MatchupLegend } from '../components/Matchup';

const ROSTER_OPTIONS = [
  { label: 'All', value: null },
  { label: 'Mine + FA', value: 'mine+fa' },
  { label: 'Mine', value: 'mine' },
  { label: 'Available', value: 'available' },
  { label: 'Taken', value: 'taken' },
];

const TYPE_OPTIONS = [
  { label: 'All', value: null },
  { label: 'Pitchers', value: 'P' },
  { label: 'Hitters', value: 'B' },
];

const LIMIT_OPTIONS = [100, 250, 500, null];

// Row cap so a several-hundred-row pitcher pool stays responsive.
const DEFAULT_LIMIT = 250;

const HITTER_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'OF', 'MI', 'CI', 'UTIL', 'DH'];

// A week counts as a two-start week if the projection flagged it, if two starts
// were actually scheduled, or if the expected-start count rounds to 2.
export function isTwoStart(wk) {
  if (!wk || wk.games_in_week === 0) return false;
  if (wk.two_start === 1) return true;
  if ((wk.starts?.length ?? 0) >= 2) return true;
  return (wk.exp_starts ?? 0) >= 2;
}

// Mirror the ownership + position filtering from PlayerTable so Planning behaves
// identically to Rankings. fantasy_team === 'me' marks the user's own team
// (set in the roster scraper); falsy means free agent.
function applyFilters(players, { rosterFilter, positionFilter, typeFilter, twoStartWeek }) {
  let d = players || [];
  if (rosterFilter === 'mine') {
    d = d.filter(r => r.fantasy_team === 'me');
  } else if (rosterFilter === 'available') {
    d = d.filter(r => !r.fantasy_team);
  } else if (rosterFilter === 'taken') {
    d = d.filter(r => r.fantasy_team && r.fantasy_team !== 'me');
  } else if (rosterFilter === 'mine+fa') {
    d = d.filter(r => !r.fantasy_team || r.fantasy_team === 'me');
  }
  if (typeFilter) {
    d = d.filter(r => r.player_type === typeFilter);
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
  if (twoStartWeek != null) {
    // Only pitchers can have two-start weeks.
    d = d.filter(r => {
      if (r.player_type !== 'P') return false;
      const weeks = r.weeks || [];
      if (twoStartWeek === 'any') return weeks.some(isTwoStart);
      return weeks.some(w => w.week_index === twoStartWeek && isTwoStart(w));
    });
  }
  // Rank can be null for newly surfaced streamers — keep them, but at the bottom.
  // Ties keep the server's order (it breaks unranked ties by total starts).
  return [...d].sort((a, b) => {
    const ra = a.rank == null ? Infinity : a.rank;
    const rb = b.rank == null ? Infinity : b.rank;
    return ra === rb ? 0 : ra - rb;
  });
}

// Row shading by who holds the player. fantasy_team === 'me' is the user's own
// team (set by the roster scraper); falsy means nobody has him. Colour alone
// isn't enough, so each row also carries a left accent bar and taken players
// show the rostering team's name.
const OWNERSHIP = {
  mine: { row: 'bg-emerald-50', accent: 'border-l-emerald-400', swatch: 'bg-emerald-100 border-emerald-400', label: 'Mine' },
  taken: { row: 'bg-gray-100', accent: 'border-l-gray-300', swatch: 'bg-gray-100 border-gray-300', label: 'Rostered elsewhere' },
  fa: { row: 'bg-white', accent: 'border-l-sky-300', swatch: 'bg-white border-sky-300', label: 'Free agent' },
};

function ownershipOf(p) {
  if (p.fantasy_team === 'me') return 'mine';
  if (p.fantasy_team) return 'taken';
  return 'fa';
}

function OwnershipLegend() {
  return (
    <div className="flex items-center gap-3 text-[11px] text-gray-500 px-1">
      <span className="font-medium text-gray-600">Roster status</span>
      {['mine', 'fa', 'taken'].map(k => (
        <span key={k} className="flex items-center gap-1">
          <span className={`inline-block w-4 h-3 rounded-sm border-l-4 ${OWNERSHIP[k].swatch}`} />
          {OWNERSHIP[k].label}
        </span>
      ))}
    </div>
  );
}

// "2026-06-01" -> "Jun 1"
function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m)]} ${Number(d)}`;
}

function weekLabel(w) {
  return `${shortDate(w.week_start)} – ${shortDate(w.week_end)}`;
}

function pct(x) {
  if (x == null) return '–';
  return `${Math.round(x * 100)}%`;
}

// One pitcher week: expected starts, two-start highlight, confidence dot, and
// one line per projected start showing the opponent and its offense rank.
function PitcherCell({ wk, showMatchups }) {
  if (!wk || wk.games_in_week === 0) {
    return <div className="text-center text-gray-300 text-xs">–</div>;
  }
  const two = isTwoStart(wk);
  const announced = wk.confidence === 'announced';
  const starts = showMatchups && Array.isArray(wk.starts) ? wk.starts : [];
  return (
    <div className={`rounded py-1 px-0.5 ${two ? 'bg-amber-100' : ''}`}>
      <div className="flex items-center justify-center gap-1">
        <span className={`text-base leading-tight font-semibold tabular-nums ${two ? 'text-amber-700' : 'text-gray-800'}`}>
          {wk.exp_starts ?? 0}
        </span>
        <span
          title={announced ? 'Announced probable' : 'Projected'}
          className={`inline-block w-1.5 h-1.5 rounded-full ${announced ? 'bg-blue-500' : 'border border-gray-400'}`}
        />
        <span className="text-[10px] text-gray-400" title={`${wk.games_in_week} team games this week`}>
          {two ? '2-start' : `${wk.games_in_week}g`}
        </span>
      </div>
      {starts.length > 0 && (
        <div className="mt-0.5 space-y-0.5">
          {starts.map((s, i) => (
            <StartLine key={s.game_pk ?? s.game_date ?? i} start={s} />
          ))}
        </div>
      )}
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
  const w0 = player.weeks?.[0];
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
  const [typeFilter, setTypeFilter] = useState(null);
  const [twoStartWeek, setTwoStartWeek] = useState(null); // null | 'any' | week_index
  const [showMatchups, setShowMatchups] = useState(true);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch the full player set once; filter client-side like Rankings.
  useEffect(() => {
    setLoading(true);
    setError(null);
    api.getPlanning('all')
      .then(d => setData({ weeks: d?.weeks || [], players: d?.players || [] }))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const weeks = data.weeks;

  // Switching into a pitcher-focused view widens the pool (streamers live in
  // free agency) and pre-selects SP so the grid is immediately useful.
  function selectType(value) {
    setTypeFilter(value);
    if (value === 'P') {
      if (!posFilter || HITTER_POSITIONS.includes(posFilter)) setPosFilter('SP');
      if (rosterFilter === 'mine') setRosterFilter('mine+fa');
    } else {
      if (posFilter === 'SP' || posFilter === 'RP') setPosFilter(null);
      // A two-start filter only ever matches pitchers, so drop it when leaving.
      setTwoStartWeek(null);
    }
  }

  // Choosing a two-start week only makes sense in a pitcher view.
  function selectTwoStartWeek(value) {
    setTwoStartWeek(value);
    if (value != null && typeFilter !== 'P') selectType('P');
  }

  const players = useMemo(
    () => applyFilters(data.players, { rosterFilter, positionFilter: posFilter, typeFilter, twoStartWeek }),
    [data.players, rosterFilter, posFilter, typeFilter, twoStartWeek]
  );

  const shown = useMemo(() => (limit ? players.slice(0, limit) : players), [players, limit]);
  const truncated = players.length - shown.length;
  // Only explain the matchup colors when there is matchup data to explain.
  const hasMatchups = useMemo(
    () => shown.some(p => p.player_type === 'P' && p.weeks?.some(w => w.starts?.length > 0)),
    [shown]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-xl font-bold text-gray-900">Planning</h1>
        <div className="h-5 w-px bg-gray-300" />
        <div className="flex items-center gap-1">
          {TYPE_OPTIONS.map(opt => (
            <button
              key={opt.value ?? 'all'}
              onClick={() => selectType(opt.value)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md ${typeFilter === opt.value ? 'bg-emerald-600 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {opt.label}
            </button>
          ))}
        </div>
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
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-1.5 text-xs text-gray-600">
          <span className="font-medium">2-start week</span>
          <select
            value={twoStartWeek == null ? '' : String(twoStartWeek)}
            onChange={e => {
              const v = e.target.value;
              selectTwoStartWeek(v === '' ? null : v === 'any' ? 'any' : Number(v));
            }}
            className={`px-2 py-1 text-xs border rounded bg-white focus:outline-none focus:border-blue-400 ${twoStartWeek != null ? 'border-blue-500 text-blue-700 font-medium bg-blue-50' : 'border-gray-300 text-gray-600'}`}>
            <option value="">Off (any pitcher)</option>
            <option value="any">2+ starts in any week</option>
            {weeks.map(w => (
              <option key={w.week_index} value={String(w.week_index)}>
                2 starts: {weekLabel(w)}
              </option>
            ))}
          </select>
        </label>
        {twoStartWeek != null && (
          <button
            onClick={() => selectTwoStartWeek(null)}
            className="px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-700 hover:bg-blue-200">
            Clear 2-start filter
          </button>
        )}
        <button
          onClick={() => setShowMatchups(v => !v)}
          title="Show the opponent and its runs-scored rank for each projected start"
          className={`px-2 py-0.5 text-xs rounded ${showMatchups ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
          Matchups
        </button>
        {players.length > LIMIT_OPTIONS[0] && (
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500">Show:</span>
            {LIMIT_OPTIONS.map(opt => (
              <button
                key={opt ?? 'all'}
                onClick={() => setLimit(opt)}
                className={`px-2 py-0.5 text-xs rounded ${limit === opt ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {opt ?? 'All'}
              </button>
            ))}
          </div>
        )}
        <span className="text-sm text-gray-400 ml-auto tabular-nums">
          {truncated > 0 ? `${shown.length} of ${players.length} players` : `${players.length} players`}
        </span>
      </div>

      {!loading && !error && players.length > 0 && <OwnershipLegend />}
      {hasMatchups && showMatchups && !loading && !error && <MatchupLegend />}

      {loading && <div className="p-4 text-gray-500">Loading projections...</div>}
      {error && <div className="p-4 text-red-500 text-sm">Error: {error}</div>}
      {!loading && !error && players.length === 0 && data.players.length === 0 && (
        <div className="p-4 text-gray-500 text-sm">
          No projections yet. Run <span className="font-mono">Refresh Weekly Planning</span> in Settings to fetch the schedule and build them.
        </div>
      )}
      {!loading && !error && players.length === 0 && data.players.length > 0 && (
        <div className="p-4 text-gray-500 text-sm">
          No players match the current filters.
          {twoStartWeek != null && ' No pitcher is projected for 2 starts in that week.'}
        </div>
      )}

      {!loading && !error && players.length > 0 && (
        <div className="overflow-auto max-h-[78vh] border border-gray-200 rounded-lg bg-white">
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-30 bg-gray-50 border-b border-gray-200 px-2 py-2 text-left font-medium text-gray-500 w-12">#</th>
                <th className="sticky top-0 left-12 z-30 bg-gray-50 border-b border-r border-gray-200 px-3 py-2 text-left font-medium text-gray-500 min-w-[180px]">Player</th>
                {weeks.map(w => {
                  const sel = twoStartWeek === w.week_index;
                  return (
                    <th
                      key={w.week_index}
                      className={`sticky top-0 z-20 border-b px-2 py-2 text-center font-medium min-w-[92px] ${sel ? 'bg-blue-100 text-blue-800 border-blue-300 border-l border-r' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                      <div>{shortDate(w.week_start)}</div>
                      <div className={`text-[10px] font-normal ${sel ? 'text-blue-600' : 'text-gray-400'}`}>
                        to {shortDate(w.week_end)}
                      </div>
                      {sel && <div className="text-[10px] font-semibold text-blue-700">2-start filter</div>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const own = OWNERSHIP[ownershipOf(p)];
                // Sticky cells must carry the background themselves or the rows
                // beneath show through as they scroll under.
                const rowBg = own.row;
                return (
                  <tr key={p.player_id} className={`group ${rowBg}`}>
                    <td className={`sticky left-0 z-10 border-b border-gray-100 border-l-4 ${own.accent} px-2 py-1 text-gray-400 tabular-nums group-hover:bg-blue-50 ${rowBg}`}>
                      {p.rank ?? <span className="text-gray-300" title="No combined ranking">–</span>}
                    </td>
                    <td className={`sticky left-12 z-10 border-b border-r border-gray-100 px-3 py-1 group-hover:bg-blue-50 ${rowBg}`}>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900">{p.name}</span>
                        {p.injury && <span className="text-[10px] px-1 rounded bg-red-100 text-red-600">IL</span>}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        {/* mlb_team comes from the club he's actually projected
                            to start for; p.team goes stale after a trade. */}
                        <span title={p.mlb_team && p.mlb_team !== p.team ? `Listed as ${p.team}; now with ${p.mlb_team}` : undefined}>
                          {p.position} · {p.mlb_team || p.team}
                        </span>
                        {p.fantasy_team && p.fantasy_team !== 'me' && (
                          <span className="text-[10px] px-1 rounded bg-gray-200 text-gray-600 truncate max-w-[110px]"
                            title={`Rostered by ${p.fantasy_team}`}>
                            {p.fantasy_team}
                          </span>
                        )}
                        <PlatoonBadge player={p} />
                      </div>
                    </td>
                    {weeks.map(w => {
                      const wk = p.weeks?.find(x => x.week_index === w.week_index);
                      const sel = twoStartWeek === w.week_index;
                      return (
                        <td
                          key={w.week_index}
                          className={`border-b border-gray-100 px-1 py-1 align-middle group-hover:bg-blue-50 ${sel ? 'bg-blue-50/70 border-l border-r border-l-blue-300 border-r-blue-300' : ''}`}>
                          {p.player_type === 'P'
                            ? <PitcherCell wk={wk} showMatchups={showMatchups} />
                            : <HitterCell wk={wk} />}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {truncated > 0 && (
        <div className="text-xs text-gray-500">
          {truncated} more row{truncated === 1 ? '' : 's'} hidden ·{' '}
          <button onClick={() => setLimit(null)} className="text-blue-600 hover:underline">Show all</button>
        </div>
      )}
    </div>
  );
}
