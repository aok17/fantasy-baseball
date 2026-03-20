// server/src/seed.js

export function seedDefaults(db) {
  const insertWeight = db.prepare(
    'INSERT OR IGNORE INTO scoring_config (category, stat, weight) VALUES (?, ?, ?)'
  );

  const pitcherWeights = [
    ['IP', 2.1], ['W', 3.5], ['L', -1.0], ['QS', 2.0], ['SV', 5.0],
    ['H', -0.6], ['ER', -1.5], ['SO', 1.0], ['BB', -0.5],
  ];
  for (const [stat, weight] of pitcherWeights) {
    insertWeight.run('pitcher', stat, weight);
  }

  const batterWeights = [
    ['H', 1.0], ['2B', 1.0], ['3B', 2.0], ['HR', 3.1], ['R', 1.1],
    ['RBI', 1.1], ['BB', 1.0], ['SO', -1.0], ['SB', 2.0],
  ];
  for (const [stat, weight] of batterWeights) {
    insertWeight.run('batter', stat, weight);
  }

  const insertAdj = db.prepare(
    'INSERT OR IGNORE INTO position_adjustments (position, adjustment) VALUES (?, ?)'
  );
  const posAdj = [
    ['C', 70], ['OF', 40], ['2B', 30], ['3B', 25],
    ['SS', 20], ['1B', 15], ['Other', 10],
  ];
  for (const [pos, adj] of posAdj) {
    insertAdj.run(pos, adj);
  }

  const insertConfig = db.prepare(
    'INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)'
  );
  insertConfig.run('replacement_level', '237');
  insertConfig.run('projection_system', 'steamer');
  insertConfig.run('season_year', '2026');
  insertConfig.run('espn_league_id', '133164');
  insertConfig.run('espn_team_id', '7');
  insertConfig.run('espn_bot_swid', process.env.ESPN_BOT_SWID || '');
  insertConfig.run('espn_bot_s2', process.env.ESPN_BOT_S2 || '');
}
