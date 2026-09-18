// Gold Hunter — Decision Engine Core
// Independent Strategy Architecture
// نسخه کالیبره اولیه Trend Following
//
// هدف:
// 1) Live و Backtest از یک منطق استفاده کنند.
// 2) استراتژی‌ها مستقل باشند و اجماع وزنی شرط ورود نباشد.
// 3) Trend Following در فاز اول بیش از حد سخت‌گیر نباشد.
// 4) بعد از بک‌تست، پارامترها مرحله‌به‌مرحله کالیبره شوند.

const fetch = require('node-fetch');
const { fetchJson } = require('./market-cache');

const SYMBOL = process.env.XAU_SYMBOL || 'XAU/USD';
const TF = {
  '15M': '15min',
  '1H': '1h',
  '4H': '4h',
  'Daily': '1day'
};

const MIN_CONFIDENCE = Number(process.env.MIN_SIGNAL_CONFIDENCE || 72);
const MIN_RR = Number(process.env.MIN_SIGNAL_RR || 1.8);

const MAX_SPREAD_PROXY_ATR =
  Number(process.env.MAX_ENTRY_ATR_DISTANCE || 0.55);

const MIN_STOP_USD =
  Number(process.env.MIN_STOP_DISTANCE_USD || 3.0);

// ============================================================
// TREND FOLLOWING — INITIAL CALIBRATION PARAMETERS
// ============================================================

// تعداد کندل‌هایی که برای پیدا کردن Pullback بررسی می‌شوند.
// قبلاً 8 بود؛ کمی آزادتر شده.
const TREND_PULLBACK_LOOKBACK =
  Math.max(6, Number(process.env.TREND_PULLBACK_LOOKBACK || 12));

// فاصله مجاز Pullback از EMA20 بر اساس ATR.
const TREND_PULLBACK_ATR =
  Number(process.env.TREND_PULLBACK_ATR || 0.55);

// فاصله مجاز قیمت از EMA20 برای جلوگیری از Chasing.
// قبلاً 1.15 ATR بود.
const TREND_MAX_CHASE_ATR =
  Number(process.env.TREND_MAX_CHASE_ATR || 1.45);

// RSI سالم برای BUY
const TREND_BUY_RSI_MIN =
  Number(process.env.TREND_BUY_RSI_MIN || 46);

const TREND_BUY_RSI_MAX =
  Number(process.env.TREND_BUY_RSI_MAX || 78);

// RSI سالم برای SELL
const TREND_SELL_RSI_MIN =
  Number(process.env.TREND_SELL_RSI_MIN || 22);

const TREND_SELL_RSI_MAX =
  Number(process.env.TREND_SELL_RSI_MAX || 54);

// حداقل امتیاز داخلی Trend برای فعال شدن.
// این امتیاز با MIN_CONFIDENCE جداست.
// هدف این است که Trend بیش از حد سخت‌گیر نباشد.
const TREND_MIN_SETUP_SCORE =
  Number(process.env.TREND_MIN_SETUP_SCORE || 60);

// اگر فقط یکی از Daily/4H همسو باشد، 1H می‌تواند روند را تأیید کند.
const TREND_ALLOW_SINGLE_HTF_WITH_H1 =
  String(process.env.TREND_ALLOW_SINGLE_HTF_WITH_H1 || 'true') !== 'false';

// اگر Daily و 4H هر دو همسو باشند، امتیاز کامل داده می‌شود.
const TREND_REQUIRE_HTF_ALIGNMENT =
  String(process.env.TREND_REQUIRE_HTF_ALIGNMENT || 'false') === 'true';

// حداقل ATR برای معامله.
// صفر یعنی غیرفعال.
const TREND_MIN_ATR_USD =
  Number(process.env.TREND_MIN_ATR_USD || 0);

// ============================================================

const historyDiagnostics = new Map();

const clamp = (x, a = 0, b = 100) =>
  Math.max(a, Math.min(b, x));

const fmt = (x) =>
  Number(Number(x).toFixed(2));

function ema(a, n) {
  if (!Array.isArray(a) || a.length < n) return null;

  const k = 2 / (n + 1);
  let e = a[0];

  for (let i = 1; i < a.length; i++) {
    e = a[i] * k + e * (1 - k);
  }

  return e;
}

function rsi(a, n = 14) {
  if (!Array.isArray(a) || a.length < n + 1) return 50;

  let g = 0;
  let l = 0;

  for (let i = a.length - n; i < a.length; i++) {
    const d = a[i] - a[i - 1];

    if (d > 0) g += d;
    else l -= d;
  }

  if (l === 0) return 100;

  return 100 - 100 / (1 + g / l);
}

function atr(b, n = 14) {
  if (!Array.isArray(b) || b.length < n + 1) return null;

  let s = 0;

  for (let i = b.length - n; i < b.length; i++) {
    s += Math.max(
      b[i].high - b[i].low,
      Math.abs(b[i].high - b[i - 1].close),
      Math.abs(b[i].low - b[i - 1].close)
    );
  }

  return s / n;
}

function range(b, n = 50) {
  const x = b.slice(-n);

  if (!x.length) {
    return {
      low: null,
      high: null,
      mid: null
    };
  }

  const low = Math.min(...x.map(v => v.low));
  const high = Math.max(...x.map(v => v.high));

  return {
    low,
    high,
    mid: (low + high) / 2
  };
}

function pivots(b, n = 30) {
  const x = b.slice(-n);
  const highs = [];
  const lows = [];

  for (let i = 2; i < x.length - 2; i++) {
    if (
      x[i].high > x[i - 1].high &&
      x[i].high > x[i - 2].high &&
      x[i].high > x[i + 1].high &&
      x[i].high > x[i + 2].high
    ) {
      highs.push(x[i].high);
    }

    if (
      x[i].low < x[i - 1].low &&
      x[i].low < x[i - 2].low &&
      x[i].low < x[i + 1].low &&
      x[i].low < x[i + 2].low
    ) {
      lows.push(x[i].low);
    }
  }

  return {
    highs: highs.slice(-6),
    lows: lows.slice(-6)
  };
}

function structure(b) {
  const x = b.slice(-12);
  const p = b.slice(-24, -12);

  if (x.length < 8 || p.length < 8) {
    return 'MIXED';
  }

  const h = Math.max(...x.map(v => v.high));
  const l = Math.min(...x.map(v => v.low));

  const ph = Math.max(...p.map(v => v.high));
  const pl = Math.min(...p.map(v => v.low));

  if (h > ph && l > pl) {
    return 'BULLISH_BOS';
  }

  if (h < ph && l < pl) {
    return 'BEARISH_BOS';
  }

  return 'MIXED';
}

function sweepSignal(b) {
  if (!Array.isArray(b) || b.length < 8) {
    return 'NONE';
  }

  const a = b.slice(-8, -1);
  const c = b[b.length - 1];

  const hi = Math.max(...a.map(v => v.high));
  const lo = Math.min(...a.map(v => v.low));

  if (c.high > hi && c.close < hi) {
    return 'SWEEP_HIGH';
  }

  if (c.low < lo && c.close > lo) {
    return 'SWEEP_LOW';
  }

  return 'NONE';
}

function momentum(b) {
  const c = b.map(x => x.close);

  const e20 = ema(c.slice(-60), 20);
  const e50 = ema(c.slice(-100), 50);
  const rr = rsi(c);

  return {
    ema20: e20,
    ema50: e50,
    rsi: rr,
    bull:
      e20 != null &&
      e50 != null &&
      e20 > e50 &&
      rr > 50,
    bear:
      e20 != null &&
      e50 != null &&
      e20 < e50 &&
      rr < 50
  };
}

function volumeState(b) {
  const v = b
    .slice(-21)
    .map(x => x.volume)
    .filter(x => x > 0);

  if (v.length < 10) {
    return {
      available: false,
      ratio: null,
      confirmed: false
    };
  }

  const av =
    v.slice(0, -1).reduce((a, x) => a + x, 0) /
    (v.length - 1);

  return {
    available: true,
    ratio: av > 0 ? b[b.length - 1].volume / av : null,
    confirmed:
      av > 0 &&
      b[b.length - 1].volume > av * 1.15
  };
}

function fibZone(d) {
  const piv = d.m15.pivots;

  if (!piv.highs.length || !piv.lows.length) {
    return {
      vote: 'NEUTRAL',
      score: 0,
      reason: 'داده کافی برای تشخیص سوئینگ فیبوناچی نیست'
    };
  }

  const swingHigh =
    Math.max(...piv.highs.slice(-3));

  const swingLow =
    Math.min(...piv.lows.slice(-3));

  const span = swingHigh - swingLow;

  if (!(span > 0)) {
    return {
      vote: 'NEUTRAL',
      score: 0,
      reason: 'محدوده سوئینگ نامعتبر است'
    };
  }

  const price = d.m15.price;

  const pos =
    (price - swingLow) / span;

  const bullishTrend =
    price > d.m15.ema20 &&
    d.m15.rsi > 50;

  const bearishTrend =
    price < d.m15.ema20 &&
    d.m15.rsi < 50;

  const inZone =
    pos >= 0.382 &&
    pos <= 0.618;

  if (inZone && bullishTrend) {
    return {
      vote: 'BUY',
      score: 1,
      reason:
        'قیمت در ناحیه اصلاحی 38.2–61.8% با مومنتوم صعودی'
    };
  }

  if (inZone && bearishTrend) {
    return {
      vote: 'SELL',
      score: -1,
      reason:
        'قیمت در ناحیه اصلاحی 38.2–61.8% با مومنتوم نزولی'
    };
  }

  return {
    vote: 'NEUTRAL',
    score: 0,
    reason:
      'فیبوناچی تأیید جهت مستقلی نمی‌دهد'
  };
}

function divergence(bars) {
  if (!bars || bars.length < 30) {
    return {
      vote: 'NEUTRAL',
      reason: 'داده کافی برای واگرایی نیست'
    };
  }

  const closes = bars.map(b => b.close);
  const series = [];

  for (
    let i = Math.max(14, closes.length - 40);
    i < closes.length;
    i++
  ) {
    series.push({
      price: closes[i],
      rsi: rsi(closes.slice(0, i + 1), 14)
    });
  }

  if (series.length < 16) {
    return {
      vote: 'NEUTRAL',
      reason: 'داده کافی برای واگرایی نیست'
    };
  }

  const half = Math.floor(series.length / 2);

  const first = series.slice(0, half);
  const second = series.slice(half);

  const firstMax = first.reduce(
    (a, b) => b.price > a.price ? b : a
  );

  const secondMax = second.reduce(
    (a, b) => b.price > a.price ? b : a
  );

  const firstMin = first.reduce(
    (a, b) => b.price < a.price ? b : a
  );

  const secondMin = second.reduce(
    (a, b) => b.price < a.price ? b : a
  );

  if (
    secondMax.price > firstMax.price &&
    secondMax.rsi < firstMax.rsi
  ) {
    return {
      vote: 'SELL',
      reason:
        'واگرایی نزولی: سقف قیمتی جدیدتر بالاتر، ولی RSI پایین‌تر'
    };
  }

  if (
    secondMin.price < firstMin.price &&
    secondMin.rsi > firstMin.rsi
  ) {
    return {
      vote: 'BUY',
      reason:
        'واگرایی صعودی: کف قیمتی جدیدتر پایین‌تر، ولی RSI بالاتر'
    };
  }

  return {
    vote: 'NEUTRAL',
    reason:
      'واگرایی مشخصی بین قیمت و RSI دیده نمی‌شود'
  };
}

function analyze(b) {
  const last = b[b.length - 1];

  const m = momentum(b);
  const a = atr(b);
  const sr = range(b);
  const pv = pivots(b);
  const vol = volumeState(b);

  return {
    price: last.close,
    ema20: m.ema20,
    ema50: m.ema50,
    rsi: m.rsi,
    atr: a,
    structure: structure(b),
    sweep: sweepSignal(b),
    range: sr,
    pivots: pv,
    volume: last.volume,
    volumeState: vol,
    bars: b
  };
}

function normalizeBars(values) {
  return (values || [])
    .map(v => ({
      time: new Date(v.datetime).getTime(),
      open: +v.open,
      high: +v.high,
      low: +v.low,
      close: +v.close,
      volume: v.volume ? +v.volume : 0
    }))
    .filter(v =>
      Number.isFinite(v.time) &&
      Number.isFinite(v.open) &&
      Number.isFinite(v.high) &&
      Number.isFinite(v.low) &&
      Number.isFinite(v.close)
    );
}

async function fetchTF(tf, limit = 220) {
  const key = process.env.TWELVEDATA_API_KEY;

  if (!key) return null;

  const safeLimit = Math.max(
    1,
    Math.min(Number(limit) || 220, 5000)
  );

  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(SYMBOL)}` +
    `&interval=${TF[tf]}` +
    `&outputsize=${safeLimit}` +
    `&apikey=${key}`;

  const ttlByTf = {
    '15M': 90000,
    '1H': 300000,
    '4H': 600000,
    'Daily': 1800000
  };

  const result = await fetchJson(
    `engine-ohlc:${SYMBOL}:${tf}:${safeLimit}`,
    url,
    ttlByTf[tf] || 300000
  );

  const d = result.data;

  if (
    !d ||
    d.status === 'error' ||
    !Array.isArray(d.values) ||
    !d.values.length
  ) {
    return null;
  }

  return normalizeBars(d.values).reverse();
}

function formatProviderDate(ms) {
  const d = new Date(ms);

  const pad = n =>
    String(n).padStart(2, '0');

  return (
    `${d.getUTCFullYear()}-` +
    `${pad(d.getUTCMonth() + 1)}-` +
    `${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:` +
    `${pad(d.getUTCMinutes())}:` +
    `${pad(d.getUTCSeconds())}`
  );
}

// ============================================================
// HISTORICAL DATA
// ============================================================

let lastHistoryProviderRequestAt = 0;
let historyThrottlePromise = Promise.resolve();

const HISTORY_MIN_GAP_MS =
  Math.max(
    1000,
    Number(
      process.env.HISTORY_MIN_GAP_MS || 10000
    )
  );

function waitHistoryThrottle() {
  historyThrottlePromise =
    historyThrottlePromise.then(async () => {
      const wait = Math.max(
        0,
        HISTORY_MIN_GAP_MS -
        (Date.now() - lastHistoryProviderRequestAt)
      );

      if (wait > 0) {
        await new Promise(r =>
          setTimeout(r, wait)
        );
      }

      lastHistoryProviderRequestAt =
        Date.now();
    });

  return historyThrottlePromise;
}

async function fetchTFHistory(tf, totalBars) {
  const key = process.env.TWELVEDATA_API_KEY;

  if (!key || !TF[tf]) return null;

  const wanted = Math.max(
    220,
    Math.min(
      Number(totalBars) || 220,
      100000
    )
  );

  const intervalMs = {
    '15M': 15 * 60 * 1000,
    '1H': 60 * 60 * 1000,
    '4H': 4 * 60 * 60 * 1000,
    'Daily': 24 * 60 * 60 * 1000
  }[tf] || 15 * 60 * 1000;

  const configuredChunk =
    Number(
      process.env.HISTORY_PAGE_SIZE || 5000
    );

  const chunk = Math.max(
    220,
    Math.min(5000, configuredChunk)
  );

  const ttl =
    Math.max(
      6 * 60 * 60 * 1000,
      Number(
        process.env.HISTORY_CACHE_TTL_MS ||
        24 * 60 * 60 * 1000
      )
    );

  const all = new Map();
  const pages = [];
  const seenBoundaries = new Set();

  let endMs = null;
  let stoppedReason = 'target-reached';

  for (
    let page = 0;
    page < 80 && all.size < wanted;
    page++
  ) {
    const pageSize =
      Math.min(
        chunk,
        wanted - all.size
      );

    let url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=${encodeURIComponent(SYMBOL)}` +
      `&interval=${TF[tf]}` +
      `&outputsize=${pageSize}` +
      `&timezone=UTC` +
      `&apikey=${key}`;

    if (endMs !== null) {
      url +=
        `&end_date=${encodeURIComponent(
          formatProviderDate(endMs)
        )}`;
    }

    const boundary =
      endMs === null
        ? 'latest'
        : formatProviderDate(endMs);

    const cacheKey =
      `engine-history-v6:${SYMBOL}:${tf}:${pageSize}:${boundary}`;

    let result =
      await fetchJson(
        cacheKey,
        url,
        ttl
      );

    let data = result.data;

    if (!result.cached && !data) {
      await waitHistoryThrottle();

      result =
        await fetchJson(
          cacheKey,
          url,
          ttl
        );

      data = result.data;
    }

    if (
      !data ||
      data.status === 'error' ||
      !Array.isArray(data.values) ||
      !data.values.length
    ) {
      stoppedReason =
        result.status === 429 ||
        result.providerError
          ? 'provider-error'
          : 'provider-no-more-data';

      pages.push({
        page: page + 1,
        received: 0,
        uniqueAdded: 0,
        oldest: null,
        newest: null,
        cached: !!result.cached,
        stale: !!result.stale,
        error: {
          request: {
            symbol: SYMBOL,
            timeframe: tf,
            interval: TF[tf],
            outputsize: pageSize,
            boundary
          },
          httpStatus:
            result.status || null,
          providerError:
            result.providerError ||
            data?.message ||
            null,
          error:
            result.error || null
        }
      });

      break;
    }

    const bars =
      normalizeBars(data.values)
        .sort(
          (a, b) =>
            a.time - b.time
        );

    if (!bars.length) {
      stoppedReason = 'invalid-page';
      break;
    }

    const oldest =
      bars[0].time;

    const newest =
      bars[bars.length - 1].time;

    const pageKey =
      `${oldest}|${newest}`;

    if (
      seenBoundaries.has(pageKey)
    ) {
      stoppedReason =
        'repeated-page';

      break;
    }

    seenBoundaries.add(pageKey);

    const before = all.size;

    for (const bar of bars) {
      all.set(bar.time, bar);
    }

    const uniqueAdded =
      all.size - before;

    pages.push({
      page: page + 1,
      received: bars.length,
      uniqueAdded,
      cached: !!result.cached,
      stale: !!result.stale,
      oldest:
        new Date(oldest).toISOString(),
      newest:
        new Date(newest).toISOString()
    });

    if (all.size >= wanted) {
      stoppedReason =
        'target-reached';
      break;
    }

    const nextEndMs =
      oldest -
      Math.max(
        1000,
        intervalMs / 10
      );

    if (
      endMs !== null &&
      nextEndMs >= endMs
    ) {
      stoppedReason =
        'pagination-boundary-did-not-move';
      break;
    }

    endMs = nextEndMs;
  }

  const out =
    Array.from(all.values())
      .sort(
        (a, b) =>
          a.time - b.time
      )
      .slice(-wanted);

  const meta = {
    requested: wanted,
    returned: out.length,
    pages: pages.length,
    complete:
      out.length >= wanted,
    providerLimited:
      out.length < wanted &&
      stoppedReason ===
        'provider-no-more-data',
    stoppedReason,
    cachePolicy: {
      ttlMs: ttl,
      pageSize: chunk,
      minGapMs:
        HISTORY_MIN_GAP_MS
    },
    oldest:
      out.length
        ? new Date(
            out[0].time
          ).toISOString()
        : null,
    newest:
      out.length
        ? new Date(
            out[out.length - 1].time
          ).toISOString()
        : null,
    pageDiagnostics: pages
  };

  Object.defineProperty(
    out,
    'historyMeta',
    {
      value: meta,
      enumerable: false,
      configurable: false
    }
  );

  historyDiagnostics.set(
    tf,
    meta
  );

  return out;
}

function getHistoryMeta(tf) {
  const meta =
    historyDiagnostics.get(tf);

  return meta
    ? JSON.parse(
        JSON.stringify(meta)
      )
    : null;
}

// ============================================================
// FUNDAMENTAL
// ============================================================

async function fetchFundamental() {
  const key =
    process.env.FRED_API_KEY;

  if (!key) {
    return {
      available: false,
      bias: 'NEUTRAL',
      score: 0,
      items: []
    };
  }

  const series = {
    fed: 'FEDFUNDS',
    unemployment: 'UNRATE',
    cpi: 'CPIAUCSL',
    coreCpi: 'CPILFESL',
    payroll: 'PAYEMS'
  };

  try {
    const out =
      await Promise.all(
        Object.entries(series)
          .map(
            async ([name, id]) => {
              const u =
                `https://api.stlouisfed.org/fred/series/observations` +
                `?series_id=${id}` +
                `&api_key=${key}` +
                `&file_type=json` +
                `&sort_order=desc` +
                `&limit=4`;

              const r =
                await fetch(
                  u,
                  { timeout: 8000 }
                );

              if (!r.ok) {
                return [
                  name,
                  null
                ];
              }

              const d =
                await r.json();

              const o =
                (d.observations || [])
                  .filter(
                    x =>
                      x.value !== '.'
                  );

              return [
                name,
                o
              ];
            }
          )
      );

    const vals =
      Object.fromEntries(out);

    let score = 0;
    const items = [];

    const add =
      (name, s, why) => {
        score += s;

        items.push({
          name,
          score: s,
          why
        });
      };

    if (
      vals.cpi?.length >= 2
    ) {
      const ch =
        +vals.cpi[0].value -
        +vals.cpi[1].value;

      add(
        'CPI',
        ch > 0 ? -5 : 5,
        ch > 0
          ? 'تورم رو به افزایش؛ فشار انقباضی برای طلا'
          : 'تورم رو به کاهش؛ فضای مساعدتر برای طلا'
      );
    }

    if (
      vals.coreCpi?.length >= 2
    ) {
      const ch =
        +vals.coreCpi[0].value -
        +vals.coreCpi[1].value;

      add(
        'Core CPI',
        ch > 0 ? -5 : 5,
        ch > 0
          ? 'Core CPI بالاتر'
          : 'Core CPI پایین‌تر'
      );
    }

    if (
      vals.unemployment?.length >= 2
    ) {
      const ch =
        +vals.unemployment[0].value -
        +vals.unemployment[1].value;

      add(
        'Unemployment',
        ch > 0 ? 4 : -4,
        ch > 0
          ? 'بیکاری بالاتر'
          : 'بیکاری پایین‌تر'
      );
    }

    if (
      vals.payroll?.length >= 2
    ) {
      const ch =
        +vals.payroll[0].value -
        +vals.payroll[1].value;

      add(
        'Payroll',
        ch < 0 ? 4 : -4,
        ch < 0
          ? 'اشتغال ضعیف‌تر'
          : 'اشتغال قوی‌تر'
      );
    }

    const bias =
      score >= 6
        ? 'BULLISH'
        : score <= -6
          ? 'BEARISH'
          : 'NEUTRAL';

    return {
      available: true,
      bias,
      score:
        clamp(
          50 + score * 3,
          0,
          100
        ),
      items
    };

  } catch (e) {
    return {
      available: false,
      bias: 'NEUTRAL',
      score: 0,
      items: [],
      error:
        'fundamental-fetch-failed'
    };
  }
}

async function fetchNewsRisk() {
  const key =
    process.env.FINNHUB_API_KEY;

  if (!key) {
    return {
      blocked: false,
      available: false,
      reason:
        'news-key-not-configured'
    };
  }

  try {
    const r =
      await fetch(
        `https://finnhub.io/api/v1/news?category=general&token=${key}`,
        { timeout: 8000 }
      );

    if (!r.ok) {
      return {
        blocked: false,
        available: false,
        reason:
          'news-provider-error'
      };
    }

    const data =
      await r.json();

    const now =
      Date.now();

    const wm =
      Number(
        process.env.NEWS_BLOCK_MINUTES ||
        30
      ) * 60000;

    const words =
      /fed|fomc|cpi|pce|nfp|nonfarm|payroll|interest rate|rate decision|powell|inflation|jobs report/i;

    const recent =
      (Array.isArray(data)
        ? data
        : []
      ).filter(a => {
        const ts =
          Number(
            a.datetime || 0
          ) * 1000;

        return (
          ts &&
          Math.abs(now - ts) <= wm &&
          words.test(
            `${a.headline || ''} ${a.summary || ''}`
          )
        );
      });

    return {
      blocked:
        recent.length > 0,
      available: true,
      reason:
        recent.length
          ? 'high-impact-news-window'
          : null,
      articles:
        recent
          .slice(0, 5)
          .map(a => ({
            headline:
              a.headline,
            source:
              a.source,
            url:
              a.url
          }))
    };

  } catch (e) {
    return {
      blocked: false,
      available: false,
      reason:
        'news-network-error'
    };
  }
}

function neutralFundamental() {
  return {
    available: false,
    bias: 'NEUTRAL',
    score: 50,
    items: []
  };
}

function neutralNewsRisk() {
  return {
    blocked: false,
    available: false,
    reason:
      'not-available-in-backtest'
  };
}

// ============================================================
// SESSION
// ============================================================

function getSession(timeMs) {
  const d =
    new Date(Number(timeMs));

  if (!Number.isFinite(d.getTime())) {
    return 'UNKNOWN';
  }

  const minutes =
    d.getUTCHours() * 60 +
    d.getUTCMinutes();

  if (minutes < 8 * 60) {
    return 'ASIA';
  }

  if (minutes < 13 * 60) {
    return 'LONDON';
  }

  if (minutes < 17 * 60) {
    return 'NEW_YORK';
  }

  return 'NEW_YORK_LATE';
}

// ============================================================
// BASIC TREND
// ============================================================

function trendBias(x) {
  if (!x) return 0;

  if (
    x.price > x.ema20 &&
    x.ema20 > x.ema50
  ) {
    return 1;
  }

  if (
    x.price < x.ema20 &&
    x.ema20 < x.ema50
  ) {
    return -1;
  }

  return 0;
}

// ============================================================
// TREND FOLLOWING — CALIBRATED INDEPENDENT ENGINE
// ============================================================

function trendStrategy(d) {

  const base = {
    name: 'Trend Following',
    strategyId: 'TREND_FOLLOWING',
    status: 'WATCH',
    vote: 'NEUTRAL',
    direction: 'WAIT',
    confidence: 0,
    reason: '',
    trigger: null,
    entry: null,
    stopLoss: null,
    targets: [],
    rr: 0,
    invalidation: null
  };

  if (
    !d ||
    !d.m15 ||
    !d.h1 ||
    !d.h4 ||
    !d.daily
  ) {
    return {
      ...base,
      reason:
        'داده تایم‌فریم‌های لازم موجود نیست'
    };
  }

  const h4 =
    trendBias(d.h4);

  const d1 =
    trendBias(d.daily);

  const h1 =
    trendBias(d.h1);

  const m =
    d.m15;

  const bars =
    m.bars || [];

  const atrValue =
    Number(m.atr || 0);

  const price =
    Number(m.price);

  if (
    !Number.isFinite(price) ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0
  ) {
    return {
      ...base,
      reason:
        'داده/ATR کافی برای Trend Following موجود نیست'
    };
  }

  if (
    TREND_MIN_ATR_USD > 0 &&
    atrValue < TREND_MIN_ATR_USD
  ) {
    return {
      ...base,
      reason:
        `ATR فعلی (${fmt(atrValue)}) کمتر از حداقل مجاز است`
    };
  }

  const dir =
    h4 === 1
      ? 'BUY'
      : h4 === -1
        ? 'SELL'
        : d1 === 1
          ? 'BUY'
          : d1 === -1
            ? 'SELL'
            : h1 === 1
              ? 'BUY'
              : h1 === -1
                ? 'SELL'
                : 'WAIT';

  if (dir === 'WAIT') {
    return {
      ...base,
      reason:
        'هیچ جهت روندی قابل اتکایی در تایم‌فریم‌های بالاتر دیده نمی‌شود'
    };
  }

  if (bars.length < 20) {
    return {
      ...base,
      direction: dir,
      vote: dir,
      reason:
        'داده 15M برای Trend Following کافی نیست'
    };
  }

  // ----------------------------------------------------------
  // HTF TREND SCORE
  // ----------------------------------------------------------

  let score = 0;
  const reasons = [];
  const warnings = [];

  // Daily
  if (
    (dir === 'BUY' && d1 === 1) ||
    (dir === 'SELL' && d1 === -1)
  ) {
    score += 22;
    reasons.push(
      'Daily هم‌جهت'
    );
  } else if (d1 === 0) {
    score += 8;
    warnings.push(
      'Daily خنثی'
    );
  } else {
    score -= 12;
    warnings.push(
      'Daily خلاف جهت'
    );
  }

  // 4H
  if (
    (dir === 'BUY' && h4 === 1) ||
    (dir === 'SELL' && h4 === -1)
  ) {
    score += 24;
    reasons.push(
      '4H هم‌جهت'
    );
  } else if (h4 === 0) {
    score += 7;
    warnings.push(
      '4H خنثی'
    );
  } else {
    score -= 14;
    warnings.push(
      '4H خلاف جهت'
    );
  }

  // 1H
  if (
    (dir === 'BUY' && h1 === 1) ||
    (dir === 'SELL' && h1 === -1)
  ) {
    score += 14;
    reasons.push(
      '1H تأییدکننده'
    );
  } else if (h1 === 0) {
    score += 5;
    warnings.push(
      '1H خنثی'
    );
  } else {
    score -= 8;
    warnings.push(
      '1H خلاف جهت'
    );
  }

  // اگر Daily و 4H کاملاً همسو باشند، پاداش اضافه.
  const fullHTFAlignment =
    h4 !== 0 &&
    d1 !== 0 &&
    h4 === d1 &&
    h4 === (dir === 'BUY' ? 1 : -1);

  if (fullHTFAlignment) {
    score += 8;
    reasons.push(
      'Daily و 4H کاملاً هم‌جهت'
    );
  }

  // حالت ضعیف‌تر:
  // فقط یکی از Daily/4H همسو است ولی H1 نیز تأیید می‌کند.
  const singleHTFWithH1 =
    TREND_ALLOW_SINGLE_HTF_WITH_H1 &&
    !fullHTFAlignment &&
    (
      (dir === 'BUY' &&
        (d1 === 1 || h4 === 1) &&
        h1 === 1) ||
      (dir === 'SELL' &&
        (d1 === -1 || h4 === -1) &&
        h1 === -1)
    );

  if (singleHTFWithH1) {
    score += 8;
    reasons.push(
      'یک تایم‌فریم بالاتر + 1H هم‌جهت'
    );
  }

  if (
    TREND_REQUIRE_HTF_ALIGNMENT &&
    !fullHTFAlignment
  ) {
    return {
      ...base,
      status: 'WATCH',
      vote: dir,
      direction: dir,
      confidence:
        Math.round(
          clamp(score)
        ),
      reason:
        'حالت سخت‌گیرانه HTF فعال است و Daily/4H هنوز کاملاً هم‌جهت نیستند'
    };
  }

  // ----------------------------------------------------------
  // 15M MOMENTUM
  // ----------------------------------------------------------

  const ema20 =
    Number(
      m.ema20 || price
    );

  const ema50 =
    Number(
      m.ema50 || ema20
    );

  const rrsi =
    Number(
      m.rsi || 50
    );

  const recent =
    bars.slice(
      -TREND_PULLBACK_LOOKBACK
    );

  const last =
    bars[bars.length - 1];

  const prev =
    bars[bars.length - 2];

  if (!last || !prev) {
    return {
      ...base,
      vote: dir,
      direction: dir,
      reason:
        'کندل‌های کافی برای Trigger وجود ندارد'
    };
  }

  // ----------------------------------------------------------
  // PULLBACK
  // ----------------------------------------------------------

  const pullbackBars =
    recent.slice(0, -1);

  const pullbackTouched =
    dir === 'BUY'
      ? pullbackBars.some(
          b =>
            b.low <=
            ema20 +
            atrValue *
              TREND_PULLBACK_ATR
        )
      : pullbackBars.some(
          b =>
            b.high >=
            ema20 -
            atrValue *
              TREND_PULLBACK_ATR
        );

  if (pullbackTouched) {
    score += 16;
    reasons.push(
      'Pullback به ناحیه EMA20'
    );
  } else {
    score -= 16;
    warnings.push(
      'Pullback کافی دیده نمی‌شود'
    );
  }

  // ----------------------------------------------------------
  // EMA ALIGNMENT
  // ----------------------------------------------------------

  const emaAligned =
    dir === 'BUY'
      ? price > ema20 &&
        ema20 >= ema50
      : price < ema20 &&
        ema20 <= ema50;

  if (emaAligned) {
    score += 12;
    reasons.push(
      'EMA20/EMA50 هم‌راستا'
    );
  } else {
    score -= 8;
    warnings.push(
      'EMA20/EMA50 کاملاً هم‌راستا نیستند'
    );
  }

  // ----------------------------------------------------------
  // RSI
  // ----------------------------------------------------------

  const healthyRsi =
    dir === 'BUY'
      ? rrsi >= TREND_BUY_RSI_MIN &&
        rrsi <= TREND_BUY_RSI_MAX
      : rrsi >= TREND_SELL_RSI_MIN &&
        rrsi <= TREND_SELL_RSI_MAX;

  if (healthyRsi) {
    score += 10;
    reasons.push(
      `RSI مناسب (${fmt(rrsi)})`
    );
  } else {
    score -= 7;
    warnings.push(
      `RSI خارج از محدوده مناسب (${fmt(rrsi)})`
    );
  }

  // ----------------------------------------------------------
  // CHASING
  // ----------------------------------------------------------

  const distanceFromEMA =
    Math.abs(
      price - ema20
    );

  const notChasing =
    distanceFromEMA <=
    atrValue *
      TREND_MAX_CHASE_ATR;

  if (notChasing) {
    score += 7;
    reasons.push(
      'قیمت بیش از حد از EMA20 دور نشده'
    );
  } else {
    score -= 10;
    warnings.push(
      'قیمت بیش از حد از EMA20 فاصله گرفته'
    );
  }

  // ----------------------------------------------------------
  // RECENT STRUCTURE
  // ----------------------------------------------------------

  const recentHigh =
    Math.max(
      ...bars
        .slice(-6, -1)
        .map(b => b.high)
    );

  const recentLow =
    Math.min(
      ...bars
        .slice(-6, -1)
        .map(b => b.low)
    );

  const previousRangeHigh =
    Math.max(
      ...bars
        .slice(-13, -1)
        .map(b => b.high)
    );

  const previousRangeLow =
    Math.min(
      ...bars
        .slice(-13, -1)
        .map(b => b.low)
    );

  // Trigger اصلی:
  // شکست ساختار کوتاه‌مدت یا شکست محدوده بزرگ‌تر.
  const continuation =
    dir === 'BUY'
      ? (
          last.close > prev.high ||
          last.close > recentHigh ||
          last.close > previousRangeHigh
        )
      : (
          last.close < prev.low ||
          last.close < recentLow ||
          last.close < previousRangeLow
        );

  if (continuation) {
    score += 18;
    reasons.push(
      'Continuation / شکست ساختار کوتاه‌مدت'
    );
  } else {
    score -= 10;
    warnings.push(
      'Continuation هنوز تأیید نشده'
    );
  }

  // ----------------------------------------------------------
  // CANDLE QUALITY
  // ----------------------------------------------------------

  const candleRange =
    Math.max(
      last.high - last.low,
      0.0001
    );

  const body =
    Math.abs(
      last.close - last.open
    );

  const bodyRatio =
    body / candleRange;

  const candleSupportsDirection =
    dir === 'BUY'
      ? last.close >= last.open
      : last.close <= last.open;

  if (
    candleSupportsDirection &&
    bodyRatio >= 0.35
  ) {
    score += 5;
    reasons.push(
      'کندل Trigger کیفیت قابل قبول دارد'
    );
  } else if (
    candleSupportsDirection
  ) {
    score += 2;
  } else {
    score -= 4;
    warnings.push(
      'کندل Trigger خلاف جهت یا ضعیف است'
    );
  }

  // ----------------------------------------------------------
  // INTERNAL SCORE
  // ----------------------------------------------------------

  score =
    Math.round(
      clamp(score)
    );

  const setup =
    pullbackTouched &&
    healthyRsi &&
    emaAligned &&
    notChasing &&
    score >= TREND_MIN_SETUP_SCORE;

  // ----------------------------------------------------------
  // CONFIDENCE
  // ----------------------------------------------------------

  // Confidence مستقل از score خام ساخته می‌شود.
  // این باعث می‌شود یک Trend خوب ولی نه ایده‌آل
  // شانس رسیدن به 72 را داشته باشد.
  let confidence =
    50 +
    Math.round(
      score * 0.45
    );

  if (fullHTFAlignment) {
    confidence += 8;
  } else if (singleHTFWithH1) {
    confidence += 3;
  }

  if (pullbackTouched) {
    confidence += 5;
  }

  if (continuation) {
    confidence += 5;
  }

  if (notChasing) {
    confidence += 3;
  }

  confidence =
    Math.round(
      clamp(confidence)
    );

  // ----------------------------------------------------------
  // WATCH / SETUP
  // ----------------------------------------------------------

  if (!setup) {
    return {
      ...base,
      status:
        continuation &&
        pullbackTouched
          ? 'SETUP'
          : 'WATCH',

      vote: dir,
      direction: dir,
      confidence,

      reason:
        `Trend ${dir}: شرایط کامل ورود هنوز فراهم نیست | ` +
        `${reasons.slice(-3).join('، ')}`,

      trigger:
        dir === 'BUY'
          ? `کلوز 15M بالای ${fmt(prev.high)} یا شکست سقف کوتاه‌مدت`
          : `کلوز 15M زیر ${fmt(prev.low)} یا شکست کف کوتاه‌مدت`,

      diagnostics: {
        score,
        setupScoreRequired:
          TREND_MIN_SETUP_SCORE,
        fullHTFAlignment,
        singleHTFWithH1,
        h4,
        d1,
        h1,
        pullbackTouched,
        emaAligned,
        healthyRsi,
        notChasing,
        continuation,
        bodyRatio:
          fmt(bodyRatio),
        reasons,
        warnings
      }
    };
  }

  // ----------------------------------------------------------
  // TRADE CONSTRUCTION
  // ----------------------------------------------------------

  const pullbackLow =
    Math.min(
      ...pullbackBars.map(
        b => b.low
      )
    );

  const pullbackHigh =
    Math.max(
      ...pullbackBars.map(
        b => b.high
      )
    );

  let sl;
  let risk;

  if (dir === 'BUY') {
    sl =
      pullbackLow -
      atrValue * 0.15;

    if (
      price - sl <
      MIN_STOP_USD
    ) {
      sl =
        price -
        MIN_STOP_USD;
    }

    risk =
      price - sl;

  } else {

    sl =
      pullbackHigh +
      atrValue * 0.15;

    if (
      sl - price <
      MIN_STOP_USD
    ) {
      sl =
        price +
        MIN_STOP_USD;
    }

    risk =
      sl - price;
  }

  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {
    return {
      ...base,
      status: 'SETUP',
      vote: dir,
      direction: dir,
      confidence,
      reason:
        'ریسک معامله معتبر محاسبه نشد',
      diagnostics: {
        score,
        reasons,
        warnings
      }
    };
  }

  // ----------------------------------------------------------
  // STRUCTURAL TARGET
  // ----------------------------------------------------------

  const levels =
    nearestLevels(
      price,
      dir,
      d
    );

  const structuralTarget =
    dir === 'BUY'
      ? levels.nextResistance
      : levels.nextSupport;

  const minTarget =
    dir === 'BUY'
      ? price + risk * MIN_RR
      : price - risk * MIN_RR;

  const hasSpace =
    dir === 'BUY'
      ? (
          !structuralTarget ||
          structuralTarget >= minTarget
        )
      : (
          !structuralTarget ||
          structuralTarget <= minTarget
        );

  if (!hasSpace) {
    return {
      ...base,
      status: 'SETUP',
      vote: dir,
      direction: dir,
      confidence:
        Math.min(
          confidence,
          69
        ),
      reason:
        'Trend فعال است ولی فضای کافی تا سطح ساختاری بعدی برای R:R مطلوب وجود ندارد',
      trigger:
        'منتظر ایجاد فضای مناسب‌تر برای R:R',
      diagnostics: {
        score,
        structuralTarget,
        minTarget,
        risk,
        reasons,
        warnings
      }
    };
  }

  const tp1 =
    structuralTarget &&
    (
      (
        dir === 'BUY' &&
        structuralTarget >= minTarget
      ) ||
      (
        dir === 'SELL' &&
        structuralTarget <= minTarget
      )
    )
      ? structuralTarget
      : minTarget;

  const tp2 =
    dir === 'BUY'
      ? price + risk * 2.4
      : price - risk * 2.4;

  const tp3 =
    dir === 'BUY'
      ? price + risk * 3.2
      : price - risk * 3.2;

  const rr =
    Math.abs(
      tp1 - price
    ) / risk;

  if (
    !Number.isFinite(rr) ||
    rr < MIN_RR
  ) {
    return {
      ...base,
      status: 'SETUP',
      vote: dir,
      direction: dir,
      confidence:
        Math.min(
          confidence,
          69
        ),
      reason:
        `R:R محاسبه‌شده کمتر از ${MIN_RR} است`,
      diagnostics: {
        score,
        rr,
        risk,
        reasons,
        warnings
      }
    };
  }

  // ----------------------------------------------------------
  // ACTIVE
  // ----------------------------------------------------------

  return {
    ...base,

    status: 'ACTIVE',

    vote: dir,

    direction: dir,

    confidence,

    reason:
      `Trend ${dir}: روند بالاتر + Pullback + مومنتوم + Continuation تأیید شد`,

    trigger:
      dir === 'BUY'
        ? `کلوز 15M بالای ${fmt(prev.high)}`
        : `کلوز 15M زیر ${fmt(prev.low)}`,

    entry: {
      low:
        fmt(
          price -
          atrValue * 0.05
        ),
      high:
        fmt(
          price +
          atrValue * 0.05
        )
    },

    stopLoss:
      fmt(sl),

    targets: [
      fmt(tp1),
      fmt(tp2),
      fmt(tp3)
    ],

    rr:
      fmt(rr),

    invalidation:
      dir === 'BUY'
        ? `کلوز 15M زیر ${fmt(pullbackLow)}`
        : `کلوز 15M بالای ${fmt(pullbackHigh)}`,

    levels,

    diagnostics: {
      score,
      setupScoreRequired:
        TREND_MIN_SETUP_SCORE,
      fullHTFAlignment,
      singleHTFWithH1,
      h4,
      d1,
      h1,
      pullbackTouched,
      emaAligned,
      healthyRsi,
      notChasing,
      continuation,
      bodyRatio:
        fmt(bodyRatio),
      atr:
        fmt(atrValue),
      risk:
        fmt(risk),
      reasons,
      warnings
    }
  };
}

// ============================================================
// STRATEGIES
// ============================================================

function runStrategies(d, fund) {

  const trend =
    trendStrategy(d);

  const structureVote =
    d.m15.structure ===
      'BULLISH_BOS'
      ? 'BUY'
      : d.m15.structure ===
          'BEARISH_BOS'
        ? 'SELL'
        : 'NEUTRAL';

  const sweepVote =
    d.m15.sweep ===
      'SWEEP_LOW'
      ? 'BUY'
      : d.m15.sweep ===
          'SWEEP_HIGH'
        ? 'SELL'
        : 'NEUTRAL';

  const momVote =
    (
      d.m15.rsi > 50 &&
      d.m15.rsi < 75 &&
      d.m15.price >
        d.m15.ema20
    )
      ? 'BUY'
      : (
          d.m15.rsi < 50 &&
          d.m15.rsi > 25 &&
          d.m15.price <
            d.m15.ema20
        )
        ? 'SELL'
        : 'NEUTRAL';

  const fib =
    fibZone(d);

  const div =
    divergence(
      d.m15.bars
    );

  const fundVote =
    fund.bias === 'BULLISH'
      ? 'BUY'
      : fund.bias === 'BEARISH'
        ? 'SELL'
        : 'NEUTRAL';

  const strategies = [

    trend,

    {
      name:
        'ساختار بازار (BOS/CHoCH)',

      strategyId:
        'STRUCTURE',

      status:
        structureVote ===
          'NEUTRAL'
          ? 'WATCH'
          : 'SETUP',

      vote:
        structureVote,

      direction:
        structureVote,

      confidence: 0,

      weight: 0,

      reason:
        structureVote === 'BUY'
          ? 'BOS صعودی 15M'
          : structureVote === 'SELL'
            ? 'BOS نزولی 15M'
            : 'ساختار 15M آمیخته'
    },

    {
      name:
        'Liquidity Sweep (SMC)',

      strategyId:
        'LIQUIDITY_SWEEP',

      status:
        sweepVote ===
          'NEUTRAL'
          ? 'WATCH'
          : 'SETUP',

      vote:
        sweepVote,

      direction:
        sweepVote,

      confidence: 0,

      weight: 0,

      reason:
        sweepVote === 'BUY'
          ? 'Sweep نقدینگی زیر کف و بازگشت'
          : sweepVote === 'SELL'
            ? 'Sweep نقدینگی بالای سقف و بازگشت'
            : 'Sweep فعال وجود ندارد'
    },

    {
      name:
        'مومنتوم (RSI + EMA20)',

      strategyId:
        'MOMENTUM',

      status:
        momVote ===
          'NEUTRAL'
          ? 'WATCH'
          : 'SETUP',

      vote:
        momVote,

      direction:
        momVote,

      confidence: 0,

      weight: 0,

      reason:
        momVote === 'BUY'
          ? `RSI ${fmt(d.m15.rsi)} بالای 50 و قیمت بالای EMA20`
          : momVote === 'SELL'
            ? `RSI ${fmt(d.m15.rsi)} زیر 50 و قیمت زیر EMA20`
            : 'مومنتوم خنثی/افراطی'
    },

    {
      name:
        'Fibonacci Retracement',

      strategyId:
        'FIBONACCI',

      status:
        'WATCH',

      vote:
        'NEUTRAL',

      direction:
        'WAIT',

      confidence: 0,

      weight: 0,

      contextVote:
        fib.vote,

      reason:
        fib.reason
    },

    {
      name:
        'واگرایی RSI',

      strategyId:
        'RSI_DIVERGENCE',

      status:
        'WATCH',

      vote:
        'NEUTRAL',

      direction:
        'WAIT',

      confidence: 0,

      weight: 0,

      contextVote:
        div.vote,

      reason:
        div.reason
    },

    {
      name:
        'فاندامنتال (FRED)',

      strategyId:
        'FUNDAMENTAL',

      status:
        fundVote ===
          'NEUTRAL'
          ? 'WATCH'
          : 'SETUP',

      vote:
        fundVote,

      direction:
        fundVote,

      confidence: 0,

      weight: 0,

      reason:
        fund.items?.length
          ? fund.items
              .map(i => i.why)
              .join('، ')
          : 'فاندامنتال تاریخی/کافی در این نقطه موجود نیست'
    }
  ];

  return {
    strategies,

    volumeConfirmed:
      !!d.m15.volumeState.confirmed,

    triggerStrategy:
      trend.status === 'ACTIVE'
        ? trend
        : null,

    context: {
      fib,
      divergence: div,
      sweep: {
        vote:
          sweepVote
      },
      structure: {
        vote:
          structureVote
      },
      h4Trend:
        trendBias(d.h4),
      d1Trend:
        trendBias(d.daily),
      h1Trend:
        trendBias(d.h1)
    }
  };
}

// ============================================================
// COMPATIBILITY ONLY
// ============================================================

function computeConsensus(
  strategies,
  volumeConfirmed
) {
  const active =
    strategies.filter(
      s =>
        s.status === 'ACTIVE'
    );

  const trigger =
    active[0] || null;

  return {
    mode:
      'INDEPENDENT_STRATEGIES',

    dir:
      trigger?.direction ||
      'WAIT',

    confidence:
      trigger?.confidence ||
      0,

    triggerStrategy:
      trigger?.strategyId ||
      null,

    activeStrategies:
      active.map(
        s => s.strategyId
      ),

    agreeCount:
      active.length,

    totalCount:
      strategies.length,

    volumeConfirmed:
      !!volumeConfirmed
  };
}

// ============================================================
// MARKET REGIME
// ============================================================

function marketRegime(d) {

  const h4Trend =
    trendBias(d.h4);

  const d1Trend =
    trendBias(d.daily);

  const m =
    d.m15;

  const aligned =
    h4Trend !== 0 &&
    h4Trend === d1Trend;

  const atrValue =
    m.atr || 0;

  const rangeWidth =
    (m.range?.high || 0) -
    (m.range?.low || 0);

  const atrPct =
    m.price
      ? atrValue / m.price
      : 0;

  if (
    aligned &&
    atrValue > 0
  ) {
    return {
      name:
        'TREND',
      score:
        2,
      reason:
        '4H و Daily هم‌جهت‌اند'
    };
  }

  if (
    rangeWidth > 0 &&
    atrValue > 0 &&
    rangeWidth / atrValue < 10
  ) {
    return {
      name:
        'RANGE',
      score:
        -1,
      reason:
        'محدوده نسبتاً فشرده در برابر ATR'
    };
  }

  return {
    name:
      'TRANSITION',
    score:
      0,
    reason:
      'روند و رنج هم‌زمان شفاف نیستند',
    atrPct
  };
}

// ============================================================
// OLD QUALITY FUNCTION
// ============================================================
// این تابع فعلاً برای compatibility نگه داشته شده.
// در مسیر تصمیم مستقل جدید، جهت معامله را تعیین نمی‌کند.

function scoreSignalQuality(
  d,
  consensus,
  context,
  trade,
  news
) {
  let score = 45;

  const reasons = [];
  const penalties = [];

  const dir =
    consensus.dir;

  const reg =
    marketRegime(d);

  if (reg.name === 'TREND') {
    score += 8;
    reasons.push(
      'رژیم روندی'
    );
  } else if (
    reg.name === 'RANGE'
  ) {
    score -= 3;
    penalties.push(
      'رژیم رنج'
    );
  } else {
    score -= 1;
    penalties.push(
      'رژیم Transition'
    );
  }

  const structure =
    context?.structure?.vote ||
    'NEUTRAL';

  const sweep =
    context?.sweep?.vote ||
    'NEUTRAL';

  if (
    structure === dir
  ) {
    score += 12;
    reasons.push(
      'ساختار 15M هم‌جهت'
    );
  } else if (
    structure === 'NEUTRAL'
  ) {
    score -= 4;
    penalties.push(
      'ساختار 15M خنثی'
    );
  } else {
    score -= 8;
    penalties.push(
      'ساختار خلاف جهت'
    );
  }

  if (
    sweep === dir
  ) {
    score += 15;
    reasons.push(
      'Liquidity Sweep هم‌جهت'
    );
  } else if (
    sweep === 'NEUTRAL'
  ) {
    score -= 4;
    penalties.push(
      'Sweep تأیید نشده'
    );
  } else {
    score -= 10;
    penalties.push(
      'Sweep خلاف جهت'
    );
  }

  const momentumDir =
    (
      d.m15.rsi > 50 &&
      d.m15.rsi < 75 &&
      d.m15.price >
        d.m15.ema20
    )
      ? 'BUY'
      : (
          d.m15.rsi < 50 &&
          d.m15.rsi > 25 &&
          d.m15.price <
            d.m15.ema20
        )
        ? 'SELL'
        : 'NEUTRAL';

  if (
    momentumDir === dir
  ) {
    score += 8;
    reasons.push(
      'مومنتوم سالم'
    );
  } else {
    score -= 4;
    penalties.push(
      'مومنتوم تأیید نمی‌کند'
    );
  }

  const h4Trend =
    trendBias(d.h4);

  const d1Trend =
    trendBias(d.daily);

  if (
    (dir === 'BUY' &&
      h4Trend === 1 &&
      d1Trend === 1) ||
    (dir === 'SELL' &&
      h4Trend === -1 &&
      d1Trend === -1)
  ) {
    score += 8;
    reasons.push(
      '4H و Daily هم‌جهت'
    );
  }

  const rr =
    Number(
      trade?.rr || 0
    );

  if (rr >= 2.5) {
    score += 5;
  } else if (rr >= 2.0) {
    score += 4;
  } else if (
    rr >= MIN_RR
  ) {
    score += 2;
  } else {
    score -= 12;
    penalties.push(
      `R:R کمتر از ${MIN_RR}`
    );
  }

  if (
    news?.blocked
  ) {
    score -= 30;
    penalties.push(
      'خبر پرریسک'
    );
  }

  const atrValue =
    Number(
      d.m15.atr || 0
    );

  const price =
    Number(
      d.m15.price
    );

  if (
    atrValue > 0 &&
    Number.isFinite(
      trade?.stopLoss
    )
  ) {
    const stopDistance =
      Math.abs(
        price -
        Number(
          trade.stopLoss
        )
      );

    const stopAtr =
      stopDistance /
      atrValue;

    if (
      stopAtr >= 0.8 &&
      stopAtr <= 2.8
    ) {
      score += 4;
    } else if (
      stopAtr < 0.6
    ) {
      score -= 8;
      penalties.push(
        'حد ضرر بیش از حد نزدیک'
      );
    } else if (
      stopAtr > 3.5
    ) {
      score -= 3;
      penalties.push(
        'حد ضرر بسیار بزرگ'
      );
    }
  }

  if (
    atrValue > 0 &&
    trade?.entry
  ) {
    const entryMid =
      (
        Number(
          trade.entry.low
        ) +
        Number(
          trade.entry.high
        )
      ) / 2;

    const entryDistanceAtr =
      Math.abs(
        entryMid - price
      ) / atrValue;

    if (
      entryDistanceAtr >
      MAX_SPREAD_PROXY_ATR
    ) {
      score -= 8;

      penalties.push(
        `فاصله ورود از قیمت فعلی > ${MAX_SPREAD_PROXY_ATR} ATR`
      );
    }
  }

  score =
    Math.round(
      clamp(score)
    );

  let grade =
    'POOR';

  if (score >= 85) {
    grade =
      'EXCELLENT';
  } else if (score >= 75) {
    grade =
      'GOOD';
  } else if (score >= 65) {
    grade =
      'FAIR';
  }

  const tradable =
    score >= 65 &&
    !news?.blocked;

  return {
    score,
    grade,
    tradable,
    regime: reg,
    reasons: [
      ...new Set(reasons)
    ],
    penalties: [
      ...new Set(penalties)
    ],
    blockers: [
      ...new Set(
        penalties.filter(
          x =>
            /خبر|R:R|ضرر|خلاف جهت|فاصله ورود/.test(x)
        )
      )
    ]
  };
}

// ============================================================
// SUPPORT / RESISTANCE
// ============================================================

function nearestLevels(
  price,
  dir,
  d
) {
  const levels = [
    ...d.m15.pivots.highs,
    ...d.m15.pivots.lows,

    d.h1.range.high,
    d.h1.range.low,

    d.h4.range.high,
    d.h4.range.low,

    d.daily.range.high,
    d.daily.range.low
  ]
    .filter(
      Number.isFinite
    );

  const above =
    [
      ...new Set(
        levels.filter(
          x =>
            x >
            price + 0.15
        )
      )
    ]
      .sort(
        (a, b) =>
          a - b
      );

  const below =
    [
      ...new Set(
        levels.filter(
          x =>
            x <
            price - 0.15
        )
      )
    ]
      .sort(
        (a, b) =>
          b - a
      );

  return {
    nextResistance:
      above[0] || null,

    nextSupport:
      below[0] || null
  };
}

// ============================================================
// HYPOTHETICAL TRADE
// ============================================================

function buildTrade(
  d,
  dir
) {
  const p =
    d.m15.price;

  const a =
    Math.max(
      d.m15.atr || 2,
      1.5
    );

  const levels =
    nearestLevels(
      p,
      dir,
      d
    );

  let entryLow;
  let entryHigh;
  let sl;
  let tp1;
  let tp2;
  let tp3;
  let trigger;

  if (dir === 'BUY') {

    const support =
      Math.max(
        d.m15.range.low,
        d.m15.ema20 ||
          d.m15.range.low
      );

    entryLow =
      Math.max(
        d.m15.range.low,
        p - a * 0.35
      );

    entryHigh =
      Math.min(
        p + a * 0.12,
        support + a * 0.30
      );

    if (
      entryHigh < entryLow
    ) {
      entryHigh =
        entryLow +
        a * 0.12;
    }

    sl =
      Math.min(
        d.m15.range.low -
          a * 0.20,
        p - a * 1.05
      );

    if (
      levels.nextSupport &&
      levels.nextSupport <
        entryLow
    ) {
      sl =
        Math.min(
          sl,
          levels.nextSupport -
            a * 0.12
        );
    }

    if (
      entryHigh - sl <
      MIN_STOP_USD
    ) {
      sl =
        entryHigh -
        MIN_STOP_USD;
    }

    const risk =
      entryHigh - sl;

    const structuralTarget =
      levels.nextResistance &&
      levels.nextResistance >
        entryHigh
        ? levels.nextResistance
        : Infinity;

    const rTarget =
      entryHigh +
      risk * MIN_RR;

    tp1 =
      Math.max(
        rTarget,
        entryHigh +
          risk * 1.8
      );

    if (
      structuralTarget !== Infinity &&
      structuralTarget >=
        rTarget
    ) {
      tp1 =
        structuralTarget;
    }

    tp2 =
      entryHigh +
      risk * 2.4;

    tp3 =
      entryHigh +
      risk * 3.2;

    trigger =
      '15M: Pullback + شکست ساختار + کلوز بالای EMA20 + RSI سالم';

  } else {

    const resistance =
      Math.min(
        d.m15.range.high,
        d.m15.ema20 ||
          d.m15.range.high
      );

    entryHigh =
      Math.min(
        d.m15.range.high,
        p + a * 0.35
      );

    entryLow =
      Math.max(
        p - a * 0.12,
        resistance -
          a * 0.30
      );

    if (
      entryLow > entryHigh
    ) {
      entryLow =
        entryHigh -
        a * 0.12;
    }

    sl =
      Math.max(
        d.m15.range.high +
          a * 0.20,
        p + a * 1.05
      );

    if (
      levels.nextResistance &&
      levels.nextResistance >
        entryHigh
    ) {
      sl =
        Math.max(
          sl,
          levels.nextResistance +
            a * 0.12
        );
    }

    if (
      sl - entryLow <
      MIN_STOP_USD
    ) {
      sl =
        entryLow +
        MIN_STOP_USD;
    }

    const risk =
      sl - entryLow;

    const structuralTarget =
      levels.nextSupport &&
      levels.nextSupport <
        entryLow
        ? levels.nextSupport
        : -Infinity;

    const rTarget =
      entryLow -
      risk * MIN_RR;

    tp1 =
      Math.min(
        rTarget,
        entryLow -
          risk * 1.8
      );

    if (
      structuralTarget !== -Infinity &&
      structuralTarget <=
        rTarget
    ) {
      tp1 =
        structuralTarget;
    }

    tp2 =
      entryLow -
      risk * 2.4;

    tp3 =
      entryLow -
      risk * 3.2;

    trigger =
      '15M: Pullback + شکست ساختار + کلوز زیر EMA20 + RSI سالم';
  }

  const rr =
    dir === 'BUY'
      ? (
          tp1 - entryHigh
        ) /
        (
          entryHigh - sl
        )
      : (
          entryLow - tp1
        ) /
        (
          sl - entryLow
        );

  return {
    entry: {
      low:
        fmt(entryLow),
      high:
        fmt(entryHigh)
    },

    stopLoss:
      fmt(sl),

    targets: [
      fmt(tp1),
      fmt(tp2),
      fmt(tp3)
    ],

    rr:
      fmt(rr),

    trigger,
    levels
  };
}

// ============================================================
// FINAL DECISION
// ============================================================

function decide(
  d,
  fund,
  news,
  options = {}
) {

  const {
    strategies,
    volumeConfirmed,
    context,
    triggerStrategy
  } =
    runStrategies(
      d,
      fund
    );

  const trend =
    strategies.find(
      s =>
        s.strategyId ===
        'TREND_FOLLOWING'
    );

  const activeStrategies =
    strategies.filter(
      s =>
        s.status ===
        'ACTIVE'
    );

  // IMPORTANT:
  // هیچ اجماع وزنی وجود ندارد.
  // Trend مستقل تصمیم می‌گیرد.
  const signal =
    triggerStrategy;

  const dir =
    signal?.direction ||
    'WAIT';

  const trade =
    signal?.status === 'ACTIVE'
      ? {
          entry:
            signal.entry,

          stopLoss:
            signal.stopLoss,

          targets:
            signal.targets,

          rr:
            signal.rr,

          trigger:
            signal.trigger,

          invalidation:
            signal.invalidation,

          levels:
            signal.levels
        }
      : buildTrade(
          d,
          dir === 'WAIT'
            ? (
                trend?.direction ||
                'BUY'
              )
            : dir
        );

  if (!signal) {
    trade.isHypothetical =
      true;
  }

  const blockers = [];

  if (!signal) {
    blockers.push(
      trend?.status === 'SETUP'
        ? 'Trend setup تشکیل شده ولی Trigger هنوز فعال نشده'
        : 'هیچ استراتژی مستقل فعلاً Trigger فعال ندارد'
    );
  }

  if (
    news?.blocked
  ) {
    blockers.push(
      'خبر پرریسک در پنجره نزدیک'
    );
  }

  if (
    signal &&
    Number(signal.rr || 0) <
      MIN_RR
  ) {
    blockers.push(
      `R:R کمتر از ${MIN_RR}`
    );
  }

  const confidence =
    signal?.confidence ||
    0;

  const reg =
    marketRegime(d);

  const quality = {

    score:
      confidence,

    grade:
      confidence >= 85
        ? 'EXCELLENT'
        : confidence >= 75
          ? 'GOOD'
          : confidence >= 65
            ? 'FAIR'
            : 'POOR',

    tradable:
      !!signal &&
      confidence >=
        MIN_CONFIDENCE &&
      !news?.blocked &&
      Number(signal.rr || 0) >=
        MIN_RR,

    regime:
      reg,

    reasons:
      signal
        ? [
            signal.reason,
            ...(signal.diagnostics?.reasons || [])
          ]
        : [],

    penalties:
      [
        ...blockers,
        ...(signal?.diagnostics?.warnings || [])
      ],

    blockers:
      blockers
  };

  const consensus =
    computeConsensus(
      strategies,
      volumeConfirmed
    );

  consensus.dir =
    dir;

  consensus.confidence =
    confidence;

  consensus.triggerStrategy =
    signal?.strategyId ||
    null;

  consensus.activeStrategies =
    activeStrategies.map(
      s => s.strategyId
    );

  // ----------------------------------------------------------
  // FINAL HARD GATE
  // ----------------------------------------------------------

  const hardActive =
    !!signal &&
    signal.status === 'ACTIVE' &&
    confidence >=
      MIN_CONFIDENCE &&
    blockers.length === 0;

  const active =
    options.ignoreQuality
      ? hardActive
      : (
          hardActive &&
          quality.tradable
        );

  return {

    decision:
      active
        ? dir
        : 'WAIT',

    direction:
      dir,

    confidence,

    scores: {
      buy:
        dir === 'BUY'
          ? confidence
          : 0,

      sell:
        dir === 'SELL'
          ? confidence
          : 0
    },

    consensus,

    architecture:
      'INDEPENDENT_STRATEGIES',

    triggerStrategy:
      signal?.strategyId ||
      null,

    regime:
      quality.regime,

    quality,

    strategies,

    trade,

    blockers,

    fundamental:
      fund,

    newsRisk:
      news,

    diagnostics: {

      independent:
        true,

      activeStrategies:
        activeStrategies.map(
          s =>
            s.strategyId
        ),

      firstEngineImplemented:
        'TREND_FOLLOWING',

      otherEnginesAreDiagnosticOnly:
        true,

      trendCalibration: {
        pullbackLookback:
          TREND_PULLBACK_LOOKBACK,

        pullbackAtr:
          TREND_PULLBACK_ATR,

        maxChaseAtr:
          TREND_MAX_CHASE_ATR,

        buyRsi:
          [
            TREND_BUY_RSI_MIN,
            TREND_BUY_RSI_MAX
          ],

        sellRsi:
          [
            TREND_SELL_RSI_MIN,
            TREND_SELL_RSI_MAX
          ],

        minSetupScore:
          TREND_MIN_SETUP_SCORE,

        allowSingleHTFWithH1:
          TREND_ALLOW_SINGLE_HTF_WITH_H1,

        requireHTFAlignment:
          TREND_REQUIRE_HTF_ALIGNMENT
      }
    }
  };
}

// ============================================================

module.exports = {

  SYMBOL,

  TF,

  MIN_CONFIDENCE,

  MIN_RR,

  analyze,

  decide,

  fetchTF,

  fetchTFHistory,

  getHistoryMeta,

  getSession,

  fetchFundamental,

  fetchNewsRisk,

  neutralFundamental,

  neutralNewsRisk

};
