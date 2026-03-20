import { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import {
  useReactTable, getCoreRowModel, getSortedRowModel,
  getFilteredRowModel, flexRender,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';

const num1 = ({ getValue }) => { const v = getValue(); return v != null ? v.toFixed(1) : ''; };
const num2 = ({ getValue }) => { const v = getValue(); return v != null ? v.toFixed(2) : ''; };
const int = ({ getValue }) => { const v = getValue(); return v != null ? Math.round(v) : ''; };
const raw = ({ getValue }) => getValue() ?? '';
const num3 = ({ getValue }) => { const v = getValue(); return v != null ? v.toFixed(3).replace(/^0/, '') : ''; };

// Columns with numeric data get right-aligned
const NUMERIC_ACCESSORS = new Set([
  'pos_rank', 'score', 'adj_score', 'per_game_efficiency', 'espn_rank', 'value_gap',
  'velo_prev', 'velo_curr', 'velo_n', 'velocity_delta',
  'ip', 'gs', 'pit_g', 'k9', 'bb9', 'era', 'whip', 'fip', 'pit_so', 'pit_bb',
  'W', 'L', 'QS', 'SV', 'hld', 'pit_war',
  'pa', 'ab', 'bat_g', 'bat_h', 'doubles', 'triples', 'hr', 'runs', 'rbi',
  'bat_bb', 'bat_so', 'sb', 'cs', 'avg', 'obp', 'slg', 'ops', 'woba', 'wrc_plus', 'bat_war',
]);

// Column filter: supports ">N", "<N", ">=N", "<=N", "N-M" (range), or plain text substring
function columnFilterFn(row, columnId, filterValue) {
  if (!filterValue) return true;
  const cellValue = row.getValue(columnId);
  const s = filterValue.trim();

  const rangeMatch = s.match(/^(-?[\d.]+)\s*[-–]\s*(-?[\d.]+)$/);
  if (rangeMatch) {
    const lo = parseFloat(rangeMatch[1]);
    const hi = parseFloat(rangeMatch[2]);
    if (cellValue == null) return false;
    return cellValue >= lo && cellValue <= hi;
  }

  const cmpMatch = s.match(/^([<>]=?)\s*(-?[\d.]+)$/);
  if (cmpMatch) {
    const op = cmpMatch[1];
    const num = parseFloat(cmpMatch[2]);
    if (cellValue == null) return false;
    if (op === '>') return cellValue > num;
    if (op === '<') return cellValue < num;
    if (op === '>=') return cellValue >= num;
    if (op === '<=') return cellValue <= num;
  }

  const str = String(cellValue ?? '').toLowerCase();
  return str.includes(s.toLowerCase());
}

// All available columns
export const ALL_COLUMNS = [
  // Core
  { accessorKey: 'rank', header: 'Rank', size: 52, group: 'core', filterFn: columnFilterFn },
  { accessorKey: 'name', header: 'Name', size: 200, group: 'core', filterFn: columnFilterFn,
    cell: ({ row, getValue }) => {
      const name = getValue();
      const slug = name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const fgId = row.original.fg_id;
      const mlbamId = row.original.mlbam_id;
      return (
        <span className="flex items-center gap-1">
          <span className="truncate">{name}</span>
          {fgId && (
            <a href={`https://www.fangraphs.com/players/${slug}/${fgId}/stats`}
               target="_blank" rel="noopener noreferrer"
               onClick={e => e.stopPropagation()}
               className="text-[10px] text-blue-400 hover:text-blue-600 font-bold shrink-0"
               title="FanGraphs">FG</a>
          )}
          {mlbamId && (
            <a href={`https://baseballsavant.mlb.com/savant-player/${mlbamId}`}
               target="_blank" rel="noopener noreferrer"
               onClick={e => e.stopPropagation()}
               className="text-[10px] text-red-400 hover:text-red-600 font-bold shrink-0"
               title="Baseball Savant">SV</a>
          )}
        </span>
      );
    },
  },
  { accessorKey: 'team', header: 'Team', size: 52, group: 'core', filterFn: columnFilterFn },
  { accessorKey: 'position', header: 'Pos', size: 56, group: 'core', filterFn: columnFilterFn },
  { accessorKey: 'injury', header: 'Injury', size: 140, group: 'core', filterFn: columnFilterFn,
    cell: ({ getValue }) => {
      const v = getValue();
      if (!v) return '';
      return <span className="text-red-600 text-xs" title={v}>{v}</span>;
    },
  },
  { accessorKey: 'note', header: 'Notes', size: 180, group: 'core', filterFn: columnFilterFn,
    cell: NotesCell,
  },
  // Scoring
  { accessorKey: 'pos_rank', header: 'PRk', size: 46, cell: raw, group: 'scoring', filterFn: columnFilterFn },
  { accessorKey: 'score', header: 'Score', size: 64, cell: num1, group: 'scoring', filterFn: columnFilterFn },
  { accessorKey: 'adj_score', header: 'Adj', size: 60, cell: num1, group: 'scoring', filterFn: columnFilterFn },
  { accessorKey: 'per_game_efficiency', header: 'Pts/G', size: 58, cell: num2, group: 'scoring', filterFn: columnFilterFn },
  { accessorKey: 'espn_rank', header: 'ERk', size: 50, cell: raw, group: 'scoring', filterFn: columnFilterFn },
  { accessorKey: 'value_gap', header: 'Val', size: 46, cell: raw, group: 'scoring', filterFn: columnFilterFn },
  // Velocity
  { accessorKey: 'velo_prev', header: "'25", size: 50, cell: num1, group: 'velo', filterFn: columnFilterFn },
  { accessorKey: 'velo_curr', header: "'26", size: 50, cell: num1, group: 'velo', filterFn: columnFilterFn },
  { accessorKey: 'velo_n', header: 'N', size: 36, cell: int, group: 'velo', filterFn: columnFilterFn },
  { accessorKey: 'velocity_delta', header: '\u0394', size: 46, cell: ({ getValue }) => { const v = getValue(); return v != null ? (v > 0 ? '+' : '') + v.toFixed(1) : ''; }, group: 'velo', filterFn: columnFilterFn },
  // Pitcher stats
  { accessorKey: 'ip', header: 'IP', size: 50, cell: num1, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'gs', header: 'GS', size: 38, cell: raw, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'pit_g', header: 'G', size: 36, cell: raw, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'k9', header: 'K/9', size: 46, cell: num1, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'bb9', header: 'BB/9', size: 50, cell: num1, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'era', header: 'ERA', size: 50, cell: num2, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'whip', header: 'WHIP', size: 56, cell: num2, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'fip', header: 'FIP', size: 50, cell: num2, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'pit_so', header: 'SO', size: 42, cell: int, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'pit_bb', header: 'BB', size: 40, cell: int, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'W', header: 'W', size: 36, cell: int, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'L', header: 'L', size: 34, cell: int, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'QS', header: 'QS', size: 36, cell: int, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'SV', header: 'SV', size: 36, cell: int, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'hld', header: 'HLD', size: 40, cell: int, group: 'pitcher', filterFn: columnFilterFn },
  { accessorKey: 'pit_war', header: 'WAR', size: 48, cell: num1, group: 'pitcher', filterFn: columnFilterFn },
  // Batter stats
  { accessorKey: 'pa', header: 'PA', size: 46, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'ab', header: 'AB', size: 46, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'bat_g', header: 'G', size: 36, cell: raw, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'bat_h', header: 'H', size: 40, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'doubles', header: '2B', size: 36, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'triples', header: '3B', size: 36, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'hr', header: 'HR', size: 38, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'runs', header: 'R', size: 38, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'rbi', header: 'RBI', size: 42, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'bat_bb', header: 'BB', size: 38, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'bat_so', header: 'SO', size: 40, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'sb', header: 'SB', size: 36, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'cs', header: 'CS', size: 36, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'avg', header: 'AVG', size: 52, cell: num3, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'obp', header: 'OBP', size: 52, cell: num3, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'slg', header: 'SLG', size: 52, cell: num3, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'ops', header: 'OPS', size: 56, cell: num3, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'woba', header: 'wOBA', size: 52, cell: num3, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'wrc_plus', header: 'wRC+', size: 52, cell: int, group: 'batter', filterFn: columnFilterFn },
  { accessorKey: 'bat_war', header: 'WAR', size: 48, cell: num1, group: 'batter', filterFn: columnFilterFn },
];

const STORAGE_KEY = 'fantasy-bb-visible-cols';

const DEFAULT_VISIBLE = new Set([
  'rank', 'name', 'team', 'position',
  'pos_rank', 'score', 'adj_score', 'per_game_efficiency',
  'espn_rank', 'value_gap',
  'velo_prev', 'velo_curr', 'velo_n', 'velocity_delta',
  'ip', 'gs', 'k9',
  'pa', 'triples', 'sb',
]);

function loadVisibility() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch {}
  return new Set(DEFAULT_VISIBLE);
}

function ColumnPicker({ visible, onChange }) {
  const [open, setOpen] = useState(false);
  const groups = { scoring: 'Scoring', velo: 'Velocity', pitcher: 'Pitcher Stats', batter: 'Batter Stats' };

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)}
              className="px-2 py-1 text-xs bg-gray-200 rounded hover:bg-gray-300">
        Columns
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 bg-white border rounded shadow-lg p-3 w-72 max-h-96 overflow-auto">
          {Object.entries(groups).map(([key, label]) => (
            <div key={key} className="mb-2">
              <div className="text-xs font-semibold text-gray-500 uppercase mb-1">{label}</div>
              <div className="flex flex-wrap gap-1">
                {ALL_COLUMNS.filter(c => c.group === key).map(c => (
                  <label key={c.accessorKey}
                         className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded cursor-pointer
                           ${visible.has(c.accessorKey) ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>
                    <input type="checkbox" className="sr-only"
                           checked={visible.has(c.accessorKey)}
                           onChange={() => {
                             const next = new Set(visible);
                             next.has(c.accessorKey) ? next.delete(c.accessorKey) : next.add(c.accessorKey);
                             onChange(next);
                           }} />
                    {c.header}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <button onClick={() => { onChange(new Set(DEFAULT_VISIBLE)); }}
                  className="mt-2 text-xs text-blue-600 hover:underline">Reset to defaults</button>
        </div>
      )}
    </div>
  );
}

function NotesCell({ getValue, row, table }) {
  const initialValue = getValue() ?? '';
  const [value, setValue] = useState(initialValue);
  const [editing, setEditing] = useState(false);

  useEffect(() => { setValue(getValue() ?? ''); }, [getValue()]);

  const save = () => {
    setEditing(false);
    if (value !== initialValue) {
      table.options.meta?.onNoteChange?.(row.original.player_id, value);
    }
  };

  if (!editing) {
    return (
      <span className="block w-full truncate text-gray-500 text-xs cursor-text"
            title={value || 'Click to add note'}
            onClick={e => { e.stopPropagation(); setEditing(true); }}>
        {value || <span className="text-gray-300 italic">+</span>}
      </span>
    );
  }

  return (
    <input
      autoFocus
      className="w-full px-1 py-0 text-xs border border-blue-400 rounded bg-white outline-none"
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setValue(initialValue); setEditing(false); } }}
      onClick={e => e.stopPropagation()}
    />
  );
}

function valueGradientStyle(valueGap) {
  if (valueGap == null || valueGap >= 0) return {};
  // value_gap is negative when rank < ADP (player is a value — ranked higher than drafted)
  // More negative = more value
  const intensity = Math.min(Math.abs(valueGap) / 100, 1);
  const alpha = intensity * 0.15;
  return { backgroundColor: `rgba(34, 197, 94, ${alpha})` };
}

const ROW_HEIGHT = 33;

export default function PlayerTable({ data, globalFilter, positionFilter, rankLimit = 1000, onRowClick, rowClassName, onNoteChange }) {
  const parentRef = useRef(null);
  const [visible, setVisible] = useState(loadVisibility);
  const [columnFilters, setColumnFilters] = useState([]);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...visible]));
  }, [visible]);

  const columns = useMemo(() => {
    return ALL_COLUMNS.filter(c => c.group === 'core' || visible.has(c.accessorKey));
  }, [visible]);

  const filteredData = useMemo(() => {
    let d = data;
    if (rankLimit) {
      d = d.filter(r => r.rank != null && r.rank <= rankLimit);
    }
    if (positionFilter) {
      d = d.filter(r => r.position?.includes(positionFilter));
    }
    return d;
  }, [data, positionFilter, rankLimit]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { globalFilter, columnFilters },
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: 'includesString',
    meta: { onNoteChange },
  });

  const { rows } = table.getRowModel();

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const clearFilters = useCallback(() => {
    setColumnFilters([]);
  }, []);

  const hasActiveFilters = columnFilters.length > 0;

  // Total width of all visible columns — used as min-width so nothing truncates
  const totalWidth = useMemo(() => {
    return columns.reduce((sum, c) => sum + (c.size || 60), 0);
  }, [columns]);

  return (
    <div>
      <div className="flex items-center justify-end gap-2 mb-1">
        {hasActiveFilters && (
          <button onClick={clearFilters}
                  className="px-2 py-1 text-xs text-red-600 hover:text-red-800 hover:bg-red-50 rounded">
            Clear filters
          </button>
        )}
        <button onClick={() => setShowFilters(!showFilters)}
                className={`px-2 py-1 text-xs rounded ${showFilters ? 'bg-blue-100 text-blue-800' : 'bg-gray-200 hover:bg-gray-300'}`}>
          Filter
        </button>
        <ColumnPicker visible={visible} onChange={setVisible} />
      </div>
      <div ref={parentRef} className="overflow-auto max-h-[80vh] border border-gray-200 rounded-lg shadow-sm bg-white">
        <div style={{ minWidth: totalWidth }}>
          {/* Header */}
          <div className="sticky top-0 z-10 bg-gray-50">
            <div className="flex border-b-2 border-gray-300">
              {table.getHeaderGroups()[0].headers.map(h => {
                const isNum = NUMERIC_ACCESSORS.has(h.column.id);
                return (
                  <div key={h.id}
                       className={`px-2 py-2 text-xs font-bold uppercase tracking-wide cursor-pointer select-none shrink-0 text-gray-600 hover:text-gray-900 whitespace-nowrap ${isNum ? 'text-right' : 'text-left'}`}
                       style={{ width: h.getSize() }}
                       onClick={h.column.getToggleSortingHandler()}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: ' \u2191', desc: ' \u2193' }[h.column.getIsSorted()] ?? ''}
                  </div>
                );
              })}
            </div>
            {showFilters && (
              <div className="flex border-b border-gray-200 bg-gray-50/80">
                {table.getHeaderGroups()[0].headers.map(h => {
                  const isNum = NUMERIC_ACCESSORS.has(h.column.id);
                  return (
                    <div key={h.id + '-filter'} className="shrink-0 px-1 py-1" style={{ width: h.getSize() }}>
                      <input
                        type="text"
                        value={h.column.getFilterValue() ?? ''}
                        onChange={e => h.column.setFilterValue(e.target.value || undefined)}
                        placeholder={isNum ? '>N <N' : '...'}
                        className={`w-full px-1 py-0.5 text-xs border border-gray-300 rounded bg-white focus:outline-none focus:border-blue-400 tabular-nums ${isNum ? 'text-right' : ''}`}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* Body */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(vRow => {
              const row = rows[vRow.index];
              return (
                <div key={row.id}
                     className={`flex border-t border-gray-100 hover:bg-blue-50 cursor-pointer text-sm ${vRow.index % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'} ${rowClassName?.(row.original) || ''}`}
                     style={{ position: 'absolute', top: vRow.start, height: ROW_HEIGHT, ...valueGradientStyle(row.original.value_gap) }}
                     onClick={() => onRowClick?.(row.original)}>
                  {row.getVisibleCells().map(cell => {
                    const isNum = NUMERIC_ACCESSORS.has(cell.column.id);
                    return (
                      <div key={cell.id}
                           className={`px-2 py-1 shrink-0 whitespace-nowrap tabular-nums ${isNum ? 'text-right' : 'text-left'} ${cell.column.id === 'name' ? 'font-medium' : ''} ${cell.column.id === 'rank' ? 'text-gray-400 font-mono text-xs' : ''}`}
                           style={{ width: cell.column.getSize() }}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
