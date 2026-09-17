// Gold Hunter — shared provider cache
// Prevents duplicate TwelveData requests from charts, signal and alerts.
const fetch = require('node-fetch');

const cache = new Map();
const inflight = new Map();

function get(key) { return cache.get(key) || null; }
function set(key, value) { cache.set(key, { value, savedAt: Date.now() }); return value; }

function safeProviderMessage(data) {
  if (!data || typeof data !== 'object') return null;
  return data.message || data.error || data.code || null;
}

async function fetchJson(key, url, ttlMs, timeoutMs = 8000) {
  const now = Date.now();
  const hit = get(key);
  if (hit && now - hit.savedAt < ttlMs) {
    return { data: hit.value, cached: true, stale: false, status: 200, httpStatus: 200 };
  }

  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const r = await fetch(url, { timeout: timeoutMs });
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

      const providerError = safeProviderMessage(data);

      if (!r.ok) {
        // Keep serving last known-good data, but NEVER hide the actual provider error.
        if (hit) {
          return {
            data: hit.value,
            cached: true,
            stale: true,
            status: r.status,
            httpStatus: r.status,
            providerError,
            responseBody: data || (text ? text.slice(0, 500) : null)
          };
        }
        return {
          data: null,
          cached: false,
          stale: false,
          status: r.status,
          httpStatus: r.status,
          providerError,
          responseBody: data || (text ? text.slice(0, 500) : null)
        };
      }

      if (data && data.status === 'error') {
        if (hit) {
          return {
            data: hit.value,
            cached: true,
            stale: true,
            status: 200,
            httpStatus: 200,
            providerError
          };
        }
        return {
          data,
          cached: false,
          stale: false,
          status: 200,
          httpStatus: 200,
          providerError
        };
      }

      set(key, data);
      return { data, cached: false, stale: false, status: 200, httpStatus: 200 };
    } catch (e) {
      if (hit) {
        return {
          data: hit.value,
          cached: true,
          stale: true,
          status: 0,
          httpStatus: 0,
          error: e.message
        };
      }
      return {
        data: null,
        cached: false,
        stale: false,
        status: 0,
        httpStatus: 0,
        error: e.message
      };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

module.exports = { fetchJson, get, set };
