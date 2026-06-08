import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fitKCoefficients } from '../../src/scoring/pitcher-model.js';
import { seedDefaults } from '../../src/seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function freshDb() {
  const db = new Database(':memory:');
  const schema = readFileSync(join(__dirname, '..', '..', 'src', 'schema.sql'), 'utf8');
  db.exec(schema);
  seedDefaults(db);
  return db;
}

// Generate starts where SO/PA follows a known linear relation in SwStr% and CStr%,
// so OLS should recover the generating coefficients.
function seedLinearStarts(db, { a, b, c }) {
  const ins = db.prepare(`
    INSERT INTO pitcher_starts (mlbam_id, player_name, game_date, season,
      total_pitches, pa, whiffs, called_strikes, so)
    VALUES (?, 'Synthetic', ?, 2026, ?, ?, ?, ?, ?)
  `);
  let id = 0;
  for (let tp = 80; tp <= 110; tp += 2) {
    for (const swPct of [9, 13, 17]) {
      for (const csPct of [12, 16]) {
        id++;
        const whiffs = Math.round((swPct / 100) * tp);
        const cstr = Math.round((csPct / 100) * tp);
        const pa = 25;
        const swstrPct = (whiffs / tp) * 100;
        const cstrPct = (cstr / tp) * 100;
        const kPct = a * swstrPct + b * cstrPct + c; // percentage points
        const so = (kPct / 100) * pa;
        ins.run(String(id), `2026-${String(id).padStart(4, '0')}`, tp, pa, whiffs, cstr, so);
      }
    }
  }
}

describe('fitKCoefficients', () => {
  it('recovers known linear K% coefficients (xK% = a*SwStr% + b*CStr% + c) via OLS', () => {
    const db = freshDb();
    const truth = { a: 1.8, b: 0.9, c: -3.0 };
    seedLinearStarts(db, truth);

    const fit = fitKCoefficients(db);
    expect(fit.a).toBeCloseTo(truth.a, 2);
    expect(fit.b).toBeCloseTo(truth.b, 2);
    expect(fit.c).toBeCloseTo(truth.c, 2);
    db.close();
  });

  it('falls back to published coefficients when too few starts', () => {
    const db = freshDb();
    const fit = fitKCoefficients(db);
    expect(fit).toEqual({ a: 1.2, b: 0.6, c: -4.0 });
    db.close();
  });

  it('is unbiased where the fixed published formula is biased low', () => {
    const db = freshDb();
    // A population whose true K% sits well above the published formula's output.
    const truth = { a: 1.8, b: 0.9, c: -3.0 };
    seedLinearStarts(db, truth);

    const fit = fitKCoefficients(db);

    // Mean signed residual of the fitted model should be ~0; the fixed published
    // formula should be biased negative on the same data.
    const rows = db.prepare(`
      SELECT total_pitches, whiffs, called_strikes, so, pa FROM pitcher_starts
    `).all();
    let fittedBias = 0, publishedBias = 0;
    for (const r of rows) {
      const sw = (r.whiffs / r.total_pitches) * 100;
      const cs = (r.called_strikes / r.total_pitches) * 100;
      const actualKPct = (r.so / r.pa) * 100;
      fittedBias += (fit.a * sw + fit.b * cs + fit.c) - actualKPct;
      publishedBias += (1.2 * sw + 0.6 * cs - 4.0) - actualKPct;
    }
    fittedBias /= rows.length;
    publishedBias /= rows.length;

    expect(Math.abs(fittedBias)).toBeLessThan(0.1);
    expect(publishedBias).toBeLessThan(-1); // published formula under-predicts
    db.close();
  });
});
