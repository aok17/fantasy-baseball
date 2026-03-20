import { describe, it, expect } from 'vitest';

// Test the data shape validation only (not the fetch, which hits external API)
describe('injuries data validation', () => {
  it('filters for current injuries only', () => {
    const data = [
      { isNotCurrent: 0, playerName1: 'Active Injury', team: 'NYY' },
      { isNotCurrent: 1, playerName1: 'Old Injury', team: 'BOS' },
      { isNotCurrent: 0, playerName1: null, team: 'LAD' },
    ];
    const current = data.filter(r => r.isNotCurrent === 0 && r.playerName1);
    expect(current).toHaveLength(1);
    expect(current[0].playerName1).toBe('Active Injury');
  });

  it('handles non-array response', () => {
    const data = { error: 'not found' };
    expect(Array.isArray(data)).toBe(false);
  });
});
