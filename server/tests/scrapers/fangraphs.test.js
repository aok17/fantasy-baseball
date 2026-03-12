import { describe, it, expect } from 'vitest';
import { parsePitcherCsv, parseBatterCsv } from '../../src/scrapers/fangraphs.js';

const pitcherCsvSample = `Name,Team,GS,G,IP,W,L,QS,SV,HLD,H,ER,HR,SO,BB,WHIP,K/9,BB/9,ERA,FIP,WAR,RA9-WAR,playerid
"Gerrit Cole",NYY,32,32,200.0,16,6,24,0,0,160,65,22,230,45,1.02,10.35,2.03,2.93,3.10,5.2,5.5,13125`;

const batterCsvSample = `Name,Team,G,PA,AB,H,2B,3B,HR,R,RBI,BB,SO,HBP,SB,CS,AVG,OBP,SLG,OPS,wOBA,wRC+,BsR,Fld,Off,Def,WAR,playerid
"Mookie Betts",LAD,150,650,570,170,35,4,30,110,95,70,100,5,15,3,.298,.384,.540,.924,.380,155,3.5,5.0,35.0,7.0,7.5,13611`;

describe('parsePitcherCsv', () => {
  it('parses CSV into pitcher objects', async () => {
    const result = await parsePitcherCsv(pitcherCsvSample);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Gerrit Cole');
    expect(result[0].team).toBe('NYY');
    expect(result[0].IP).toBe(200);
    expect(result[0].SO).toBe(230);
    expect(result[0].player_id).toBe('13125');
  });
});

describe('parseBatterCsv', () => {
  it('parses CSV into batter objects', async () => {
    const result = await parseBatterCsv(batterCsvSample);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Mookie Betts');
    expect(result[0].HR).toBe(30);
    expect(result[0].SB).toBe(15);
  });
});
