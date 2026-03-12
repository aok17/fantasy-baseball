import { useState } from 'react';

export default function WeightsEditor({ weights, onSave }) {
  const [local, setLocal] = useState(weights);
  const [dirty, setDirty] = useState(false);

  const pitcherW = local.filter(w => w.category === 'pitcher');
  const batterW = local.filter(w => w.category === 'batter');

  const update = (category, stat, value) => {
    setLocal(prev => prev.map(w =>
      w.category === category && w.stat === stat ? { ...w, weight: Number(value) } : w
    ));
    setDirty(true);
  };

  const save = () => { onSave(local); setDirty(false); };

  const renderTable = (title, items) => (
    <div>
      <h3 className="font-semibold text-sm mb-1">{title}</h3>
      <table className="text-sm border">
        <tbody>
          {items.map(w => (
            <tr key={w.stat} className="border-t">
              <td className="px-2 py-1 font-mono">{w.stat}</td>
              <td className="px-2 py-1">
                <input type="number" step="0.1" value={w.weight}
                  onChange={e => update(w.category, w.stat, e.target.value)}
                  className="border rounded px-1 py-0.5 w-20 text-right" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex gap-6">
        {renderTable('Pitcher Weights', pitcherW)}
        {renderTable('Batter Weights', batterW)}
      </div>
      {dirty && <button onClick={save} className="px-3 py-1 bg-blue-600 text-white text-sm rounded">Save & Rescore</button>}
    </div>
  );
}
