// Opponent matchup display for pitcher start cells on the Planning page.
//
// Direction that matters to a fantasy manager: opp_runs_rank 1 = the offense
// that has scored the MOST runs in MLB = the HARDEST matchup. 30 = fewest runs
// = the softest matchup. Red means tough, green means soft.

const TONES = [
  { max: 6, chip: 'bg-red-100 text-red-700', label: 'very tough' },
  { max: 12, chip: 'bg-orange-100 text-orange-700', label: 'tough' },
  { max: 18, chip: 'bg-gray-100 text-gray-600', label: 'average' },
  { max: 24, chip: 'bg-lime-100 text-lime-700', label: 'soft' },
  { max: 99, chip: 'bg-emerald-100 text-emerald-700', label: 'very soft' },
];

const UNKNOWN_TONE = { chip: 'bg-gray-50 text-gray-300 border border-gray-200', label: 'unknown' };

export function oppTone(rank) {
  if (rank == null || !Number.isFinite(rank)) return UNKNOWN_TONE;
  return TONES.find(t => rank <= t.max) ?? UNKNOWN_TONE;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// One projected start: confidence dot, "vs NYY" / "@ BOS", opponent offense rank.
export function StartLine({ start }) {
  if (!start) return null;
  const rank = start.opp_runs_rank ?? null;
  const tone = oppTone(rank);
  const opp = start.opp_team_abbr || (start.opp_team_id != null ? `#${start.opp_team_id}` : '???');
  const announced = start.confidence === 'announced';
  const prefix = start.home === false ? '@' : 'vs';

  const rpg = start.opp_runs_per_game != null ? ` (${Number(start.opp_runs_per_game).toFixed(2)} R/G)` : '';
  const rankText = rank == null
    ? `${opp}: runs-scored rank unavailable`
    : `${opp} is ${ordinal(rank)} in MLB in runs scored${rpg} — ${tone.label} matchup (1 = most runs scored)`;

  return (
    <div className="flex items-center justify-center gap-1 leading-none whitespace-nowrap" title={rankText}>
      <span
        title={announced ? 'Announced probable' : 'Projected start'}
        className={`inline-block w-1 h-1 rounded-full shrink-0 ${announced ? 'bg-blue-500' : 'border border-gray-400'}`}
      />
      <span className="text-[10px] text-gray-600">
        <span className="text-gray-400">{prefix}</span> {opp}
      </span>
      <span className={`text-[10px] leading-none px-1 py-px rounded tabular-nums ${tone.chip}`}>
        {rank ?? '–'}
      </span>
    </div>
  );
}

// Small legend so the color/number direction is discoverable.
export function MatchupLegend() {
  return (
    <div className="flex items-center gap-2 flex-wrap text-[11px] text-gray-500">
      <span className="font-medium text-gray-600">Opponent offense rank</span>
      <span>1 = most runs scored in MLB (toughest)</span>
      <span className="flex items-center gap-1">
        {[
          { r: '1–6', t: oppTone(1) },
          { r: '7–12', t: oppTone(7) },
          { r: '13–18', t: oppTone(13) },
          { r: '19–24', t: oppTone(19) },
          { r: '25–30', t: oppTone(25) },
        ].map(({ r, t }) => (
          <span key={r} className={`px-1 rounded tabular-nums ${t.chip}`} title={`${r}: ${t.label} matchup`}>
            {r}
          </span>
        ))}
      </span>
      <span className="text-gray-400">tough → soft</span>
    </div>
  );
}
