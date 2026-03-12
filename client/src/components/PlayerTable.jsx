import { useMemo } from 'react';
import {
  useReactTable, getCoreRowModel, getSortedRowModel,
  getFilteredRowModel, flexRender,
} from '@tanstack/react-table';

const defaultColumns = [
  { accessorKey: 'rank', header: 'Rank', size: 60 },
  { accessorKey: 'name', header: 'Name', size: 180 },
  { accessorKey: 'team', header: 'Team', size: 60 },
  { accessorKey: 'position', header: 'Pos', size: 80 },
  { accessorKey: 'score', header: 'Score', size: 80, cell: ({ getValue }) => getValue()?.toFixed(1) },
  { accessorKey: 'adj_score', header: 'Adj Score', size: 90, cell: ({ getValue }) => getValue()?.toFixed(1) },
  { accessorKey: 'espn_adp', header: 'ESPN ADP', size: 80 },
  { accessorKey: 'value_gap', header: 'Value', size: 70 },
  { accessorKey: 'velocity_delta', header: 'Velo \u0394', size: 70, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v > 0 ? '+' : '') + v.toFixed(1) : ''; } },
  { accessorKey: 'per_game_efficiency', header: 'Eff', size: 60, cell: ({ getValue }) => getValue()?.toFixed(2) },
];

export default function PlayerTable({ data, globalFilter, positionFilter, columns = defaultColumns, onRowClick, rowClassName }) {
  const filteredData = useMemo(() => {
    let d = data;
    if (positionFilter) {
      d = d.filter(r => r.position?.includes(positionFilter));
    }
    return d;
  }, [data, positionFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { globalFilter },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: 'includesString',
  });

  return (
    <div className="overflow-auto max-h-[80vh] border rounded">
      <table className="w-full text-sm">
        <thead className="bg-gray-100 sticky top-0">
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map(h => (
                <th key={h.id} className="px-2 py-1 text-left cursor-pointer select-none"
                    style={{ width: h.getSize() }}
                    onClick={h.column.getToggleSortingHandler()}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: ' \u2191', desc: ' \u2193' }[h.column.getIsSorted()] ?? ''}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr key={row.id}
                className={`border-t hover:bg-blue-50 cursor-pointer ${rowClassName?.(row.original) || ''}`}
                onClick={() => onRowClick?.(row.original)}>
              {row.getVisibleCells().map(cell => (
                <td key={cell.id} className="px-2 py-1">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
