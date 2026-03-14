import { describe, it, expect } from 'vitest';
import { parseEspnResponse, ESPN_SLOT_TO_POSITION } from '../../src/scrapers/espn.js';

const sampleResponse = {
  players: [
    {
      player: { fullName: 'Shohei Ohtani', id: 39832, defaultPositionId: 10, eligibleSlots: [11, 13, 14, 16, 17], draftRanksByRankType: { STANDARD: { rank: 1 } } },
      ratings: { '0': { positionalRanking: 1, totalRating: 450.5 } },
    },
    {
      player: { fullName: 'Mookie Betts', id: 33039, defaultPositionId: 6, eligibleSlots: [4, 6, 19, 10, 5, 12, 16, 17], draftRanksByRankType: { STANDARD: { rank: 9 } } },
      ratings: { '0': { positionalRanking: 3, totalRating: 380.2 } },
    },
    {
      player: { fullName: 'Logan Webb', id: 41278, defaultPositionId: 1, eligibleSlots: [13, 14, 16, 17], draftRanksByRankType: { STANDARD: { rank: 45 } } },
      ratings: { '0': { positionalRanking: 10, totalRating: 200.0 } },
    },
    {
      player: { fullName: 'Cal Raleigh', id: 41345, defaultPositionId: 2, eligibleSlots: [0, 12, 16, 17], draftRanksByRankType: { STANDARD: { rank: 12 } } },
      ratings: { '0': { positionalRanking: 5, totalRating: 150.0 } },
    },
  ],
};

describe('parseEspnResponse', () => {
  it('extracts name, adp_rank from STANDARD draft rank, projected_points', () => {
    const result = parseEspnResponse(sampleResponse);
    const mookie = result.find(p => p.name === 'Mookie Betts');
    expect(mookie.adp_rank).toBe(9); // STANDARD.rank
    expect(mookie.projected_points).toBeCloseTo(380.2);
    const raleigh = result.find(p => p.name === 'Cal Raleigh');
    expect(raleigh.adp_rank).toBe(12); // STANDARD.rank
  });

  it('maps eligibleSlots to position strings for hitters', () => {
    const result = parseEspnResponse(sampleResponse);
    const mookie = result.find(p => p.name === 'Mookie Betts');
    expect(mookie.positions).toEqual(['SS', 'OF']);
  });

  it('returns empty positions array for pitchers (defaultPositionId 1 or 11)', () => {
    const result = parseEspnResponse(sampleResponse);
    const webb = result.find(p => p.name === 'Logan Webb');
    expect(webb.positions).toEqual([]);
  });

  it('maps catcher slot correctly', () => {
    const result = parseEspnResponse(sampleResponse);
    const raleigh = result.find(p => p.name === 'Cal Raleigh');
    expect(raleigh.positions).toEqual(['C']);
  });

  it('handles DH-type players (defaultPositionId 10) as hitters', () => {
    const result = parseEspnResponse(sampleResponse);
    const ohtani = result.find(p => p.name === 'Shohei Ohtani');
    // Ohtani has no standard position slots (0-5), just DH/UTIL/P slots
    expect(ohtani.positions).toEqual([]);
  });
});

describe('ESPN_SLOT_TO_POSITION', () => {
  it('maps all 6 standard hitter slots', () => {
    expect(ESPN_SLOT_TO_POSITION[0]).toBe('C');
    expect(ESPN_SLOT_TO_POSITION[1]).toBe('1B');
    expect(ESPN_SLOT_TO_POSITION[2]).toBe('2B');
    expect(ESPN_SLOT_TO_POSITION[3]).toBe('3B');
    expect(ESPN_SLOT_TO_POSITION[4]).toBe('SS');
    expect(ESPN_SLOT_TO_POSITION[5]).toBe('OF');
  });
});
