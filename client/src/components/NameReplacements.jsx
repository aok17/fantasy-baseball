import { useState } from 'react';

export default function NameReplacements({ replacements, onAdd, onDelete }) {
  const [alt, setAlt] = useState('');
  const [canonical, setCanonical] = useState('');

  const handleAdd = (e) => {
    e.preventDefault();
    if (alt && canonical) { onAdd(alt, canonical); setAlt(''); setCanonical(''); }
  };

  return (
    <div className="space-y-2">
      <table className="text-sm border w-full">
        <thead><tr className="bg-gray-100"><th className="px-2 py-1 text-left">Alternate Name</th><th className="px-2 py-1 text-left">Canonical Name</th><th></th></tr></thead>
        <tbody>
          {replacements.map(r => (
            <tr key={r.id} className="border-t">
              <td className="px-2 py-1">{r.alt_name}</td>
              <td className="px-2 py-1">{r.canonical_name}</td>
              <td className="px-2 py-1"><button onClick={() => onDelete(r.id)} className="text-red-500 text-xs">x</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={handleAdd} className="flex gap-2">
        <input value={alt} onChange={e => setAlt(e.target.value)} placeholder="Alternate" className="border rounded px-2 py-1 text-sm" />
        <input value={canonical} onChange={e => setCanonical(e.target.value)} placeholder="Canonical" className="border rounded px-2 py-1 text-sm" />
        <button type="submit" className="px-2 py-1 bg-gray-200 text-sm rounded">Add</button>
      </form>
    </div>
  );
}
