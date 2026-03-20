import { describe, it, expect } from 'vitest';
import { buildCombinedRankings } from '../../src/scoring/combined.js';

describe('buildCombinedRankings', () => {
  const pitchers = [
    { name: 'Ace SP', team: 'NYY', display_position: 'SP', raw_score: 500, adj_2020_value: 600, pts_per_appearance: 15 },
    { name: 'Setup RP', team: 'BOS', display_position: 'RP', raw_score: 100, adj_2020_value: 171, pts_per_appearance: 3 },
  ];
  const batters = [
    { name: 'Slugger', team: 'LAD', position: 'OF', raw_score: 450, adj_score: 490, pts_per_game: 3.2 },
    { name: 'Catcher', team: 'STL', position: 'C', raw_score: 200, adj_score: 270, pts_per_game: 1.8 },
  ];
  const idMap = {
    'Ace SP|NYY': 1,
    'Setup RP|BOS': 2,
    'Slugger|LAD': 3,
    'Catcher|STL': 4,
  };
  const espnRank = { 1: 5, 3: 3, 4: 80 };
  const velocityDeltas = { 1: { delta: -1.2, velo_prev: 96, velo_curr: 94.8, velo_n: 10 }, 2: { delta: 0.5, velo_prev: 93, velo_curr: 93.5, velo_n: 5 } };

  it('ranks by adj_score descending', () => {
    const result = buildCombinedRankings(pitchers, batters, espnRank, velocityDeltas, idMap);
    expect(result[0].name).toBe('Ace SP');
    expect(result[1].name).toBe('Slugger');
  });

  it('computes value_gap as rank minus espn_rank', () => {
    const result = buildCombinedRankings(pitchers, batters, espnRank, velocityDeltas, idMap);
    const ace = result.find(r => r.name === 'Ace SP');
    expect(ace.value_gap).toBe(ace.rank - 5);
  });

  it('sets velocity_delta to null for batters', () => {
    const result = buildCombinedRankings(pitchers, batters, espnRank, velocityDeltas, idMap);
    const slugger = result.find(r => r.name === 'Slugger');
    expect(slugger.velocity_delta).toBeNull();
  });

  it('uses pitcher display_position for position column', () => {
    const result = buildCombinedRankings(pitchers, batters, espnRank, velocityDeltas, idMap);
    expect(result.find(r => r.name === 'Ace SP').position).toBe('SP');
  });

  it('breaks ties by score DESC then name ASC', () => {
    const tiedPitchers = [
      { name: 'Beta', team: 'A', display_position: 'SP', raw_score: 300, adj_2020_value: 400, pts_per_appearance: 10 },
      { name: 'Alpha', team: 'B', display_position: 'SP', raw_score: 300, adj_2020_value: 400, pts_per_appearance: 10 },
    ];
    const tiedIdMap = { 'Beta|A': 10, 'Alpha|B': 11 };
    const result = buildCombinedRankings(tiedPitchers, [], {}, {}, tiedIdMap);
    expect(result[0].name).toBe('Alpha');
    expect(result[1].name).toBe('Beta');
  });

  it('includes player_id in output rows', () => {
    const result = buildCombinedRankings(pitchers, batters, espnRank, velocityDeltas, idMap);
    expect(result.find(r => r.name === 'Ace SP').player_id).toBe(1);
    expect(result.find(r => r.name === 'Slugger').player_id).toBe(3);
  });
});
