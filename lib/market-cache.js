// Gold Hunter — shared provider cache
// One cache/in-flight layer is shared by live signals, charts and backtests.
// Historical pages use long TTLs because old candles do not need frequent refreshes.
const fetch = require('node-fetch');

const cache = new Map();
const inflight = new Map();

function get(key) { return cache.get(key) || null; }
function set(key, value) {
  cache.set(key, { value, savedAt: Date.now() });
  return value;
}

function sanitizeUrl(url) {
  return String(url || '').replace(/([?&]apikey=)[^&]+/ig, '$1***');
}

async function fetchJson(key, url, ttlMs, timeoutMs = 12000) {
  const now = Date.now();
  const hit = get(key);
  if (hit && now - hit.savedAt < ttlMs) {
    return { data: hit.value, cached: true, stale: false, status: 200 };
  }

  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const r = await fetch(url, { timeout: timeoutMs });
      let body = null;
      try { body = await r.json(); } catch (_) {}

      if (!r.ok) {
        // Preserve the last good value for callers, but expose the provider error.
        if (hit) {
          return {
            data: hit.value,
            cached: true,
            stale: true,
            status: r.status,
            providerError: body?.message || body?.code || null,
            request: sanitizeUrl(url)
          };
        }
        return {
          data: null,
          cached: false,
          stale: false,
          status: r.status,
          providerError: body?.message || body?.code || null,
          request: sanitizeUrl(url)
        };
      }

      if (body && body.status === 'error') {
        if (hit) {
          return {
            data: hit.value,
            cached: true,
            stale: true,
            status: r.status || 200,
            providerError: body.message || body.code || null,
            request: sanitizeUrl(url)
          };
        }
        return {
          data: body,
          cached: false,
          stale: false,
          status: r.status || 200,
          providerError: body.message || body.code || null,
          request: sanitizeUrl(url)
        };
      }

      set(key, body);
      return { data: body, cached: false, stale: false, status: r.status || 200 };
    } catch (e) {
      if (hit) {
        return {
          data: hit.value,
          cached: true,
          stale: true,
          status: 0,
          error: e.message,
          request: sanitizeUrl(url)
        };
      }
      return { data: null, cached: false, stale: false, status: 0, error: e.message, request: sanitizeUrl(url) };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

module.exports = { fetchJson, get, set };
