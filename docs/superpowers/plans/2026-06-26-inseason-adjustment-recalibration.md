<!-- /autoplan restore point: /c/Users/aok/.gstack/projects/aok17-fantasy-baseball/claude-awesome-heisenberg-ce626a-autoplan-restore-20260626-132604.md -->
# In-Season Adjustment Recalibration — Plan

**Branch:** claude/awesome-heisenberg-ce626a · **Date:** 2026-06-26 · **Base commit:** 483d86d

## Problem (confirmed with user)

The rankings board is sorted by `combined_rankings.adj_score`. That value is `raw_score + adjustment`:
- `raw_score` = SUMPRODUCT(projected stats × weights). **This already updates in-season** — `fetchFanGraphs` prefers rest-of-season (RoS) projections (`r{system}`), so by late June a starter's `raw_score` is computed off ~85 remaining IP, not ~190 full-season IP. Roughly **half scale**.
- `adjustment` = a set of **hardcoded constants calibrated against full-season projection magnitude**:
  - Pitcher ([pitcher-scoring.js:23-34](../../../server/src/scoring/pitcher-scoring.js)): `replacement_level=237`, cap `237*10/7*3/7`, floors `+165`, `+215`, `+71`, closer `-10`.
  - Batter ([batter-scoring.js:45](../../../server/src/scoring/batter-scoring.js)): flat position bonus C70/OF40/2B30/3B25/SS20/1B15/DH10.

**Bug:** the adjustment does not shrink with the projection horizon. When `raw_score` halves but `+165`/`+70`/etc. stay fixed, the adjustment is ~2× too large *relative to* the thing it adjusts. Effects:
- Relievers/closers over-valued (the `+71` relief floor and flat closer treatment dominate a half-scale board).
- Scarce-position batters over-valued (a flat `+70` on a half-scale catcher is ~28% boost vs the intended ~14%).
- SP ranking compressed by the `+165`/`+215` additive floors swamping smaller RoS spreads.

This is the same class of bug already fixed for the K%/BB% sub-models (commit 483d86d): replace a hardcoded constant with a value derived from the current data.

## Goal

Make the adjustment **scale-invariant**: derive it from the current projection distribution on every `rescoreAll`, so it stays calibrated whether `raw_score` is full-season (March) or rest-of-season (June). At season start the new behavior must be **identical** to today's (the recalibration is an identity when the projection scale matches the original calibration).

## Approach — DECIDED: Value Over Replacement (VOR) with role-split [user, 2026-06-26]

Replace the absolute floors with replacement-relative value, computed per role and per position from the **current** projection set every `rescoreAll`. Auto-scales by construction (no scalar, no uniformity assumption, no stale 237 anchor, no recurring recalibration). Keeps the existing SP-vs-RP `max()` split.

### Pitchers — `adj_2020_value = max(sp_vor, rp_vor)`
- `sp_vor = starting_pts − repl_SP`, where `repl_SP = starting_pts` of the replacement-level starter = the Nth-ranked SP (by `starting_pts`) in the current set. N = rosterable SP count across the league (config `replacement_sp_rank`).
- `rp_vor = relief_pts − repl_RP`, where `repl_RP = relief_pts` of the Mth-ranked reliever (config `replacement_rp_rank`).
- Both paths now sit on the same "points above replacement" axis, so `max()` is finally an apples-to-apples comparison (the old `+215` vs `+71` offsets were arbitrary and non-comparable — this is strictly more coherent).
- **The cap (`min(starting_pts·3/7, 237·10/7·3/7)`) and the two-start-week construct are dropped from player value.** Two-start-week value is a *volume* concept (a pitcher worth more because he starts twice that week) — that belongs in the planning module's deferred "expected weekly points" layer, not in rest-of-season player value. Clean separation: VOR = quality/value, planning = volume.

### Batters — `adj_score = raw_score − repl_batter(primary_position)`
- `repl_batter(pos)` = `raw_score` of the Nth-ranked batter *eligible at `pos`*, N = starting roster slots at that position across the league (config-driven from roster construction). Scarce positions (C) have a low replacement → a natural positive premium; deep positions (1B/OF/DH) have a high replacement → small/zero premium.
- This *derives* the C70…DH10 ladder from data instead of hand-tuning it, and auto-scales with the projection horizon. The flat `position_adjustments` table becomes the fallback / override only.

### Replacement-cohort definition (determinism — Eng-F9)
- SP universe = pitchers with `GS > 0`; RP universe = `GS === 0` (or `G > GS`-heavy via existing `display_position`). Sort each by the relevant points field, read the value at the configured rank (tie-safe: read the numeric value, not the row).
- Roster-slot config (slots/position × teams, + bench buffer) seeded from ESPN league 133164 settings; surfaced in Settings so it's adjustable.

### Hardening (carried over from review — all still apply)
- Fallback to the existing flat constants when the cohort is empty / smaller than the rank (thin early-season data) — mirrors `fitKCoefficients`' fallback.
- Guard against `repl ≤ 0` and degenerate sets; never emit NaN into the sort.
- Persist `last_replacement_SP/RP` + per-position replacement to `app_config` for debugging; `console.log` each rescore.
- Success metric: Spearman rank-correlation of the new board vs `espn_rank` and vs `fetchFanGraphsActual` season-to-date — sanity-check that June ranks track reality.

> Sub-decisions from the gate (scale the batter ladder? per-role scale? uniformity check?) are **moot under VOR** — replacement is derived per-role and per-position directly.

## STATUS: IMPLEMENTED (Approach B, fully magic-free) — 2026-06-26

Replacement level = league roster depth (`leagueSize × startingSlots[pos]`), both pulled
from live ESPN `mSettings` (10-team; OF=5, P=8, RP=1, etc.), seeded as fallback.
- New pure module `server/src/scoring/replacement.js` (`computeReplacement`, `slotsFromEspn`, `batterReplacement`).
- `pitcher-scoring.js`/`batter-scoring.js` now emit raw components; `applyPitcherVOR`/`applyBatterVOR` apply role-split / positional VOR.
- `rescoreAll` derives replacement from the full pool, applies VOR, persists `last_replacement_sp/rp/by_pos`.
- `rosters.js` fetches `mSettings` → `league_size` + `roster_slots`. `config.js` rescore triggers updated.
- Removed: `replacement_level=237`, `+215/+71/+165`, cap `3/7·10/7`, closer `-10`, `posAdj` C70…DH10 ladder (table left inert).
- Tests: 140/140 green; new `replacement.test.js`; pitcher/batter tests rewritten to VOR; e2e sanity confirms scarcity premium emerges (a weaker catcher outranks a stronger OF) and replacement players sit at 0 VOR.

Follow-up (out of scope, flagged): Settings UI still shows the now-inert position-adjustment + replacement-level editors; rewire to expose `league_size`/`roster_slots` instead.

## What already exists (reused)

- `rescoreAll` ([rescore.js:119](../../../server/src/scoring/rescore.js)) — single rescore entry point; reads weights/posAdj/replacement_level from DB. The scale derivation slots in here.
- `computePitcherScores` / `computeBatterScores` — take `replacementLevel` / `posAdj` as params already. Threading a `scale` (or pre-scaled values) is a minimal signature change.
- Precedent for data-fitting: `fitKCoefficients` / `fitBBCoefficients` ([pitcher-model.js](../../../server/src/scoring/pitcher-model.js)) — same "derive from current starts, fall back to constant on thin data" pattern to mirror.
- `pitchers_raw` ordered by `raw_score` gives the replacement-rank lookup with no new fetch.

## NOT in scope (deferred)

- Folding the recent-form `pitcher_model` into `adj_score` (separate feature; user is scraping updated projections, so the projection path is the right lever here).
- Batter in-season recent-form model.
- Weekly volume-aware "expected weekly points" (planning module's deferred layer).
- Changing the scoring weights or the two-start-week *concept* (only its scale).

## Open questions for review

- Exact N (rosterable SP count) and whether replacement should be per-role (SP vs RP) or single.
- Whether batter replacement should also be data-derived per position (ties into the VOR alternative).
- Backfill: does a season-start snapshot of `replacement_baseline` need storing, or is 237 a fine fixed baseline anchor?

---

# /autoplan Review — CEO + Eng (Codex unavailable → subagent-only voices)

## CRITICAL CORRECTION (both voices, independent) — constant inventory was wrong

The pitcher board sort key `combined_rankings.adj_score` = `adj_2020_value` ([combined.js:11](../../../server/src/scoring/combined.js)), **not** `raw_score + adjustment`. The live, board-driving constants are:

| Constant | Value | Expression | Live on board? |
|---|---|---|---|
| SP floor | `+215` | `sp_value = -min(starting_pts·3/7, CAP) + 215 + starting_pts` | ✅ pitcher sort |
| Relief floor | `+71` | `rp_value = relief_pts + 71` | ✅ pitcher sort |
| Cap basis | `237·10/7·3/7 ≈ 145` | the `min()` ceiling | ✅ pitcher sort |
| Ratios | `3/7`, `10/7` | dimensionless | (stay fixed) |
| Pitcher `adjustment` | `+165`, closer `-10` | stored in `pitcher_scores.adjustment/adj_score` | ❌ **DEAD** — never joined to board |
| Batter pos ladder | C70…DH10 | `adj_score = raw_score + posAdj[pos]` | ✅ batter sort |

→ The recalibration must target `+215`, `+71`, the cap, and the batter ladder. The `+165`/closer-`-10` path is dead code (defer cleanup to TODOS).

## CEO Phase (strategy)

**0A Premise (USER-CONFIRMED, gate satisfied):** raw_score already updates in-season via RoS projections; the bug is the frozen full-season adjustment scale. Accepted.

**0B Existing code leverage:** `rescoreAll` is the single rescore seam (reads weights/posAdj/replacement_level, holds `rawPitchers` in memory). `fitKCoefficients`/`fitBBCoefficients` are the exact precedent (derive-from-data + fallback-on-thin-data). No parallel system needed — slot the derivation into `rescoreAll`, thread a `scale` param.

**0C Dream state:**
```
CURRENT (June)                  THIS PLAN                       12-MONTH IDEAL
adj_score frozen at      -->    adjustment self-calibrates -->  every value term is
full-season scale;              to current projection           replacement-relative by
mid-season ranks wrong          horizon; ranks track RoS        construction (VOR), no
                                                                magic constants to babysit
```
The 12-month ideal IS the VOR endpoint both voices flagged. The scale-anchor is a way-station; VOR is the destination.

**0C-bis Implementation alternatives (corrected):**

```
APPROACH A — Scale anchor (plan's original recommendation)
  Derive replacement_now from data, scale = clamp(replacement_now/baseline), multiply
  live constants (215, 71, cap, batter ladder) by scale. Threads scale param through 2 scorers.
  Effort: M · Risk: Med · Reuses: rescoreAll, fitK precedent
  Pro: smallest conceptual change; explicit season-start identity
  Con: single scalar assumes uniform RoS compression (CEO-F3); cap-branch breaks linearity for
       top SPs (CEO-F4); borrows SP horizon for relief + batters (Eng-F10/CEO-F6); stale 237 anchor

APPROACH B — VOR with role-split preserved (both voices recommend)
  adj = raw_score − replacement_points, computed per role (SP/RP) and per batter position from
  the CURRENT projection set; keep the max(sp,rp) split. Deletes 215/71/cap/237/scale/identity.
  Effort: M · Risk: Med · Reuses: same seam, same Nth-rank derivation
  Pro: auto-scales by construction (no uniformity assumption); no recurring recalibration debt;
       per-role/per-position replacement is the correct instrument; plausibly LESS code
  Con: bigger diff to scoring core; numbers move more vs March (weaker "identity"); must define
       replacement cohort per role/position

APPROACH C — Do nothing / manual reseed of 237 each month
  Effort: S · Risk: High (silent staleness) · Rejected: this is the bug.
```

**CEO consensus (subagent-only; Codex N/A):**
```
  Dimension                            Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ────── ─────────
  1. Premises valid?                   YES     N/A    user-confirmed
  2. Right problem?                    YES*    N/A    *fix the right CONSTANTS (adj_2020_value)
  3. Scope calibration?                EXPAND  N/A    add hardening + validation metric
  4. Alternatives explored?            NO→FIX  N/A    VOR was under-costed; now corrected
  5. Competitive/market risk?          N/A     N/A    solo tool
  6. 6-month trajectory?               RISK    N/A    no validation signal → define success metric
```

## Eng Phase (architecture / edge cases / tests)

**Architecture (where scale/VOR lives):**
```
rescoreAll(db)
  ├─ rawPitchers ─┬─► deriveReplacement(rawPitchers, weights, {role, n})  ◄── NEW pure helper
  │               │      returns replacement_now per role (SP/RP)        (exported, unit-tested)
  │               └─► computePitcherScores(raw, weights, replLevel, scaleOrRepl)  ◄── +1 param (default → identity)
  ├─ rawBatters ────► computeBatterScores(raw, weights, posAdj, scaleOrRepl)      ◄── +1 param (default → identity)
  ├─ buildCombinedRankings(...)  (unchanged)
  └─ persist last_scale / last_replacement_now → app_config  ◄── NEW observability
```
Call-site audit done: only `rescore.js:127,149` + the 4 scoring test files call these fns → trailing optional param is safe (Eng-F15 resolved).

**Failure modes & edge-case registry (auto-decided fixes folded into plan):**

| Codepath | Failure mode | Handling (DECIDED) | Principle |
|---|---|---|---|
| deriveReplacement | empty / `< N` SPs | fallback `scale=1` (identity), never NaN | P1 no silent fail |
| deriveReplacement | `replacement_now ≤ 0` | clamp + positivity guard → `scale=1` | P1 |
| deriveReplacement | huge full-season value | asymmetric clamp `scale ≤ 1.0` (shrink-only) | P1 |
| "Nth SP" definition | swingman/opener miscount | define SP universe = `GS > 0` on raw, sort by raw_score, read value (tie-safe); N in `app_config` | P5 explicit |
| cap term | double-count (scale × replacement) | keep `replacement_level=237` fixed; multiply whole adj expr by scale ONCE; lock with test | P5 |
| baseline anchor | user edits live `replacement_level` | separate frozen `replacement_baseline` config key | P5 |
| max(sp,rp) branch | discontinuous swingman rerank | regression test pins branch at scale 1.0 & 0.5 | P1 |
| mixed RoS+full rows | global scalar mis-scales | document precondition; warn on bimodal IP | P6 |
| no validation signal | silent mis-rank all season | success metric = rank-corr vs `espn_rank` + `fetchFanGraphsActual` | P1 |

**Eng consensus (subagent-only; Codex N/A):**
```
  Dimension                            Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ────── ─────────
  1. Architecture sound?               YES+    N/A    extract deriveReplacement as pure helper
  2. Test coverage sufficient?         NO→FIX  N/A    19-case plan written (artifact on disk)
  3. Performance risks?                NONE    N/A    one extra sort over rawPitchers, negligible
  4. Security threats?                 N/A     N/A    local tool, no new surface
  5. Error paths handled?              GAPS    N/A    clamp+fallback+NaN guard now specified
  6. Deployment risk?                  LOW     N/A    pure recompute on next rescore; reversible
```

## Test diagram → coverage (pure functions, 100% target)

```
deriveReplacement()  → T9 identity(=1) · T10 half-scale · T11 empty→1 · T12 <N→1
                       · T13 zero→1 · T14 neg→1 · T15 huge→clamp · T16 RP-only→1
computePitcherScores(scale) → T1 scale=1 reproduces 513.90 (IDENTITY) · T2 SP floors halve
                       · T3 relief branch · T4 closer · T5 cap single-count
computeBatterScores(scale)  → T6 ladder identity · T7 half-scale ladder · T8 DH fallback
rescoreAll (DB integration) → T17 existing 3 pass · T18 closers/catchers rank lower at half-scale
                       · T19 scale persisted to app_config
```

## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale |
|---|---|---|---|---|---|
| 1 | CEO | Correct constant inventory to `adj_2020_value` (215/71/cap), not +165 | Mechanical | correctness | both voices; combined.js:11 |
| 2 | CEO | Treat +165/closer-10 as dead → cleanup TODO, not in scope | Mechanical | P3 | never joined to board |
| 3 | Eng | Clamp scale to (0,1] + positivity guard + fallback=1 | Mechanical | P1 | no silent NaN/sign-flip |
| 4 | Eng | Define SP universe = GS>0, sort by raw_score, N in app_config | Mechanical | P5 | determinism |
| 5 | Eng | Cap: keep 237 fixed, multiply once; no double-count | Mechanical | P5 | F11 |
| 6 | Eng | Separate frozen `replacement_baseline` key | Mechanical | P5 | identity survives config edits |
| 7 | Eng | Extract `deriveReplacement` exported pure helper | Mechanical | testability | unit-test without DB |
| 8 | Eng | Persist last_scale/last_replacement_now + log | Mechanical | observability | breadcrumb for wrong scale |
| 9 | CEO | Add success metric (rank-corr vs espn_rank/actuals) | Mechanical | P1 | no validation signal otherwise |
| 10 | CEO | Pre-build 20-min empirical check: is RoS compression uniform? | Taste→gate | P6 | gates A-vs-B |
| 11 | CEO/Eng | Approach A (scale) vs B (VOR role-split) | **TASTE→gate** | — | both voices prefer B |
| 12 | CEO | Scale batter position ladder at all? (scarcity may be horizon-invariant) | Taste→gate | — | conditional on A |
| 13 | Eng | Per-role SP/RP scale vs single SP-derived | Taste→gate | — | conditional on A |

## NOT in scope (deferred → TODOS)

- Delete the dead pitcher `adjustment`/`adj_score` (+165/closer-10) fields and the `pitcher_scores` columns.
- Folding the recent-form `pitcher_model` into the board (separate feature).
- Batter in-season recent-form model.
- Weekly volume-aware "expected weekly points."

## Test plan

Full 19-case plan written to disk: see the test-plan artifact referenced in the gate. Pure-function recalibration → 100% unit coverage with synthetic full/half-scale projection sets; season-start identity (`scale=1` reproduces `adj_2020_value=513.90`) is the headline assertion; `rescoreAll` keeps its 3 existing integration tests green.
