import { useState, useEffect } from 'react';
import { api } from '../api';
import WeightsEditor from '../components/WeightsEditor';
import DataRefresh from '../components/DataRefresh';
import NameReplacements from '../components/NameReplacements';

export default function Settings() {
  const [weights, setWeights] = useState([]);
  const [posAdj, setPosAdj] = useState([]);
  const [config, setConfig] = useState([]);
  const [nameReps, setNameReps] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => Promise.all([
    api.getWeights(), api.getPositionAdj(), api.getAppConfig(), api.getNameReplacements(),
  ]).then(([w, p, c, n]) => { setWeights(w); setPosAdj(p); setConfig(c); setNameReps(n); });

  useEffect(() => { load().finally(() => setLoading(false)); }, []);

  const replacementLevel = config.find(c => c.key === 'replacement_level')?.value || '237';
  const projSystem = config.find(c => c.key === 'projection_system')?.value || 'steamer';

  if (loading) return <div className="p-4 text-gray-500">Loading settings...</div>;

  return (
    <div className="space-y-8 max-w-4xl">
      <h1 className="text-xl font-bold text-gray-900">Settings</h1>

      <section className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
        <h2 className="font-semibold text-gray-800 mb-3">Scoring Weights</h2>
        <WeightsEditor weights={weights} onSave={async (w) => { await api.updateWeights(w); load(); }} />
      </section>

      <section className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
        <h2 className="font-semibold text-gray-800 mb-3">Position Adjustments</h2>
        <div className="flex gap-3 flex-wrap">
          {posAdj.map(a => (
            <div key={a.position} className="flex items-center gap-1">
              <span className="text-sm font-mono w-8">{a.position}</span>
              <input type="number" value={a.adjustment}
                onChange={e => setPosAdj(prev => prev.map(p => p.position === a.position ? { ...p, adjustment: Number(e.target.value) } : p))}
                className="border rounded px-1 py-0.5 w-16 text-right text-sm" />
            </div>
          ))}
          <button onClick={async () => { await api.updatePositionAdj(posAdj); load(); }}
            className="px-3 py-1 bg-blue-600 text-white text-sm rounded">Save</button>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
        <h2 className="font-semibold text-gray-800 mb-3">General</h2>
        <div className="flex gap-4 items-center text-sm">
          <label>Replacement Level:
            <input type="number" value={replacementLevel}
              onChange={e => {
                const val = e.target.value;
                setConfig(prev => prev.map(c => c.key === 'replacement_level' ? { ...c, value: val } : c));
                clearTimeout(window._rlDebounce);
                window._rlDebounce = setTimeout(() => api.updateAppConfig('replacement_level', val), 2000);
              }}
              className="border rounded px-2 py-1 w-20 ml-1" />
          </label>
          <label>Projection System:
            <select value={projSystem}
              onChange={e => {
                const val = e.target.value;
                setConfig(prev => prev.map(c => c.key === 'projection_system' ? { ...c, value: val } : c));
                api.updateAppConfig('projection_system', val);
              }}
              className="border rounded px-2 py-1 ml-1">
              <option value="steamer">Steamer</option>
              <option value="zips">ZiPS</option>
            </select>
          </label>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
        <h2 className="font-semibold text-gray-800 mb-3">Data Sources</h2>
        <DataRefresh />
      </section>

      <section className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
        <h2 className="font-semibold text-gray-800 mb-3">Name Replacements</h2>
        <NameReplacements replacements={nameReps}
          onAdd={async (alt, canonical) => { await api.addNameReplacement(alt, canonical); load(); }}
          onDelete={async (id) => { await api.deleteNameReplacement(id); load(); }} />
      </section>
    </div>
  );
}
