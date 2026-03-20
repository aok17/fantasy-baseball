export default function SearchBar({ value, onChange }) {
  return (
    <input
      type="text"
      placeholder="Search players..."
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-400"
    />
  );
}
