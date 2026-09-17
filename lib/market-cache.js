// Gold Hunter — shared provider cache
// Prevents duplicate TwelveData requests from charts, signal and alerts.
// Also preserves provider/HTTP diagnostics so history failures are never hidden.
const fetch = require('node-fetch');

const cache = new Map();
const inflight = new Map();

function get(key) { return cache.get(key) || null; }
function set(key, value) { cache.set(key, { value, savedAt: Date.now() }); return value; }

function providerMessage(data) {
  if (!data) return null;
  if (typeof data === 'string') return data.slice(0, 500);
  return data.message || data.description || data.error || data.code || null;
}

async function fetchJson(key, url, ttlMs, timeoutMs = 8000) {
  const now = Date.now();
  const hit = get(key);
  if (hit && now - hit.savedAt < ttlMs) {
    return { data: hit.value, cached: true, stale: false, status: 200, httpStatus: 200 };
  }

  // If several callers arrive together, share one provider request.
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const r = await fetch(url, { timeout: timeoutMs });

      // Read the body even for HTTP errors. TwelveData often puts the useful
      // diagnostic (code/message) in the JSON response body.
      const text = await r.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = text || null;
      }

      const pError = providerMessage(data);

      if (!r.ok) {
        // Keep serving the last known good data, but DO NOT hide the reason.
        if (hit) {
          return {
            data: hit.value,
            cached: true,
            stale: true,
            status: r.status,
            httpStatus: r.status,
            providerError: pError,
            error: `HTTP ${r.status}`
          };
        }
        return {
          data: null,
          cached: false,
          stale: false,
          status: r.status,
          httpStatus: r.status,
          providerError: pError,
          error: `HTTP ${r.status}`
        };
      }

      if (data && typeof data === 'object' && data.status === 'error') {
        if (hit) {
          return {
            data: hit.value,
            cached: true,
            stale: true,
            status: 200,
            httpStatus: 200,
            providerError: pError || 'provider-error'
          };
        }
        return {
          data,
          cached: false,
          stale: false,
          status: 200,
          httpStatus: 200,
          providerError: pError || 'provider-error'
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
