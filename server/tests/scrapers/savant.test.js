import { describe, it, expect } from 'vitest';
import { parseSavantCsv } from '../../src/scrapers/savant.js';

const csvSample = `pitches,player_id,player_name,total_pitches,pitch_type,pitch_percent,ba,iso,babip,slg,woba,xwoba,xba,hits,abs,launch_speed,launch_angle,spin_rate,velocity
120,543037,"Verlander, Justin",2800,FF,55.2,.220,.150,.280,.370,.310,.300,.210,95,432,91.5,12.3,2350,95.8`;

describe('parseSavantCsv', () => {
  it('parses CSV and converts names from Last,First to First Last', async () => {
    const result = await parseSavantCsv(csvSample, 2024, 'regular');
    expect(result).toHaveLength(1);
    expect(result[0].player_name).toBe('Justin Verlander');
    expect(result[0].player_id).toBe('543037');
    expect(result[0].velocity).toBe(95.8);
    expect(result[0].season).toBe(2024);
    expect(result[0].season_type).toBe('regular');
  });
});
