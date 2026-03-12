const POSITIONS = ['All', 'SP', 'RP', 'C', '1B', '2B', '3B', 'SS', 'OF'];

export default function PositionFilter({ value, onChange }) {
  return (
    <div className="flex gap-1">
      {POSITIONS.map(p => (
        <button key={p}
          className={`px-3 py-1 text-xs rounded ${(p === 'All' && !value) || value === p ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
          onClick={() => onChange(p === 'All' ? null : p)}>
          {p}
        </button>
      ))}
    </div>
  );
}
