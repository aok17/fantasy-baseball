const BASE = '/api';

async function json(url, opts) {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  getRankings: () => json('/rankings'),
  getDraftSessions: () => json('/draft/sessions'),
  createDraftSession: (name) => json('/draft/sessions', { method: 'POST', body: JSON.stringify({ name }) }),
  getDraftPicks: (sessionId) => json(`/draft/sessions/${sessionId}/picks`),
  createDraftPick: (sessionId, pick) => json(`/draft/sessions/${sessionId}/picks`, { method: 'POST', body: JSON.stringify(pick) }),
  updatePickNotes: (pickId, notes) => json(`/draft/picks/${pickId}`, { method: 'PUT', body: JSON.stringify({ player_notes: notes }) }),
  deletePick: (pickId) => json(`/draft/picks/${pickId}`, { method: 'DELETE' }),
  getWeights: () => json('/config/weights'),
  updateWeights: (weights) => json('/config/weights', { method: 'PUT', body: JSON.stringify({ weights }) }),
  getPositionAdj: () => json('/config/positions'),
  updatePositionAdj: (adj) => json('/config/positions', { method: 'PUT', body: JSON.stringify({ adjustments: adj }) }),
  getAppConfig: () => json('/config/app'),
  updateAppConfig: (key, value) => json('/config/app', { method: 'PUT', body: JSON.stringify({ key, value }) }),
  getNameReplacements: () => json('/config/name-replacements'),
  addNameReplacement: (alt, canonical) => json('/config/name-replacements', { method: 'POST', body: JSON.stringify({ alt_name: alt, canonical_name: canonical }) }),
  deleteNameReplacement: (id) => json(`/config/name-replacements/${id}`, { method: 'DELETE' }),
  scrape: (source) => json(`/scrape/${source}`, { method: 'POST' }),
};
