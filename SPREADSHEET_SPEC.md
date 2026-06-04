# 2025 Fantasy Baseball Spreadsheet - Functional Specification

## Overview

A 28-sheet Excel workbook for fantasy baseball draft preparation, in-season roster management, and pitcher streaming decisions. The system uses a custom points-based scoring system, aggregates projection data from FanGraphs, incorporates Statcast pitch-level data from Baseball Savant, and pulls schedule data from ESPN. It was originally built in Google Sheets (several formulas use `IMPORTHTML` and `DUMMYFUNCTION` wrappers from Google Sheets that are non-functional in Excel).

---

## Scoring System

### Pitcher Scoring Weights (Sheet: `Pitcher Help`)
Defined in row 2, columns C-X. Each stat category is assigned a point weight used in SUMPRODUCT scoring:

| Stat | Column | Weight |
|------|--------|--------|
| IP | E | 2.1 |
| W | F | 3.5 |
| L | G | -1.0 |
| QS | H | 2.0 |
| SV | I | 5.0 |
| HD | J | 0 (unused) |
| H (hits) | K | -0.6 |
| ER | L | -1.5 |
| HR | M | 0 (unused) |
| SO | N | 1.0 |
| BB | O | -0.5 |
| WHIP-WAR | P-X | 0 (unused in scoring) |

**Replacement Pitcher Threshold**: 237 points (documented in rows 22-32 of Pitcher Help). This is used to calculate surplus value adjustments. The adjustment formula accounts for two-start week value using a `237*10/7` multiplier.

### Batter Scoring Weights (Sheet: `Batter Help`)
Defined in row 2, columns E-R (mapped to stat columns C-P in Batter Raw):

| Stat | Weight |
|------|--------|
| H (hits) | 1.0 |
| 2B | 1.0 |
| 3B | 2.0 |
| HR | 3.1 |
| R | 1.1 |
| RBI | 1.1 |
| BB | 1.0 |
| SO | -1.0 |
| SB | 2.0 |

Note: G, PA, AB, HBP, CS columns exist in Batter Raw but have zero/null weights.

---

## Data Pipeline / Sheet Relationships

```
FanGraphs Projections ──> Pitcher Raw (5730 pitchers)
                         Batter Raw  (4519 batters)
                              │
                    ┌─────────┴──────────┐
                    v                    v
           Pitcher Projections    Batter Projections
           (INDEX/MATCH from      (INDEX/MATCH from
            Pitcher Raw)           Batter Raw)
                    │                    │
                    └────────┬───────────┘
                             v
                          Combined
                    (master ranking list,
                     ~1499 players)
                             │
                    ┌────────┼────────┐
                    v        v        v
              Streaming   Free     SP By Round
              2-starters  Agents   (draft analysis)
```

---

## Sheet-by-Sheet Specification

### 1. `Pitcher Raw` (5731 rows x 60 cols)
**Purpose**: Raw pitcher projection data imported from FanGraphs. One row per pitcher (~5141 unique names; duplicates are common names like "Jose Gonzalez").

**Columns A-X**: Standard projection stats:
- A: Name, B: Team, C: GS, D: G, E: IP, F: W, G: L, H: QS, I: SV, J: HLD, K: H, L: ER, M: HR, N: SO, O: BB, P: WHIP, Q: K/9, R: BB/9, S: ERA, T: FIP, V: WAR, W: RA9-WAR, X: PlayerId

**Calculated Columns**:
- **Y (Score)**: `=SUMPRODUCT(C2:X2,'Pitcher Help'!C$2:X$2)` - Weighted sum of all stats using Pitcher Help weights
- **Z (Adj)**: `=IF(AB2="CLOSER",-10,-MIN(Y2*3/7,237*10/7*3/7)+165)` - Position adjustment. Closers get -10; SP adjustment is based on two-start week value relative to replacement level (237 points)
- **AA (Adj Score)**: `=Y2+Z2` - Total adjusted score
- **AB (Pos)**: `=IF(I2>0,"CLOSER","SP")` - Position classification based on saves
- **AC (Points/Start)**: `=Y2/D2` - Per-appearance efficiency
- **AD (Owned)**: `=INDEX(Combined!F$2:F$799,MATCH(A2,Combined!A$2:A$799,0))` - Draft pick number from Combined sheet

### 2. `Batter Raw` (4520 rows x 35 cols)
**Purpose**: Raw batter projection data imported from FanGraphs. One row per batter (~4360 unique).

**Columns A-AE**: Standard projection stats:
- A: Name, B: Team, C: G, D: PA, E: AB, F: H, G: 2B, H: 3B, I: HR, J: R, K: RBI, L: BB, M: SO, N: HBP, O: SB, P: CS, R: AVG, S: OBP, T: SLG, U: OPS, V: wOBA, W: wRC, Y: BsR, Z: Fld, AB: Off, AC: Def, AD: WAR, AE: PlayerId

**Calculated Columns**:
- **AF (Points)**: `=SUMPRODUCT(C2:P2,'Batter Help'!E$2:R$2)` - Weighted sum using Batter Help weights
- **AG (Adjust)**: Position scarcity adjustment based on position string in column C (from the "G" column header, but this is actually the position field):
  - C (Catcher): +60
  - SS: +10
  - OF: 0
  - 2B: -10
  - 3B: -20
  - 1B/DH: -40
- **AH (Adj Point)**: `=AF2+AG2` - Total adjusted points
- **AI (Per Game)**: `=AF2/E2` - Points per AB (note: divides by AB, not G)

### 3. `Pitcher Projections` (5731 rows x 37 cols)
**Purpose**: Presentation layer over Pitcher Raw with additional calculated fields. All stat columns (C-T) use `INDEX/MATCH` to pull from Pitcher Raw.

**Key Formula Columns**:
- **W (Score)**: Pulled from `Pitcher Raw!Y` via INDEX/MATCH
- **X (Adj)**: `=IF(Z2="CLOSER",-10,-MIN(W2*3/7,237*10/7*3/7)+165)`
- **Y (Adj Score)**: `=W2+X2`
- **Z (Pos)**: `=IF(F2=G2,"SP",IF(F2=0,"RP","SP, RP"))` - More nuanced than Pitcher Raw; identifies dual-eligible pitchers
- **AA (Points/Appearance)**: `=W2/G2`
- **AB (Points/Start)**: `=IFERROR(AC2/F2,0)`
- **AC (Starting Points)**: `=W2-AD2` - Portion of points from starts
- **AD (Relief Points)**: `=W2*(G2-F2)/I2` - Portion of points from relief appearances (prorated by IP)
- **AE (Adjusted 2020 Value)**: `=MAX(-MIN(AC2*3/7,237*10/7*3/7)+215+AC2, AD2+71)` - Hybrid value metric combining start value surplus and relief floor
- **AF (Owned)**: Cross-references `Rosters with projections` sheet (appears to be a hidden/missing sheet) to mark rostered players with "x"
- **AG (Drafted)**: Pulls draft pick number from `Combined!F` via INDEX/MATCH
- **AH (Potential two-starter)**: Flags pitchers who appear in `Auto two-starters summary` (either columns E or F)
- **AI (6 IP Normalized)**: `=(2.1+P2/9-O2*0.5-E2/9*1.5)*6` - Normalized per-6-IP score (a quality start proxy)
- **AK (GP-GS)**: `=G2-F2` - Relief appearances count

### 4. `Batter Projections` (4520 rows x 40 cols)
**Purpose**: Presentation layer over Batter Raw with additional metadata.

**Key Columns**:
- **C (Owned)**: `=IF(ISNA(MATCH(A2,'Rosters with projections'!B:B,0)),"","x")` - Flags rostered batters
- **D (Drafted)**: Pulls from Combined!F via INDEX/MATCH
- **E (Matchup Rating)**: Pulls from `Batter ratings help` sheet using team name lookup
- **F (Position)**: `=IFERROR(INDEX('Batter Positions'!B:B,MATCH(A2,'Batter Positions'!A:A,0)),...)` - Multi-source position lookup
- **H-AI**: All stat columns via `INDEX/MATCH` from Batter Raw
- **AK (Points)**: Pulled from Batter Raw!AF
- **AL (Adjust)**: Position scarcity adjustment (same logic as Batter Raw but using F column for position):
  - C: +70, OF: +40, 2B: +30, 3B: +25, SS: +20, 1B: +15, other: +10
  - (Note: slightly different scale than Batter Raw's adjust)
- **AM (Adj Point)**: `=AK2+AL2`
- **AN (Per Game)**: `=AK2/H2` - Points per game

### 5. `Combined` (1499 rows x 11 cols)
**Purpose**: Master draft ranking board combining pitchers and batters into a single ranked list.

**Columns**:
- **A**: Name
- **B**: Team
- **C (Score)**: `=MAX(IFERROR(INDEX('Pitcher Projections'!W:W,MATCH(A2,'Pitcher Projections'!A:A,0)),0), IFERROR(INDEX('Batter Projections'!AK:AK,MATCH(A2,'Batter Projections'!A:A,0)),0))` - Takes the higher of pitcher or batter score
- **D (Adj Score)**: `=MAX(IFERROR(INDEX('Pitcher Projections'!AE:AE,...),0), IFERROR(INDEX('Batter Projections'!AM:AM,...),0))` - Takes higher adjusted score
- **E (Position)**: Pulls position from Pitcher Projections first, falls back to Batter Projections
- **F (Picked)**: Manual entry - actual draft pick number when player is drafted
- **G (Notes)**: Manual entry - draft notes (e.g., ADP from other sources)
- **H (espn)**: Manual entry - ESPN ADP/ranking
- **I (espn points)**: Manual entry - ESPN projected points
- **J (pitcherlist)**: Manual entry - PitcherList ranking
- **K (taken)**: Manual entry - marks players as taken during draft

### 6. `Batter Positions` (1017 rows x 8 cols)
**Purpose**: Position eligibility lookup table for batters across multiple sources/years.

- **A**: Player name
- **B-G**: Position strings from different sources/years (e.g., "1B", "SS", "OF, 2B")
- **H**: Formula checking if the player's position exists in Batter Projections top 300: `=IF(ISNUMBER(MATCH(B1,'Batter Projections'!B$2:B$301,0)),1,0)`

### 7. `Name Replacements` (61 rows x 6 cols)
**Purpose**: Maps alternate name spellings to canonical names (e.g., "Jake Faria" -> "Jacob Faria", "Pete Alonso" -> "Peter Alonso"). Used to reconcile name differences between data sources.

### 8. `Pitcher Velocity` (1031 rows x 11 cols)
**Purpose**: Compares pitcher velocity between 2024 regular season and 2025 spring training to identify velocity changes.

**Key Columns**:
- **A**: Pitcher name (separate list, appears to be a watchlist)
- **C**: player_name (from Statcast data, "Last, First" format)
- **D (2024 max)**: `=MAXIFS('V 2024'!S:S,'V 2024'!C:C,"="&$C2)` - Max velocity from 2024
- **E (2025 max)**: `=MAXIFS('V ST 2025'!S:S,'V ST 2025'!C:C,"="&$C2)` - Max velocity from 2025 ST
- **F (diff)**: `=IF(E2-D2<10,E2-D2,"")` - Velocity change (filtered to <10 to exclude bad data)
- **G (IP)**: Projected IP from Pitcher Projections (uses name format conversion from "Last, First" to "First Last")
- **H (role)**: Projected role from Pitcher Projections (SP/RP)

---

## Statcast / Pitch Data Sheets

### 9-13. Velocity Data Sheets (V 2022, V 2023, V 2024, V ST 2023, V ST 2024, V ST 2025)
**Purpose**: Raw Statcast pitch-level data from Baseball Savant. "V" = regular season, "V ST" = spring training. One row per pitcher-pitch-type combination.

**Common Columns** (71 cols in V 2024/V ST 2025, 31-33 in earlier years):
- A: pitches (count), B: player_id, C: player_name ("Last, First"), D: total_pitches, E: pitch_type (FF, SL, CH, etc.), F: pitch_percent
- G-BQ: Detailed pitch metrics including: ba, iso, babip, slg, woba, xwoba, xba, hits, abs, launch_speed, launch_angle, spin_rate, **velocity (col S)**, effective_speed, whiffs, swings, takes, extension, break metrics, barrel%, hard-hit%, arm_angle, etc.

**Data Source**: Baseball Savant Statcast Search (URLs stored in Notes sheet). Data is aggregated per pitcher per pitch type.

### 14. `Notes` (126 rows x 16 cols)
**Purpose**: Stores Baseball Savant Statcast Search URLs used to download the velocity data. Contains parameterized URLs for regular season and spring training queries by year.

---

## In-Season Management Sheets

### 15. `Free Agents` (1000 rows x 24 cols)
**Purpose**: Tracks available free agent pitchers for waiver wire pickups.

**Key Columns**:
- **J**: Raw player string (e.g., "Spencer SchwellenbachIL60\nAtlSP") - contains name, injury status, team, and position in a concatenated format
- **K**: Status ("FA", "WA (Mon)", etc.)
- **L**: Action
- **M**: Opponent for next start
- **N**: Game time/status

**Parsing Formulas** (cols A-H parse the concatenated J string):
- **A**: Last name extracted via `=MID(J3,D3+1,MIN(E3,F3,G3,H3)-D3-1)`
- **C**: Team abbreviation extracted and lowercased via nested SUBSTITUTE removing position strings
- **D**: Position of first space (name boundary)
- **E-H**: Positions of "IL", newline, "PP", "DTD" markers (for injury/status detection)

### 16. `My pitchers` (15 rows x 3 cols)
**Purpose**: User's current roster of pitchers.

- **A**: Last name extracted: `=MID(B2,FIND(" ",B2,1)+1,1000)`
- **B**: Full name (manual entry)
- **C**: Team abbreviation (manual entry)

### 17. `dailywaivers` (182 rows x 26 cols)
**Purpose**: Daily waiver wire pitcher rankings with comprehensive scouting data.

**Column Groups** (header row 1 has section labels, row 2 has column names):
- **Basic Info (A-F)**: Date, Pitcher, DW Score, Team, Throws (L/R), Opponent
- **Scores (G-J)**: Rank, Last 30 days score, Opponent score, Park factor
- **Opponent (K-L)**: wOBA against, K%
- **Rankings (M-O)**: PitcherList rank, CBS rank, FantasyPros rank
- **Ownership (P-R)**: CBS ownership %, Yahoo ownership %, FanTrax ownership %
- **Last 30 Stats (S-Z)**: SwStr%, K%, BB%, WHIP, SIERA, Stuff+, Pitches/GS, FB velocity

### 18. `dailywaivers 2-starters` (34 rows x 7 cols)
**Purpose**: Identifies pitchers from dailywaivers who have two starts in the current scoring period.

**Key Formulas**:
- **A**: `=UNIQUE(FILTER(dailywaivers!B:B,COUNTIF(dailywaivers!B:B,dailywaivers!B:B)>1))` (Google Sheets function) - Finds pitchers appearing multiple times
- **B**: Pitcher name
- **C-D**: Individual start scores (from dailywaivers via TRANSPOSE/FILTER)
- **E (Average)**: `=AVERAGE(C2:D2)` - Average score across starts
- **F (Last)**: Last name extracted for matching
- **G (Owned)**: `=ISNA(MATCH(F2,'Free Agents'!A:A,0))` - TRUE if not a free agent (i.e., rostered)

---

## Two-Starter Streaming System

A multi-sheet system for identifying and tracking starting pitchers with two starts in a given week (high-value streaming targets).

### 19. `Auto two-starters` (2931 rows x 10 cols)
**Purpose**: Scraped ESPN team schedules for all 30 MLB teams. Originally used Google Sheets `IMPORTHTML` to pull schedule tables.

**Structure**: 30 blocks of ~97 rows each (one per team). Each block:
- Row 1: URL pattern (`http://www.espn.com/mlb/team/schedule/_/name/` + team code)
- Columns: DATE, OPPONENT, RESULT, W-L, WIN, LOSS, SAVE, ATT

### 20. `Auto two-starters summary` (61 rows x 15 cols)
**Purpose**: Processes the schedule data to identify which pitcher has 2 starts within the current week window.

**Key Columns**:
- **A**: Row number (1-30, one per team)
- **B**: Reference date
- **C**: "2 starter to sun" - pitcher with 2 starts through Sunday
- **D**: "2 starter to sat" - pitcher with 2 starts through Saturday
- **E-F**: Formatted versions with asterisk prefix
- **G-H**: Cleaned versions (blank if "NA")
- **J**: Additional pitcher lookup data
- **M-N**: Day-of-week mapping (1=Sunday through 7=Saturday)

### 21. `Two-starters grid` (336 rows x 53 cols)
**Purpose**: Visual calendar grid showing which pitchers are starting on which dates, for all 30 teams.

**Structure**:
- **Row 1**: Week numbers calculated from dates: `=WEEKNUM(C2)-IF(WEEKDAY(C2)=1,1,0)`
- **Row 2**: Dates (daily from ~July 28, 2025 onward across ~50 columns)
- **Rows 3-32**: One row per team (ari, atl, bal, ... wsh). Formula: `=IF(C36="",C206,C36)` - prefers one data source over another
- **Row 34**: Formula checking if a starter is on "My players" roster
- **Rows 36-65**: First data source block (probable pitchers by team/date) - uses `IMPORTHTML` + `FILTER` + `JOIN` from Google Sheets
- **Rows 206-235**: Second data source block (fallback pitcher data)

### 22. `Streaming 2-starters` (96 rows x 35 cols)
**Purpose**: Week-by-week tracking of which streamable pitchers have two starts.

**Columns**:
- **A**: SP name
- **B (Rostered)**: `=INDEX('Pitcher Projections'!$AF:$AF,MATCH($A2,'Pitcher Projections'!$A:$A,0))` - Whether pitcher is rostered
- **C-X**: Week-by-week columns (Week 2 through Week 20), manually marked "x" when pitcher has 2 starts
- **Y (Current week)**: `=IF(ISNA(MATCH($A2,'Projected Two-starters'!A$2:A$52,0)),"","x")` - Current week flag
- **Z (Team)**: From Pitcher Projections
- **AA-AG**: Pitcher stats pulled from Pitcher Projections (GS, GP-GS, IP, WHIP, K/9, FIP, Points)
- **AH (Points/Start)**: `=(AG2-2*AB2)/AA2` - Adjusted points per start (subtracts 2x relief appearances value)

### 23. `Projected Two-starters` (52 rows x 17 cols)
**Purpose**: Current week's projected two-start pitchers with detailed stats.

**Columns**:
- **A**: Pitcher name (extracted from ESPN data using string parsing)
- **B (Rostered)**: Roster status
- **C**: Raw imported data from ESPN (via `IMPORTHTML`)
- **I-Q**: Stats pulled from Pitcher Projections: Team, GS, GP-GS, IP, WHIP, K/9, FIP, Points, Points/Start

### 24. `Batter ratings help` (60 rows x 9 cols)
**Purpose**: Weekly matchup ratings for all 30 MLB teams, originally imported from ESPN.

**Columns**:
- **A**: Team name (e.g., "Diamondbacks")
- **C**: Schedule summary (games home/away, vs LHP/RHP counts)
- **D**: Date schedule
- **E**: Opponents
- **F (OVERALL)**: Daily overall matchup ratings (1-10 scale)
- **G (LHB)**: Ratings vs left-handed batters
- **H (RHB)**: Ratings vs right-handed batters
- **I (SB)**: Stolen base opportunity ratings

Data was imported via Google Sheets `IMPORTHTML` from ESPN fantasy baseball.

---

## Draft Analysis

### 25. `SP By Round` (27 rows x 18 cols)
**Purpose**: Analyzes starting pitcher draft capital allocation by round across multiple years and ranking systems.

**Structure**:
- **Column A**: Round number (1-26)
- **Columns B-F**: SP count per round for: 2024 actual, 2023 actual, 2022 actual, 2025 ESPN ADP, 2025 Combined rankings
- **Columns N-R**: Cumulative SP count (running sum): `=B2` for row 1, then `=N_prev + B_current` pattern

This tracks how many starting pitchers are drafted in each round, helping determine optimal draft strategy for SP allocation.

---

## Key Formulas and Business Logic

### Pitcher Score Adjustment Logic
The adjustment formula converts raw pitcher scores to account for replacement level and two-start week value:

1. **Replacement level**: 237 points (an average waiver-wire SP)
2. **Two-start week multiplier**: `237 * 10/7` (~338.6 points) - the extra value a pitcher provides in a two-start week
3. **SP Adjustment**: `=-MIN(Score*3/7, 237*10/7*3/7) + 165`
   - This caps the two-start bonus and adds a floor value
4. **Closer Adjustment**: Flat -10 (closers are slightly penalized in this system)
5. **Adjusted 2020 Value** (AE column): `=MAX(-MIN(StartingPts*3/7, 237*10/7*3/7)+215+StartingPts, ReliefPts+71)`
   - Dual-path valuation: takes the higher of starting pitcher value or reliever value with a +71 floor

### Batter Position Scarcity Adjustment
Two different scales exist in the workbook:

**Batter Raw (AG)** - simpler, fewer tiers:
| Position | Adjustment |
|----------|-----------|
| C | +60 |
| SS | +10 |
| OF | 0 |
| 2B | -10 |
| 3B | -20 |
| Other | -40 |

**Batter Projections (AL)** - more granular:
| Position | Adjustment |
|----------|-----------|
| C | +70 |
| OF | +40 |
| 2B | +30 |
| 3B | +25 |
| SS | +20 |
| 1B | +15 |
| Other | +10 |

### Combined Sheet Ranking Logic
Players are ranked by `Adj Score` (column D), which takes the MAX of:
- Pitcher's Adjusted 2020 Value (from Pitcher Projections!AE)
- Batter's Adjusted Points (from Batter Projections!AM)

This allows a unified ranking of all players regardless of position.

---

## External Data Sources

1. **FanGraphs**: Pitcher and batter projections (Pitcher Raw, Batter Raw) - likely Steamer or ZiPS projection system given the ~5000+ player depth
2. **Baseball Savant / Statcast**: Pitch-level data including velocity, movement, expected stats (V 2022-2024, V ST 2023-2025)
3. **ESPN**:
   - Team schedules (Auto two-starters)
   - Fantasy matchup ratings (Batter ratings help)
   - Projected two-starters (Projected Two-starters)
   - ADP data (Combined sheet)
4. **Manual/Third-party**: PitcherList rankings, CBS rankings, Yahoo/FanTrax ownership data (Combined, dailywaivers)

---

## Missing/Referenced Sheets

- **`Rosters with projections`**: Referenced by formulas in Pitcher Projections (AF) and Batter Projections (C) but NOT present in the workbook. This likely tracks which players are rostered in the user's league.
- **`My players`**: Referenced in Two-starters grid (row 34) but not present. Likely similar to `My pitchers` but broader.

---

## Google Sheets Artifacts

Several sheets contain formulas that only work in Google Sheets:
- `IMPORTHTML()` - used in Auto two-starters, Batter ratings help, Projected Two-starters
- `__xludf.DUMMYFUNCTION()` - Google Sheets wrapper for imported data caching
- `UNIQUE()`, `FILTER()`, `JOIN()`, `TRANSPOSE()` with arrays - used in Two-starters grid, dailywaivers 2-starters

These would need to be replaced with equivalent functionality (e.g., web scraping scripts, Power Query, or manual data paste) in a pure Excel implementation.

---

## Data Volumes

| Sheet | Rows | Cols | Notes |
|-------|------|------|-------|
| Pitcher Raw | 5,731 | 60 | ~5,141 unique pitchers |
| Batter Raw | 4,520 | 35 | ~4,360 unique batters |
| Pitcher Projections | 5,731 | 37 | Mirrors Pitcher Raw with INDEX/MATCH |
| Batter Projections | 4,520 | 40 | Mirrors Batter Raw with INDEX/MATCH |
| Combined | 1,499 | 11 | Top ~1,500 players ranked |
| V 2024 | 3,768 | 71 | Statcast pitch-type data |
| V ST 2025 | 3,971 | 71 | Spring training Statcast |
| Batter Positions | 1,017 | 8 | Position eligibility |
| Auto two-starters | 2,931 | 10 | 30 teams x ~97 games |
| Free Agents | 1,000 | 24 | Available pitchers |
| dailywaivers | 182 | 26 | Daily streaming candidates |
