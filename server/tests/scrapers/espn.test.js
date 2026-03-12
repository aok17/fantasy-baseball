import { describe, it, expect } from 'vitest';
import { parseEspnResponse } from '../../src/scrapers/espn.js';

const sampleResponse = {
  players: [
    { player: { fullName: 'Shohei Ohtani', id: 39832 }, ratings: { '0': { positionalRanking: 1, totalRating: 450.5 } } },
    { player: { fullName: 'Mookie Betts', id: 33039 }, ratings: { '0': { positionalRanking: 3, totalRating: 380.2 } } },
  ],
};

describe('parseEspnResponse', () => {
  it('extracts name, adp_rank, projected_points', () => {
    const result = parseEspnResponse(sampleResponse);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Shohei Ohtani');
    expect(result[0].adp_rank).toBe(1);
    expect(result[0].projected_points).toBeCloseTo(450.5);
  });
});
