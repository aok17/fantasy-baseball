import WebSocket from 'ws';

// Parse a WebSocket message from ESPN's draft stream
//
//   SELECTED {teamId} {playerId} {slotId}  — a pick was made
//   SELECTING {teamId} {timeMs}            — team is on the clock
//   CLOCK {teamId} {timeMs} {pickIndex}    — clock tick
//   INIT ...                                — initial binary state
//   TOKEN ...                               — auth confirmation
//   PONG ...                                — keepalive
//   AUTOSUGGEST {playerId}                 — auto-draft suggestion
//
export function parseMessage(raw) {
  if (!raw) return null;
  const msg = raw.trim();
  if (!msg) return null;
  const parts = msg.split(' ');
  const type = parts[0];

  switch (type) {
    case 'SELECTED':
      return { type, teamId: Number(parts[1]), playerId: Number(parts[2]), slotId: Number(parts[3]) };
    case 'SELECTING':
      return { type, teamId: Number(parts[1]), timeMs: Number(parts[2]) };
    case 'CLOCK':
      return { type, teamId: Number(parts[1]), timeMs: Number(parts[2]), pickIndex: Number(parts[3]) };
    default:
      return { type };
  }
}

// Map a SELECTED message to a draft_picks row
export function mapPick(msg, playerMap, teamMap, pickNumber) {
  return {
    player_name: playerMap[msg.playerId] || `Unknown (#${msg.playerId})`,
    pick_number: pickNumber,
    drafted_by: teamMap[msg.teamId] || `Team ${msg.teamId}`,
  };
}

// Build ESPN player ID → name map from the espn_rank table
export function buildPlayerMap(db) {
  const rows = db.prepare('SELECT espn_id, name FROM espn_rank WHERE espn_id IS NOT NULL').all();
  const map = {};
  for (const r of rows) map[r.espn_id] = r.name;
  return map;
}

// Build team ID → owner first name map from ESPN API
export async function buildTeamMap(leagueId, myTeamId, cookies, year) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leagues/${leagueId}?view=mTeam`;
  const res = await fetch(url, { headers: { Cookie: cookies } });
  if (!res.ok) throw new Error(`ESPN team fetch failed: ${res.status}`);
  const data = await res.json();

  const members = {};
  for (const m of (data.members || [])) members[m.id] = m.firstName;

  const teamMap = {};
  for (const t of (data.teams || [])) {
    if (t.id === myTeamId) {
      teamMap[t.id] = 'me';
    } else {
      const ownerId = t.owners?.[0];
      teamMap[t.id] = members[ownerId] || t.abbrev || `Team ${t.id}`;
    }
  }
  return teamMap;
}

// Get draft security token from ESPN
async function getDraftToken(leagueId, teamId, cookies, year) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leagues/${leagueId}/teams/${teamId}/draftSecurity`;
  const res = await fetch(url, { headers: { Cookie: cookies } });
  if (!res.ok) throw new Error(`Draft security failed: ${res.status}`);
  return (await res.text()).trim();
}

// Get gameId from draftInit
async function getGameId(leagueId, cookies, year) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${year}/segments/0/leagues/${leagueId}?view=draftInit`;
  const res = await fetch(url, { headers: { Cookie: cookies } });
  if (!res.ok) throw new Error(`Draft init failed: ${res.status}`);
  const data = await res.json();
  return data.gameId;
}

/**
 * DraftSync — manages the WebSocket connection to ESPN's draft stream.
 *
 *   const sync = new DraftSync(db, sessionId);
 *   await sync.start();  // connects and begins inserting picks
 *   sync.stop();         // disconnects
 *   sync.status();       // { connected, pickCount, lastPick, onTheClock, error }
 */
export class DraftSync {
  constructor(db, sessionId, { leagueOverride } = {}) {
    this.db = db;
    this.sessionId = sessionId;
    this.leagueOverride = leagueOverride || null;
    this.ws = null;
    this.playerMap = null;
    this.teamMap = null;
    this.pickCount = 0;
    this.lastPick = null;
    this.onTheClock = null;
    this.error = null;
    this.connected = false;
    this._pingInterval = null;
    this._reconnectAttempts = 0;
    this._reconnectTimeout = null;
    this._stopped = false;
  }

  _getConfig(key) {
    return this.db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value;
  }

  _getCookies() {
    const swid = this._getConfig('espn_bot_swid') || '{A89C7768-329A-481E-B25C-AF05EEFE74B8}';
    const s2 = this._getConfig('espn_bot_s2');
    if (!s2) throw new Error('espn_bot_s2 not configured — set it in app_config');
    return `SWID=${swid}; espn_s2=${s2}`;
  }

  async start() {
    const leagueId = this.leagueOverride || this._getConfig('espn_league_id');
    const teamId = Number(this._getConfig('espn_team_id'));
    if (!leagueId || !teamId) throw new Error('espn_league_id and espn_team_id must be set in app_config');

    const cookies = this._getCookies();
    const year = this._getConfig('season_year') || '2026';
    this._stopped = false;

    // Build lookup maps
    this.playerMap = buildPlayerMap(this.db);
    console.log(`[DraftSync] Player map: ${Object.keys(this.playerMap).length} players`);

    this.teamMap = await buildTeamMap(leagueId, teamId, cookies, year);
    console.log(`[DraftSync] Team map: ${Object.keys(this.teamMap).length} teams`);

    // Get draft token and gameId
    const token = await getDraftToken(leagueId, teamId, cookies, year);
    const gameId = await getGameId(leagueId, cookies, year);
    const memberId = this._getConfig('espn_bot_swid') || '{A89C7768-329A-481E-B25C-AF05EEFE74B8}';
    const fullToken = `${gameId}:${leagueId}:${teamId}:${memberId}:${token}`;

    const nocache = Math.floor(Math.random() * 1e6);
    // ESPN's draft server requires unencoded curly braces and colons in the URL
    const wsUrl = `wss://fantasydraft.espn.com/game-${gameId}/league-${leagueId}/JOIN?1=${gameId}&2=${leagueId}&3=${teamId}&4=${memberId}&5=${fullToken}&6=false&7=false&8=KONA&nocache=${nocache}`;

    console.log(`[DraftSync] Connecting to ${wsUrl.substring(0, 80)}...`);
    this._connect(wsUrl, cookies);
  }

  _connect(wsUrl, cookies) {
    this.ws = new WebSocket(wsUrl, {
      headers: {
        Cookie: cookies,
        Origin: 'https://fantasy.espn.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    this._wsUrl = wsUrl;
    this._wsCookies = cookies;

    this.ws.on('open', () => {
      console.log('[DraftSync] Connected');
      this.connected = true;
      this.error = null;
      this._reconnectAttempts = 0;
      this._pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(`PING ${Date.now()}`);
        }
      }, 30000);
      this._scheduleSmack();
    });

    this.ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString();
      if (raw.startsWith('INIT ') || raw.startsWith('TOKEN ')) return;

      const msg = parseMessage(raw);
      if (!msg || !['SELECTED', 'SELECTING', 'CLOCK'].includes(msg.type)) return;

      if (msg.type === 'SELECTED') {
        this._handlePick(msg);
      } else if (msg.type === 'SELECTING') {
        this.onTheClock = { teamId: msg.teamId, team: this.teamMap[msg.teamId] || `Team ${msg.teamId}` };
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[DraftSync] Disconnected: ${code} ${reason}`);
      this.connected = false;
      this.error = `Disconnected (${code})`;
      clearInterval(this._pingInterval);
      this._tryReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[DraftSync] Error:', err.message);
      this.error = err.message;
      this.connected = false;
      // 403 = draft not started yet, don't reconnect
      if (err.message?.includes('403')) {
        this._stopped = true;
        this.error = 'Draft not started yet (403) — click Start Sync when the draft begins';
      }
    });
  }

  _tryReconnect() {
    if (this._stopped || this._reconnectAttempts >= 10) {
      console.log('[DraftSync] Giving up reconnection');
      this.error = 'Disconnected — reconnection failed';
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;
    console.log(`[DraftSync] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
    this._reconnectTimeout = setTimeout(() => {
      if (!this._stopped) this._connect(this._wsUrl, this._wsCookies);
    }, delay);
  }

  _handlePick(msg) {
    // Get pick number from DB to handle manual + sync coexistence
    const maxPick = this.db.prepare(
      'SELECT MAX(pick_number) as max FROM draft_picks WHERE session_id = ?'
    ).get(this.sessionId);
    const pickNumber = (maxPick?.max || 0) + 1;

    const pick = mapPick(msg, this.playerMap, this.teamMap, pickNumber);
    this.lastPick = pick;
    this.onTheClock = null;

    // Insert idempotently — skip if this player was already drafted in this session
    const existing = this.db.prepare(
      'SELECT id FROM draft_picks WHERE session_id = ? AND player_name = ?'
    ).get(this.sessionId, pick.player_name);

    if (!existing) {
      this.db.prepare(
        'INSERT INTO draft_picks (session_id, player_name, pick_number, drafted_by) VALUES (?, ?, ?, ?)'
      ).run(this.sessionId, pick.player_name, pick.pick_number, pick.drafted_by);
      this.pickCount++;
      console.log(`[DraftSync] Pick #${pick.pick_number}: ${pick.player_name} by ${pick.drafted_by}`);
    }
  }

  _scheduleSmack() {
    clearTimeout(this._smackTimeout);
    // Poisson process with λ = 1/5min: inter-arrival times are exponential
    // -ln(U) / λ where U ~ Uniform(0,1), λ = 1/(5*60*1000)
    const lambda = 1 / (5 * 60 * 1000);
    const delay = Math.min(-Math.log(1 - Math.random()) / lambda, 15 * 60 * 1000);
    this._smackTimeout = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('CHAT smack');
        console.log('[DraftSync] smack');
      }
      if (!this._stopped) this._scheduleSmack();
    }, delay);
  }

  stop() {
    this._stopped = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    clearInterval(this._pingInterval);
    clearTimeout(this._reconnectTimeout);
    clearTimeout(this._smackTimeout);
    this.connected = false;
    console.log('[DraftSync] Stopped');
  }

  status() {
    return {
      connected: this.connected,
      pickCount: this.pickCount,
      lastPick: this.lastPick,
      onTheClock: this.onTheClock,
      error: this.error,
    };
  }
}
