import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

const SOURCES = [
  { key: 'razzball', label: 'Steamer Projections' },
  { key: 'mlb-actual', label: 'Season Actuals' },
  { key: 'savant', label: 'Baseball Savant' },
  { key: 'espn', label: 'ESPN ADP' },
  { key: 'injuries', label: 'Injury Report' },
  { key: 'rosters', label: 'League Rosters' },
  { key: 'pitcher-starts', label: 'Pitcher Model' },
  { key: 'planning', label: 'Weekly Planning' },
];

function ProgressBar({ startTime, expectedMs, message }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);

  const elapsed = now - startTime;
  // If we have an expected duration, use linear progress capped at 95%
  // Otherwise just show elapsed time with indeterminate bar
  let pct;
  if (expectedMs && expectedMs > 0) {
    pct = Math.min(95, (elapsed / expectedMs) * 100);
  } else {
    // Indeterminate: slow asymptotic crawl
    pct = Math.min(90, 100 * (1 - Math.exp(-elapsed / 30000)));
  }

  const seconds = Math.round(elapsed / 1000);
  const label = message || `${seconds}s`;

  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap shrink-0">{label}</span>
    </div>
  );
}

function StatusDisplay({ value }) {
  if (!value) return null;
  if (value.loading) {
    // SSE progress (pitcher-starts): use step/total
    if (value.step != null && value.total > 0) {
      const pct = Math.round((value.step / value.total) * 100);
      return (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-300"
                 style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap shrink-0">
            {value.message || `${pct}%`}
          </span>
        </div>
      );
    }
    // Time-based progress
    return <ProgressBar startTime={value.startTime} expectedMs={value.expectedMs} message={value.message} />;
  }
  if (value.error) return <span className="text-xs text-red-500 truncate">{value.error}</span>;
  return <span className="text-xs text-green-600 truncate">{value.text}</span>;
}

async function scrapeWithProgress(source, expectedMs, onProgress) {
  onProgress({ loading: true, startTime: Date.now(), expectedMs });

  const res = await fetch(`/api/scrape/${source}`, {
    method: 'POST',
    headers: { 'Accept': 'text/event-stream, application/json' },
  });

  if (!res.ok) throw new Error(`API error: ${res.status}`);

  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let result = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'progress') {
              onProgress({ loading: true, step: data.step, total: data.total, message: data.message });
            } else if (data.type === 'done') {
              result = data.result;
            } else if (data.type === 'error') {
              throw new Error(data.error);
            }
          } catch (e) {
            if (!e.message.startsWith('Unexpected')) throw e;
          }
        }
      }
    }
    return result || {};
  }

  return res.json();
}

export default function DataRefresh() {
  const [status, setStatus] = useState({});
  const [durations, setDurations] = useState({});

  // Fetch cached durations on mount
  useEffect(() => {
    fetch('/api/scrape/durations').then(r => r.json()).then(setDurations).catch(() => {});
  }, []);

  const run = async (source) => {
    const expectedMs = durations[source] || 0;
    try {
      const result = await scrapeWithProgress(source, expectedMs, (progress) => {
        setStatus(s => ({ ...s, [source]: progress }));
      });
      setStatus(s => ({ ...s, [source]: { text: summarize(result) } }));
    } catch (e) {
      setStatus(s => ({ ...s, [source]: { error: e.message } }));
    }
    // Refresh durations after each scrape
    fetch('/api/scrape/durations').then(r => r.json()).then(setDurations).catch(() => {});
  };

  const runAll = async () => {
    for (const s of SOURCES) {
      const expectedMs = durations[s.key] || 0;
      try {
        const result = await scrapeWithProgress(s.key, expectedMs, (progress) => {
          setStatus(prev => ({ ...prev, [s.key]: progress }));
        });
        setStatus(prev => ({ ...prev, [s.key]: { text: summarize(result) } }));
      } catch (e) {
        setStatus(prev => ({ ...prev, [s.key]: { error: e.message } }));
      }
    }
    setStatus(prev => ({ ...prev, rescore: { loading: true, startTime: Date.now(), expectedMs: durations.rescore || 0 } }));
    try {
      await fetch('/api/scrape/rescore', { method: 'POST' });
      setStatus(prev => ({ ...prev, rescore: { text: 'Done' } }));
    } catch (e) {
      setStatus(prev => ({ ...prev, rescore: { error: e.message } }));
    }
    fetch('/api/scrape/durations').then(r => r.json()).then(setDurations).catch(() => {});
  };

  const isLoading = (key) => status[key]?.loading;

  return (
    <div className="space-y-2">
      {SOURCES.map(s => (
        <div key={s.key} className="flex items-center gap-3 min-w-0">
          <button onClick={() => run(s.key)}
            disabled={isLoading(s.key)}
            className="px-3 py-1 bg-gray-200 text-sm rounded hover:bg-gray-300 disabled:opacity-50 shrink-0">
            Refresh {s.label}
          </button>
          <StatusDisplay value={status[s.key]} />
        </div>
      ))}
      <div className="flex items-center gap-3 min-w-0">
        <button onClick={() => run('rescore')}
          disabled={isLoading('rescore')}
          className="px-3 py-1 bg-gray-200 text-sm rounded hover:bg-gray-300 disabled:opacity-50 shrink-0">
          Rescore Rankings
        </button>
        <StatusDisplay value={status.rescore} />
      </div>
      <button onClick={runAll} disabled={Object.values(status).some(v => v?.loading)}
        className="px-3 py-1 bg-blue-600 text-white text-sm rounded disabled:opacity-50">
        Refresh All
      </button>
    </div>
  );
}

function summarize(result) {
  if (!result) return 'Done';
  const parts = [];
  if (result.games != null) parts.push(`${result.games} games`);
  if (result.pitchers != null) parts.push(`${result.pitchers} pit`);
  if (result.batters != null) parts.push(`${result.batters} bat`);
  if (result.starts != null) parts.push(`${result.starts} starts`);
  if (result.rows != null) parts.push(`${result.rows} rows`);
  if (result.expected != null) parts.push(`${result.expected} expected`);
  if (result.players != null) parts.push(`${result.players} players`);
  if (result.models != null) parts.push(`${result.models} models`);
  if (result.injuries != null) parts.push(`${result.injuries} injuries`);
  if (result.rosters != null) parts.push(`${result.rosters} rosters`);
  return parts.length > 0 ? parts.join(', ') : 'Done';
}
