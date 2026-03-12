import { useState } from 'react';

export default function SessionSelector({ sessions, activeId, onSelect, onCreate }) {
  const [newName, setNewName] = useState('');
  const [showNew, setShowNew] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <select value={activeId || ''} onChange={e => onSelect(Number(e.target.value))}
        className="border rounded px-2 py-1 text-sm">
        {sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {showNew ? (
        <form onSubmit={e => { e.preventDefault(); onCreate(newName); setNewName(''); setShowNew(false); }}
          className="flex gap-1">
          <input value={newName} onChange={e => setNewName(e.target.value)}
            placeholder="Session name" className="border rounded px-2 py-1 text-sm" autoFocus />
          <button type="submit" className="px-2 py-1 bg-blue-600 text-white text-xs rounded">Create</button>
        </form>
      ) : (
        <button onClick={() => setShowNew(true)} className="px-2 py-1 bg-gray-200 text-xs rounded hover:bg-gray-300">+ New</button>
      )}
    </div>
  );
}
