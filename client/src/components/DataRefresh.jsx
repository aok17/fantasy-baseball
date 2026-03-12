import { useState } from 'react';
import { api } from '../api';

const SOURCES = [
  { key: 'fangraphs', label: 'FanGraphs Projections' },
  { key: 'savant', label: 'Baseball Savant' },
  { key: 'espn', label: 'ESPN ADP' },
];

export default function DataRefresh() {
  const [status, setStatus] = useState({});

  const run = async (source) => {
    setStatus(s => ({ ...s, [source]: 'loading' }));
    try {
      const result = await api.scrape(source);
      setStatus(s => ({ ...s, [source]: `Done: ${JSON.stringify(result)}` }));
    } catch (e) {
      setStatus(s => ({ ...s, [source]: `Error: ${e.message}` }));
    }
  };

  const runAll = async () => {
    setStatus({ all: 'loading' });
    try {
      const result = await api.scrape('all');
      setStatus({ all: `Done: ${JSON.stringify(result)}` });
    } catch (e) {
      setStatus({ all: `Error: ${e.message}` });
    }
  };

  return (
    <div className="space-y-2">
      {SOURCES.map(s => (
        <div key={s.key} className="flex items-center gap-3">
          <button onClick={() => run(s.key)}
            disabled={status[s.key] === 'loading'}
            className="px-3 py-1 bg-gray-200 text-sm rounded hover:bg-gray-300 disabled:opacity-50">
            Refresh {s.label}
          </button>
          {status[s.key] && <span className="text-xs text-gray-500">{status[s.key]}</span>}
        </div>
      ))}
      <button onClick={runAll} disabled={status.all === 'loading'}
        className="px-3 py-1 bg-blue-600 text-white text-sm rounded disabled:opacity-50">
        Refresh All
      </button>
      {status.all && <span className="text-xs text-gray-500">{status.all}</span>}
    </div>
  );
}
