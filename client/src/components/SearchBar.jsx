export default function SearchBar({ value, onChange }) {
  return (
    <input
      type="text"
      placeholder="Search players..."
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border rounded px-3 py-1 text-sm w-64"
    />
  );
}
