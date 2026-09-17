// Gold Hunter — shared provider cache
// Prevents duplicate TwelveData requests from charts, signal and alerts.
const fetch = require('node-fetch');

const cache = new Map();
const inflight = new Map();

function get(key) { return cache.get(key) || null; }
function set(key, value) { cache.set(key, { value, savedAt: Date.now() }); return value; }

async function fetchJson(key, url, ttlMs, timeoutMs = 8000) {
  const now = Date.now();
  const hit = get(key);
  if (hit && now - hit.savedAt < ttlMs) return { data: hit.value, cached: true, stale: false, status: 200 };

  // If several callers arrive together, share one provider request.
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const r = await fetch(url, { timeout: timeoutMs });
      if (!r.ok) {
        // On rate-limit/provider failure, keep serving the last known good data.
        if (hit) return { data: hit.value, cached: true, stale: true, status: r.status };
        return { data: null, cached: false, stale: false, status: r.status };
      }
      const data = await r.json();
      if (data && data.status === 'error') {
        if (hit) return { data: hit.value, cached: true, stale: true, status: 200, providerError: data.message || data.code };
        return { data, cached: false, stale: false, status: 200, providerError: data.message || data.code };
      }
      set(key, data);
      return { data, cached: false, stale: false, status: 200 };
    } catch (e) {
      if (hit) return { data: hit.value, cached: true, stale: true, status: 0, error: e.message };
      return { data: null, cached: false, stale: false, status: 0, error: e.message };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

module.exports = { fetchJson, get, set };
