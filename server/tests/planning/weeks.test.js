import { describe, it, expect } from 'vitest';
import { weekBoundaries, bucketGamesByWeek, parseDate, formatDate } from '../../src/planning/weeks.js';

describe('weekBoundaries', () => {
  // 2026-06-03 is a Wednesday.
  it('Monday-start week contains today, inclusive Mon..Sun', () => {
    const w = weekBoundaries('2026-06-03', 'monday', 4);
    expect(w[0]).toEqual({ week_index: 0, start: '2026-06-01', end: '2026-06-07' });
    expect(w[1]).toEqual({ week_index: 1, start: '2026-06-08', end: '2026-06-14' });
    expect(w).toHaveLength(4);
  });

  it('honors a configurable non-Monday (Sunday) start', () => {
    const w = weekBoundaries('2026-06-03', 'sunday', 2);
    expect(w[0]).toEqual({ week_index: 0, start: '2026-05-31', end: '2026-06-06' });
    expect(w[1].start).toBe('2026-06-07');
  });

  it('crosses a month boundary cleanly', () => {
    const w = weekBoundaries('2026-06-29', 'monday', 1); // Mon 6/29
    expect(w[0]).toEqual({ week_index: 0, start: '2026-06-29', end: '2026-07-05' });
  });

  it('when today IS the start day, week 0 begins today', () => {
    const w = weekBoundaries('2026-06-01', 'monday', 1); // Mon
    expect(w[0].start).toBe('2026-06-01');
    expect(w[0].end).toBe('2026-06-07');
  });

  it('defaults to monday for unknown weekStartDay', () => {
    const w = weekBoundaries('2026-06-03', 'gibberish', 1);
    expect(w[0].start).toBe('2026-06-01');
  });

  it('parseDate/formatDate round-trip', () => {
    expect(formatDate(parseDate('2026-06-03'))).toBe('2026-06-03');
  });
});

describe('bucketGamesByWeek', () => {
  const boundaries = weekBoundaries('2026-06-03', 'monday', 2); // wk0 6/1-6/7, wk1 6/8-6/14

  it('places games on first and last day of a week', () => {
    const games = [
      { game_date: '2026-06-01', id: 'first' },
      { game_date: '2026-06-07', id: 'last' },
      { game_date: '2026-06-08', id: 'nextwk' },
    ];
    const b = bucketGamesByWeek(games, boundaries);
    expect(b.get(0).map(g => g.id)).toEqual(['first', 'last']);
    expect(b.get(1).map(g => g.id)).toEqual(['nextwk']);
  });

  it('drops games outside the window', () => {
    const games = [{ game_date: '2026-05-30' }, { game_date: '2026-07-01' }];
    const b = bucketGamesByWeek(games, boundaries);
    expect(b.get(0)).toHaveLength(0);
    expect(b.get(1)).toHaveLength(0);
  });

  it('keeps both halves of a doubleheader in the same week', () => {
    const games = [{ game_date: '2026-06-03', g: 1 }, { game_date: '2026-06-03', g: 2 }];
    const b = bucketGamesByWeek(games, boundaries);
    expect(b.get(0)).toHaveLength(2);
  });

  it('off-day week yields an empty bucket (not missing)', () => {
    const b = bucketGamesByWeek([{ game_date: '2026-06-02' }], boundaries);
    expect(b.has(1)).toBe(true);
    expect(b.get(1)).toHaveLength(0);
  });
});
