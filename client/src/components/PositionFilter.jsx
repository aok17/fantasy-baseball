const POSITIONS = ['All', 'SP', 'RP', 'C', '1B', '2B', '3B', 'SS', 'OF', 'MI', 'CI', 'UTIL', 'DH'];

export default function PositionFilter({ value, onChange }) {
  return (
    <div className="flex gap-1">
      {POSITIONS.map(p => (
        <button key={p}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${(p === 'All' && !value) || value === p ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          onClick={() => onChange(p === 'All' ? null : p)}>
          {p}
        </button>
      ))}
    </div>
  );
}
