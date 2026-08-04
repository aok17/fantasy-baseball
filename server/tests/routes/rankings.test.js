import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seedDefaults } from '../../src/seed.js';
import { createRankingsRouter } from '../../src/routes/rankings.js';
import express from 'express';
import { createDb } from '../../src/db.js';
import { rescoreAll } from '../../src/scoring/rescore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('rankings API', () => {
  let db, app, server;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(readFileSync(join(__dirname, '..', '..', 'src', 'schema.sql'), 'utf8'));
    seedDefaults(db);

    db.prepare(`INSERT INTO players (id, name, team) VALUES (1, 'Player A', 'NYY')`).run();
    db.prepare(`INSERT INTO players (id, name, team) VALUES (2, 'Player B', 'LAD')`).run();

    db.prepare(`INSERT INTO combined_rankings (player_id, rank, name, team, position, score, adj_score, espn_rank, velocity_delta, per_game_efficiency, value_gap) VALUES (1, 1, 'Player A', 'NYY', 'SP', 500, 600, 3, -1.2, 15.0, -2)`).run();
    db.prepare(`INSERT INTO combined_rankings (player_id, rank, name, team, position, score, adj_score, espn_rank, velocity_delta, per_game_efficiency, value_gap) VALUES (2, 2, 'Player B', 'LAD', 'OF', 450, 490, 5, null, 3.2, -3)`).run();

    app = express();
    app.use(express.json());
    app.use('/api/rankings', createRankingsRouter(db));
    await new Promise(resolve => { server = app.listen(0, resolve); });
  });

  afterEach(() => { server.close(); db.close(); });

  it('GET /api/rankings returns all ranked players', async () => {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/rankings`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].rank).toBe(1);
  });

  it('PUT /api/rankings/notes saves and retrieves notes by player_id', async () => {
    const port = server.address().port;
    await fetch(`http://localhost:${port}/api/rankings/notes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: 1, note: 'Great pitcher' }),
    });
    const res = await fetch(`http://localhost:${port}/api/rankings`);
    const body = await res.json();
    const playerA = body.find(p => p.name === 'Player A');
    expect(playerA.note).toBe('Great pitcher');
  });
});

describe('rankings query fan-out', () => {
  // Every LEFT JOIN in the rankings query must match at most one row per player,
  // or the player is listed twice at identical rank and score. Two tables broke
  // that in production: injuries (UNIQUE(name, team), so a traded player keeps a
  // stale row under his old club) and savant_expected (UNIQUE(mlbam_id,
  // player_type), so one player can hold both a pitcher and a batter profile).
  function withPitcher() {
    const db = createDb(':memory:');
    db.prepare(`INSERT INTO pitchers_raw (name, team, GS, G, IP, W, L, QS, SV, HLD, H, ER, HR, SO, BB)
      VALUES ('Trade Guy','MIL',30,30,180,12,8,18,0,0,160,70,15,180,45)`).run();
    rescoreAll(db);
    return { db, pid: db.prepare("SELECT id FROM players WHERE name='Trade Guy'").get().id };
  }

  async function rows(db) {
    const app = express();
    app.use('/api/rankings', createRankingsRouter(db));
    const srv = app.listen(0);
    const out = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/rankings`)).json();
    srv.close();
    const arr = Array.isArray(out) ? out : (out.players || []);
    return arr.filter(r => r.name === 'Trade Guy');
  }

  it('lists a traded player once and uses his current injury row', async () => {
    const { db, pid } = withPitcher();
    const s = db.prepare('INSERT INTO injuries (player_id, name, team, latest_update) VALUES (?,?,?,?)');
    s.run(pid, 'Trade Guy', 'CHW', 'stale');
    s.run(pid, 'Trade Guy', 'MIL', 'current');
    rescoreAll(db);

    const r = await rows(db);
    expect(r).toHaveLength(1);
    expect(r[0].injury).toBe('current');
  });

  it('lists a player with both savant profiles once, picking the one for his type', async () => {
    const { db, pid } = withPitcher();
    const s = db.prepare('INSERT INTO savant_expected (player_id, mlbam_id, player_name, player_type, xwoba) VALUES (?,?,?,?,?)');
    s.run(pid, '111', 'Trade Guy', 'P', 0.301);
    s.run(pid, '222', 'Trade Guy', 'B', 0.322);

    const r = await rows(db);
    expect(r).toHaveLength(1);
    expect(r[0].xwoba).toBeCloseTo(0.301, 3); // the pitcher profile
  });

  it('stays single-rowed when both duplications happen together', async () => {
    const { db, pid } = withPitcher();
    const i = db.prepare('INSERT INTO injuries (player_id, name, team, latest_update) VALUES (?,?,?,?)');
    i.run(pid, 'Trade Guy', 'CHW', 'stale'); i.run(pid, 'Trade Guy', 'MIL', 'current');
    const s = db.prepare('INSERT INTO savant_expected (player_id, mlbam_id, player_name, player_type, xwoba) VALUES (?,?,?,?,?)');
    s.run(pid, '111', 'Trade Guy', 'P', 0.301); s.run(pid, '222', 'Trade Guy', 'B', 0.322);
    rescoreAll(db);

    expect(await rows(db)).toHaveLength(1);
  });
});
