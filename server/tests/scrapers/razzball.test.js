import { describe, it, expect } from 'vitest';
import {
  parseTable, mapRazzPitcher, mapRazzBatter, normalizeTeam, mlbamOf,
} from '../../src/scrapers/razzball.js';

function table(headers, rows) {
  const th = headers.map(h => `<th class="sorterhead-${h} header">${h}</th>`).join('');
  const trs = rows.map(cells => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<html><table><tr class="sorter-head">${th}</tr>${trs}</table></html>`;
}

const PITCH_HEADERS = ['#', 'Name', 'Team', 'POS', 'R/L', 'G', 'GS', 'QS', 'TBF', 'IP', 'W', 'L', 'SV', 'HLD', 'ERA', 'SIERA', 'WHIP', 'K', 'BB', 'H', 'HBP', 'ER', 'R', 'HR', 'GB%', 'FB%', 'LD%', 'BABIP', 'RazzID'];
const webb = ['', '<a href="/player/657277/Logan+Webb/">Logan Webb</a>', '<a href="/teams/x">SF</a>', 'SP', 'R', '30.8', '30.8', '18.6', '770.2', '180', '12.2', '8.3', '0', '0', '3.47', '3.27', '1.22', '180', '45', '182.4', '5', '72.8', '80.7', '20', '53.3', '26.8', '19.9', '0.316', '657277'];

describe('normalizeTeam', () => {
  it('maps Razzball abbreviations onto the FanGraphs ones already in players.team', () => {
    // rescore() links raw rows by `name|team`; a miss here orphans a whole club.
    expect(normalizeTeam('KC')).toBe('KCR');
    expect(normalizeTeam('SD')).toBe('SDP');
    expect(normalizeTeam('SF')).toBe('SFG');
    expect(normalizeTeam('TB')).toBe('TBR');
    expect(normalizeTeam('WSH')).toBe('WSN');
  });

  it('leaves the 25 already-matching abbreviations alone', () => {
    for (const t of ['ARI', 'ATH', 'ATL', 'BAL', 'BOS', 'CHC', 'CHW', 'CIN', 'CLE', 'COL',
      'DET', 'HOU', 'LAA', 'LAD', 'MIA', 'MIL', 'MIN', 'NYM', 'NYY', 'PHI', 'PIT', 'SEA',
      'STL', 'TEX', 'TOR']) {
      expect(normalizeTeam(t)).toBe(t);
    }
  });

  it('treats free agents as having no club', () => {
    expect(normalizeTeam('FA')).toBeNull();
    expect(normalizeTeam('')).toBeNull();
    expect(normalizeTeam(null)).toBeNull();
  });
});

describe('mlbamOf', () => {
  // Razzball's id column mixes MLBAM ids, FanGraphs ids, and suffixed duplicates.
  it('accepts a 6-digit MLBAM id', () => {
    expect(mlbamOf({ RazzID: '657277' })).toBe('657277');
  });

  it('rejects 4-5 digit FanGraphs ids', () => {
    expect(mlbamOf({ RazzID: '16149' })).toBeNull();  // Aaron Nola
    expect(mlbamOf({ RazzID: '10954' })).toBeNull();  // Jacob deGrom
    expect(mlbamOf({ RazzID: '1234' })).toBeNull();
  });

  it("rejects the 7-digit two-way suffix (Ohtani's 6602710, real id 660271)", () => {
    expect(mlbamOf({ RazzID: '6602710' })).toBeNull();
  });

  it('rejects non-numeric and empty values', () => {
    expect(mlbamOf({ RazzID: 'sa3018812' })).toBeNull();
    expect(mlbamOf({ RazzID: '' })).toBeNull();
    expect(mlbamOf({})).toBeNull();
  });
});

describe('parseTable', () => {
  it('reads headers and rows out of Razzball markup, unwrapping anchors', () => {
    const { headers, rows } = parseTable(table(PITCH_HEADERS, [webb]), { minRows: 1 });
    expect(headers).toEqual(PITCH_HEADERS);
    expect(rows).toHaveLength(1);
    expect(rows[0].Name).toBe('Logan Webb');
    expect(rows[0].Team).toBe('SF');
    expect(rows[0].RazzID).toBe('657277');
  });

  it('picks the largest table when the page has several', () => {
    const small = '<table><tr><th>a</th><th>b</th><th>c</th><th>d</th><th>e</th></tr><tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td></tr></table>';
    const big = table(PITCH_HEADERS, [webb, webb, webb]);
    const { rows } = parseTable(small + big, { minRows: 1 });
    expect(rows).toHaveLength(3);
  });

  it('skips rows whose cell count does not match the header (ads, spacers)', () => {
    const html = table(PITCH_HEADERS, [webb]).replace('</table>', '<tr><td colspan="9">ad</td></tr></table>');
    expect(parseTable(html, { minRows: 1 }).rows).toHaveLength(1);
  });

  it('decodes HTML entities in names', () => {
    const r = [...webb];
    r[1] = '<a href="/x">Jos&eacute;&nbsp;Ram&#237;rez</a>'.replace('&eacute;', '&#233;');
    const { rows } = parseTable(table(PITCH_HEADERS, [r]), { minRows: 1 });
    expect(rows[0].Name).toBe('José Ramírez');
  });

  it('throws rather than silently returning nothing when no table is present', () => {
    expect(() => parseTable('<html><p>nope</p></html>')).toThrow(/No projection table/);
  });
});

describe('mapRazzPitcher', () => {
  const row = parseTable(table(PITCH_HEADERS, [webb]), { minRows: 1 }).rows[0];

  it('maps counting stats and normalizes the team', () => {
    const p = mapRazzPitcher(row);
    expect(p.name).toBe('Logan Webb');
    expect(p.team).toBe('SFG');
    expect(p.IP).toBe(180);
    expect(p.QS).toBe(18.6);
    expect(p.SO).toBe(180); // Razzball's "K" column
    expect(p.ER).toBe(72.8);
    expect(p.mlbam_id).toBe('657277');
    expect(p.fg_id).toBeNull();
  });

  it('derives K/9 and BB/9, which Razzball does not publish', () => {
    const p = mapRazzPitcher(row);
    expect(p.K9).toBeCloseTo(180 * 9 / 180, 2); // 9.00
    expect(p.BB9).toBeCloseTo(45 * 9 / 180, 2); // 2.25
  });

  it('derives FIP from the counting stats and the configured constant', () => {
    const p = mapRazzPitcher(row, { fipConstant: 3.15 });
    // (13*20 + 3*(45+5) - 2*180) / 180 + 3.15
    const expected = ((13 * 20) + (3 * (45 + 5)) - (2 * 180)) / 180 + 3.15;
    expect(p.FIP).toBeCloseTo(expected, 2);
  });

  it('does not divide by zero for a pitcher projected for no innings', () => {
    const zero = [...webb];
    zero[9] = '0'; // IP
    const p = mapRazzPitcher(parseTable(table(PITCH_HEADERS, [zero]), { minRows: 1 }).rows[0]);
    expect(p.IP).toBe(0);
    expect(p.K9).toBe(0);
    expect(p.BB9).toBe(0);
    expect(p.FIP).toBe(0);
  });

  it('zeroes the advanced stats Razzball does not carry', () => {
    const p = mapRazzPitcher(row);
    expect(p.WAR).toBe(0);
    expect(p.RA9WAR).toBe(0);
  });
});

describe('mapRazzBatter', () => {
  const BAT_HEADERS = ['#', 'Name', 'Team', 'Bats', 'ESPN', 'YAHOO', 'G', 'PA', 'AB', 'R', 'HR', 'RBI', 'SB', 'H', '1B', '2B', '3B', 'TB', 'SO', 'BB', 'HBP', 'SF', 'SH', 'CS', 'AVG', 'OBP', 'SLG', 'OPS', 'BABIP', 'RazzID'];
  const witt = ['', '<a href="/x">Bobby Witt Jr.</a>', '<a href="/y">KC</a>', 'R', 'SS', 'SS', '150', '651', '600', '95.6', '27.4', '86.6', '32.4', '180', '110', '35', '8', '300', '120', '45', '5', '4', '0', '7', '0.289', '0.345', '0.500', '0.845', '0.320', '677951'];
  const row = parseTable(table(BAT_HEADERS, [witt]), { minRows: 1 }).rows[0];

  it('maps the stats the scoring engine reads and normalizes the team', () => {
    const b = mapRazzBatter(row);
    expect(b.name).toBe('Bobby Witt Jr.');
    expect(b.team).toBe('KCR');
    expect(b.G).toBe(150);
    expect(b.R).toBe(95.6);
    expect(b.HR).toBe(27.4);
    expect(b.RBI).toBe(86.6);
    expect(b.SB).toBe(32.4);
    expect(b.SO).toBe(120);
    expect(b.BB).toBe(45);
    expect(b.mlbam_id).toBe('677951');
  });

  it('zeroes the advanced stats Razzball does not carry', () => {
    const b = mapRazzBatter(row);
    for (const k of ['wOBA', 'wRC', 'BsR', 'Fld', 'Off', 'Def', 'WAR']) expect(b[k]).toBe(0);
  });
});
