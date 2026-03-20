import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { seedDefaults } from '../../src/seed.js';
import { createRankingsRouter } from '../../src/routes/rankings.js';
import express from 'express';

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
