import { describe, it, expect } from 'vitest';
import { mapPitcher, mapBatter } from '../../src/scrapers/fangraphs.js';

describe('mapPitcher', () => {
  it('maps JSON record to pitcher object', () => {
    const result = mapPitcher({
      PlayerName: 'Gerrit Cole', Team: 'NYY',
      GS: 32, G: 32, IP: 200.0, W: 16, L: 6, QS: 24,
      SV: 0, HLD: 0, H: 160, ER: 65, HR: 22,
      SO: 230, BB: 45, WHIP: 1.02, 'K/9': 10.35, 'BB/9': 2.03,
      ERA: 2.93, FIP: 3.10, WAR: 5.2, 'RA9-WAR': 5.5, playerid: '13125',
    });
    expect(result.name).toBe('Gerrit Cole');
    expect(result.team).toBe('NYY');
    expect(result.IP).toBe(200);
    expect(result.SO).toBe(230);
    expect(result.fg_id).toBe('13125');
  });
});

describe('mapBatter', () => {
  it('maps JSON record to batter object', () => {
    const result = mapBatter({
      PlayerName: 'Mookie Betts', Team: 'LAD',
      G: 150, PA: 650, AB: 570, H: 170, '2B': 35, '3B': 4,
      HR: 30, R: 110, RBI: 95, BB: 70, SO: 100, HBP: 5,
      SB: 15, CS: 3, AVG: .298, OBP: .384, SLG: .540, OPS: .924,
      wOBA: .380, 'wRC+': 155, wBsR: 3.5, Def: 7.0,
      Off: 35.0, WAR: 7.5, playerid: '13611',
    });
    expect(result.name).toBe('Mookie Betts');
    expect(result.HR).toBe(30);
    expect(result.SB).toBe(15);
    expect(result.fg_id).toBe('13611');
  });
});
