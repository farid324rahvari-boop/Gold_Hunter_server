// Gold Hunter — Decision Engine Core
// Quality Engine + Regime + Context + Early Trigger
// Confidence separated from Quality
// Reliable historical pagination

const fetch = require('node-fetch');
const { fetchJson } = require('./market-cache');

const SYMBOL = process.env.XAU_SYMBOL || 'XAU/USD';

const TF = {
  '15M': '15min',
  '1H': '1h',
  '4H': '4h',
  'Daily': '1day'
};

const MIN_CONFIDENCE =
  Number(process.env.MIN_SIGNAL_CONFIDENCE || 72);

const MIN_RR =
  Number(process.env.MIN_SIGNAL_RR || 1.8);

const MIN_QUALITY_SCORE =
  Number(process.env.MIN_QUALITY_SCORE || 65);

const MAX_SPREAD_PROXY_ATR =
  Number(process.env.MAX_ENTRY_ATR_DISTANCE || 0.55);

const MIN_STOP_USD =
  Number(process.env.MIN_STOP_DISTANCE_USD || 3);

const HISTORY_MAX_BARS = 50000;
const HISTORY_CHUNK = 4500;

const clamp = (x, a = 0, b = 100) =>
  Math.max(a, Math.min(b, x));

const fmt = x =>
  Number(Number(x).toFixed(2));

function ema(a, n) {
  if (!a || a.length < n) return null;

  const k = 2 / (n + 1);
  let e = a[0];

  for (let i = 1; i < a.length; i++) {
    e = a[i] * k + e * (1 - k);
  }

  return e;
}

function rsi(a, n = 14) {
  if (!a || a.length < n + 1) return 50;

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
  if (!b || b.length < n + 1) return null;

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

function pivots(b, n = 40) {
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
    highs: highs.slice(-8),
    lows: lows.slice(-8)
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
  if (!b || b.length < 8) return 'NONE';

  const a = b.slice(-8, -1);
  const c = b[b.length - 1];

  const hi = Math.max(...a.map(v => v.high));
  const lo = Math.min(...a.map(v => v.low));

  if (
    c.high > hi &&
    c.close < hi
  ) {
    return 'SWEEP_HIGH';
  }

  if (
    c.low < lo &&
    c.close > lo
  ) {
    return 'SWEEP_LOW';
  }

  return 'NONE';
}

function momentum(b) {
  const c = b.map(x => x.close);

  const e20 =
    ema(c.slice(-80), 20);

  const e50 =
    ema(c.slice(-120), 50);

  const rr =
    rsi(c);

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
  const v =
    b
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
    v
      .slice(0, -1)
      .reduce((a, x) => a + x, 0) /
    (v.length - 1);

  const current =
    Number(b[b.length - 1].volume || 0);

  return {
    available: true,

    ratio:
      av > 0
        ? current / av
        : null,

    confirmed:
      av > 0 &&
      current >
      av * 1.15
  };
}

/*
 * Fibonacci is now CONTEXT, not an independent vote.
 */
function fibZone(d) {
  const piv = d.m15.pivots;

  if (
    !piv.highs.length ||
    !piv.lows.length
  ) {
    return {
      vote: 'NEUTRAL',
      context: 0,
      reason:
        'داده کافی برای تشخیص سوئینگ فیبوناچی نیست'
    };
  }

  const swingHigh =
    Math.max(...piv.highs.slice(-3));

  const swingLow =
    Math.min(...piv.lows.slice(-3));

  const span =
    swingHigh - swingLow;

  if (!(span > 0)) {
    return {
      vote: 'NEUTRAL',
      context: 0,
      reason:
        'محدوده سوئینگ نامعتبر است'
    };
  }

  const price = d.m15.price;

  const retFromHigh =
    (swingHigh - price) / span;

  const retFromLow =
    (price - swingLow) / span;

  const goldenHigh =
    retFromHigh >= 0.382 &&
    retFromHigh <= 0.618;

  const goldenLow =
    retFromLow >= 0.382 &&
    retFromLow <= 0.618;

  if (
    price > d.m15.ema20 &&
    goldenHigh
  ) {
    return {
      vote: 'BUY',
      context: 1,
      reason:
        `اصلاح فیبوناچی ${Math.round(
          retFromHigh * 100
        )}% در ساختار صعودی`
    };
  }

  if (
    price < d.m15.ema20 &&
    goldenLow
  ) {
    return {
      vote: 'SELL',
      context: 1,
      reason:
        `اصلاح فیبوناچی ${Math.round(
          retFromLow * 100
        )}% در ساختار نزولی`
    };
  }

  return {
    vote: 'NEUTRAL',
    context: 0,
    reason:
      'قیمت در ناحیه کلیدی فیبوناچی نیست'
  };
}

/*
 * RSI divergence is now CONTEXT, not an independent vote.
 */
function divergence(bars) {
  if (!bars || bars.length < 30) {
    return {
      vote: 'NEUTRAL',
      context: 0,
      reason:
        'داده کافی برای واگرایی نیست'
    };
  }

  const closes =
    bars.map(b => b.close);

  const series = [];

  for (
    let i = Math.max(
      14,
      closes.length - 40
    );
    i < closes.length;
    i++
  ) {
    series.push({
      price: closes[i],
      rsi:
        rsi(
          closes.slice(0, i + 1),
          14
        )
    });
  }

  if (series.length < 16) {
    return {
      vote: 'NEUTRAL',
      context: 0,
      reason:
        'داده کافی برای واگرایی نیست'
    };
  }

  const half =
    Math.floor(series.length / 2);

  const first =
    series.slice(0, half);

  const second =
    series.slice(half);

  const firstMax =
    first.reduce((a, b) =>
      b.price > a.price ? b : a
    );

  const secondMax =
    second.reduce((a, b) =>
      b.price > a.price ? b : a
    );

  const firstMin =
    first.reduce((a, b) =>
      b.price < a.price ? b : a
    );

  const secondMin =
    second.reduce((a, b) =>
      b.price < a.price ? b : a
    );

  if (
    secondMax.price > firstMax.price &&
    secondMax.rsi < firstMax.rsi
  ) {
    return {
      vote: 'SELL',
      context: -1,
      reason:
        'واگرایی نزولی قیمت و RSI'
    };
  }

  if (
    secondMin.price < firstMin.price &&
    secondMin.rsi > firstMin.rsi
  ) {
    return {
      vote: 'BUY',
      context: 1,
      reason:
        'واگرایی صعودی قیمت و RSI'
    };
  }

  return {
    vote: 'NEUTRAL',
    context: 0,
    reason:
      'واگرایی مشخصی دیده نمی‌شود'
  };
}

function analyze(b) {
  const last =
    b[b.length - 1];

  const m =
    momentum(b);

  const a =
    atr(b);

  const sr =
    range(b);

  const pv =
    pivots(b);

  const vol =
    volumeState(b);

  return {
    price:
      last.close,

    ema20:
      m.ema20,

    ema50:
      m.ema50,

    rsi:
      m.rsi,

    atr:
      a,

    structure:
      structure(b),

    sweep:
      sweepSignal(b),

    range:
      sr,

    pivots:
      pv,

    volume:
      last.volume,

    volumeState:
      vol,

    bars:
      b
  };
}

function normalizeBars(values) {
  return (values || [])
    .map(v => ({
      time:
        new Date(v.datetime).getTime(),

      open:
        +v.open,

      high:
        +v.high,

      low:
        +v.low,

      close:
        +v.close,

      volume:
        v.volume ? +v.volume : 0
    }))
    .filter(v =>
      Number.isFinite(v.time) &&
      Number.isFinite(v.open) &&
      Number.isFinite(v.high) &&
      Number.isFinite(v.low) &&
      Number.isFinite(v.close)
    );
}

async function fetchTF(
  tf,
  limit = 220
) {
  const key =
    process.env.TWELVEDATA_API_KEY;

  if (!key) return null;

  const safeLimit =
    Math.max(
      1,
      Math.min(
        Number(limit) || 220,
        5000
      )
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

  const result =
    await fetchJson(
      `engine-ohlc:${SYMBOL}:${tf}:${safeLimit}`,
      url,
      ttlByTf[tf] || 300000
    );

  const d =
    result.data;

  if (
    !d ||
    d.status === 'error' ||
    !Array.isArray(d.values) ||
    !d.values.length
  ) {
    return null;
  }

  return normalizeBars(d.values)
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

function formatEndDate(timestamp) {
  const d =
    new Date(timestamp);

  if (!Number.isFinite(d.getTime())) {
    return null;
  }

  const pad =
    n =>
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

function getNextEndDate(oldestTime) {
  if (!Number.isFinite(oldestTime)) {
    return null;
  }

  return formatEndDate(
    oldestTime - 1000
  );
}

async function fetchTFHistory(
  tf,
  totalBars
) {
  const key =
    process.env.TWELVEDATA_API_KEY;

  if (!key) return null;

  const wanted =
    Math.max(
      220,
      Math.min(
        Number(totalBars) || 220,
        HISTORY_MAX_BARS
      )
    );

  if (wanted <= HISTORY_CHUNK) {
    const bars =
      await fetchTF(
        tf,
        wanted
      );

    if (bars) {
      Object.defineProperty(
        bars,
        'historyMeta',
        {
          value: {
            requested: wanted,
            fetched: bars.length,
            unique: bars.length,
            pages: 1,
            complete:
              bars.length >= wanted,
            duplicatePages: 0,
            stoppedReason:
              bars.length >= wanted
                ? 'target-reached'
                : 'provider-returned-less-data',
            firstTime:
              bars[0]?.time || null,
            lastTime:
              bars[bars.length - 1]?.time || null
          },
          enumerable: false
        }
      );
    }

    return bars;
  }

  const all = [];

  let endDate = null;
  let page = 0;
  let duplicatePages = 0;

  let stoppedReason =
    'unknown';

  let previousOldest =
    null;

  const intervalMs = {
    '15M': 15 * 60 * 1000,
    '1H': 60 * 60 * 1000,
    '4H': 4 * 60 * 60 * 1000,
    'Daily': 24 * 60 * 60 * 1000
  }[tf] || 60 * 60 * 1000;

  const maxPages =
    Math.ceil(
      wanted / HISTORY_CHUNK
    ) + 8;

  while (
    all.length < wanted &&
    page < maxPages
  ) {
    page++;

    let url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=${encodeURIComponent(SYMBOL)}` +
      `&interval=${TF[tf]}` +
      `&outputsize=${HISTORY_CHUNK}` +
      `&apikey=${key}`;

    if (endDate) {
      url +=
        `&end_date=${encodeURIComponent(endDate)}`;
    }

    const result =
      await fetchJson(
        `engine-history:${SYMBOL}:${tf}:${HISTORY_CHUNK}:${endDate || 'latest'}`,
        url,
        3600000
      );

    const d =
      result.data;

    if (
      !d ||
      d.status === 'error' ||
      !Array.isArray(d.values) ||
      !d.values.length
    ) {
      stoppedReason =
        'provider-no-data';
      break;
    }

    const bars =
      normalizeBars(d.values)
        .sort(
          (a, b) =>
            a.time - b.time
        );

    if (!bars.length) {
      stoppedReason =
        'empty-page';
      break;
    }

    const pageOldest =
      bars[0].time;

    if (
      previousOldest !== null &&
      pageOldest >= previousOldest
    ) {
      duplicatePages++;

      const fallbackEnd =
        formatEndDate(
          pageOldest -
          intervalMs
        );

      if (
        fallbackEnd &&
        fallbackEnd !== endDate
      ) {
        endDate =
          fallbackEnd;
        continue;
      }

      stoppedReason =
        'duplicate-page';
      break;
    }

    previousOldest =
      pageOldest;

    const known =
      new Set(
        all.map(
          b => b.time
        )
      );

    const unique =
      bars.filter(
        b =>
          !known.has(b.time)
      );

    if (!unique.length) {
      duplicatePages++;

      const fallbackEnd =
        formatEndDate(
          pageOldest -
          intervalMs
        );

      if (
        fallbackEnd &&
        fallbackEnd !== endDate
      ) {
        endDate =
          fallbackEnd;
        continue;
      }

      stoppedReason =
        'no-new-unique-bars';
      break;
    }

    all.unshift(...unique);

    if (
      all.length >= wanted
    ) {
      stoppedReason =
        'target-reached';
      break;
    }

    if (
      bars.length < HISTORY_CHUNK
    ) {
      stoppedReason =
        'provider-history-exhausted';
      break;
    }

    const nextEnd =
      getNextEndDate(
        pageOldest
      );

    if (!nextEnd) {
      stoppedReason =
        'invalid-pagination-date';
      break;
    }

    if (
      nextEnd === endDate
    ) {
      stoppedReason =
        'pagination-date-not-advancing';
      break;
    }

    endDate =
      nextEnd;
  }

  const finalMap =
    new Map();

  all.forEach(
    b => {
      if (
        !finalMap.has(b.time)
      ) {
        finalMap.set(
          b.time,
          b
        );
      }
    }
  );

  const finalBars =
    Array.from(
      finalMap.values()
    )
      .sort(
        (a, b) =>
          a.time - b.time
      )
      .slice(-wanted);

  Object.defineProperty(
    finalBars,
    'historyMeta',
    {
      value: {
        requested:
          wanted,

        fetched:
          all.length,

        unique:
          finalBars.length,

        pages:
          page,

        duplicatePages,

        complete:
          finalBars.length >= wanted,

        stoppedReason,

        firstTime:
          finalBars[0]?.time || null,

        lastTime:
          finalBars[
            finalBars.length - 1
          ]?.time || null
      },

      enumerable: false
    }
  );

  return finalBars;
}

function getHistoryMeta(bars) {
  return bars?.historyMeta || null;
}

async function fetchFundamental() {
  const key =
    process.env.FRED_API_KEY;

  if (!key) {
    return {
      available: false,
      bias: 'NEUTRAL',
      score: 50,
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
                return [name, null];
              }

              const data =
                await r.json();

              const o =
                (data.observations || [])
                  .filter(
                    x =>
                      x.value !== '.'
                  );

              return [name, o];
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
          ? 'تورم رو به افزایش'
          : 'تورم رو به کاهش'
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
      score: 50,
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
        process.env.NEWS_BLOCK_MINUTES || 30
      ) * 60000;

    const words =
      /fed|fomc|cpi|pce|nfp|nonfarm|payroll|interest rate|rate decision|powell|inflation|jobs report/i;

    const recent =
      (Array.isArray(data)
        ? data
        : [])
        .filter(a => {

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

function trendBias(x) {
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

function getMarketRegime(d) {
  const h4 =
    trendBias(d.h4);

  const daily =
    trendBias(d.daily);

  const h1 =
    trendBias(d.h1);

  const h4Range =
    Number(d.h4.range.high) -
    Number(d.h4.range.low);

  const h4Atr =
    Number(d.h4.atr || 0);

  const rangeCompression =
    h4Atr > 0 &&
    h4Range > 0
      ? h4Range / h4Atr
      : 0;

  if (
    h4 === 1 &&
    daily === 1
  ) {
    return {
      regime: 'TREND',
      direction: 'BUY',
      strength:
        h1 === 1 ? 'STRONG' : 'NORMAL',
      reason:
        '4H و Daily در روند صعودی هم‌جهت هستند'
    };
  }

  if (
    h4 === -1 &&
    daily === -1
  ) {
    return {
      regime: 'TREND',
      direction: 'SELL',
      strength:
        h1 === -1 ? 'STRONG' : 'NORMAL',
      reason:
        '4H و Daily در روند نزولی هم‌جهت هستند'
    };
  }

  const m15Range =
    Number(d.m15.range.high) -
    Number(d.m15.range.low);

  const m15Atr =
    Number(d.m15.atr || 0);

  const price =
    Number(d.m15.price);

  const mid =
    Number(d.m15.range.mid);

  const nearMid =
    m15Range > 0 &&
    m15Atr > 0 &&
    Math.abs(price - mid) <
      m15Range * 0.18;

  if (
    m15Range > 0 &&
    m15Atr > 0 &&
    m15Range / m15Atr >= 3 &&
    nearMid &&
    h4 === 0 &&
    daily === 0
  ) {
    return {
      regime: 'RANGE',
      direction: 'NEUTRAL',
      strength: 'NORMAL',
      reason:
        'بازار فشرده و بدون جهت غالب است'
    };
  }

  return {
    regime: 'TRANSITION',
    direction:
      h4 !== 0
        ? h4 === 1
          ? 'BUY'
          : 'SELL'
        : 'NEUTRAL',
    strength: 'WEAK',
    reason:
      'بازار بین روند و رنج در حال انتقال است'
  };
}

function runStrategies(d, fund) {
  const strategies = [];

  const regime =
    getMarketRegime(d);

  const h4 =
    trendBias(d.h4);

  const d1 =
    trendBias(d.daily);

  const h1 =
    trendBias(d.h1);

  let trendVote =
    'NEUTRAL';

  let trendReason =
    'تایم‌فریم‌های بالا هم‌جهت نیستند';

  if (
    h4 === 1 &&
    d1 === 1
  ) {
    trendVote = 'BUY';

    trendReason =
      'هم‌جهتی 4H و Daily صعودی' +
      (
        h1 === 1
          ? ' + تأیید 1H'
          : ''
      );
  }

  else if (
    h4 === -1 &&
    d1 === -1
  ) {
    trendVote = 'SELL';

    trendReason =
      'هم‌جهتی 4H و Daily نزولی' +
      (
        h1 === -1
          ? ' + تأیید 1H'
          : ''
      );
  }

  /*
   * Trend
   */
  strategies.push({
    name:
      'روند چندتایم‌فریمی',

    vote:
      trendVote,

    weight: 28,

    reason:
      trendReason
  });

  /*
   * Structure
   */
  const structureVote =
    d.m15.structure ===
      'BULLISH_BOS'
      ? 'BUY'
      : d.m15.structure ===
        'BEARISH_BOS'
          ? 'SELL'
          : 'NEUTRAL';

  strategies.push({
    name:
      'ساختار بازار (BOS/CHoCH)',

    vote:
      structureVote,

    weight: 18,

    reason:
      structureVote === 'BUY'
        ? 'شکست ساختار صعودی در 15M'
        : structureVote === 'SELL'
          ? 'شکست ساختار نزولی در 15M'
          : 'ساختار 15M نامشخص'
  });

  /*
   * Sweep
   */
  const sweepVote =
    d.m15.sweep ===
      'SWEEP_LOW'
      ? 'BUY'
      : d.m15.sweep ===
        'SWEEP_HIGH'
          ? 'SELL'
          : 'NEUTRAL';

  strategies.push({
    name:
      'Liquidity Sweep (SMC)',

    vote:
      sweepVote,

    weight: 24,

    reason:
      sweepVote === 'BUY'
        ? 'شکار نقدینگی زیر کف و بازگشت'
        : sweepVote === 'SELL'
          ? 'شکار نقدینگی بالای سقف و بازگشت'
          : 'شکار نقدینگی رخ نداده'
  });

  /*
   * Momentum
   */
  const momVote =
    d.m15.rsi > 50 &&
    d.m15.rsi < 70 &&
    d.m15.price >
      d.m15.ema20

      ? 'BUY'

      : d.m15.rsi < 50 &&
        d.m15.rsi > 30 &&
        d.m15.price <
          d.m15.ema20

        ? 'SELL'

        : 'NEUTRAL';

  strategies.push({
    name:
      'مومنتوم (RSI + EMA20)',

    vote:
      momVote,

    weight: 14,

    reason:
      momVote === 'BUY'
        ? `RSI ${fmt(d.m15.rsi)} و قیمت بالای EMA20`
        : momVote === 'SELL'
          ? `RSI ${fmt(d.m15.rsi)} و قیمت زیر EMA20`
          : 'مومنتوم خنثی یا افراطی'
  });

  /*
   * Fibonacci = context only
   */
  const fib =
    fibZone(d);

  /*
   * Divergence = context only
   */
  const div =
    divergence(
      d.m15.bars
    );

  /*
   * Fundamental
   */
  const fundVote =
    fund.bias === 'BULLISH'
      ? 'BUY'
      : fund.bias === 'BEARISH'
        ? 'SELL'
        : 'NEUTRAL';

  strategies.push({
    name:
      'فاندامنتال (FRED)',

    vote:
      fundVote,

    weight: 10,

    reason:
      fund.items?.length
        ? fund.items
            .map(i => i.why)
            .join('، ')
        : 'فاندامنتال خنثی/داده ناکافی'
  });

  /*
   * Early trigger:
   * Sweep + structure + momentum can trigger
   * without waiting for all higher-timeframe
   * strategies.
   */
  const earlyBuy =
    sweepVote === 'BUY' &&
    (
      structureVote === 'BUY' ||
      momVote === 'BUY'
    ) &&
    d.m15.price >
      d.m15.ema20 &&
    d.m15.rsi > 50;

  const earlySell =
    sweepVote === 'SELL' &&
    (
      structureVote === 'SELL' ||
      momVote === 'SELL'
    ) &&
    d.m15.price <
      d.m15.ema20 &&
    d.m15.rsi < 50;

  return {
    strategies,

    context: {
      fib,
      divergence: div
    },

    regime,

    earlyTrigger: {
      buy: earlyBuy,
      sell: earlySell
    },

    volumeConfirmed:
      d.m15.volumeState.confirmed
  };
}

function computeConsensus(
  strategies,
  volumeConfirmed,
  earlyTrigger
) {
  let buyWeight = 0;
  let sellWeight = 0;

  let buyCount = 0;
  let sellCount = 0;
  let neutralCount = 0;

  strategies.forEach(s => {
    if (s.vote === 'BUY') {
      buyWeight += s.weight;
      buyCount++;
    }

    else if (
      s.vote === 'SELL'
    ) {
      sellWeight += s.weight;
      sellCount++;
    }

    else {
      neutralCount++;
    }
  });

  const totalWeight =
    strategies.reduce(
      (a, s) =>
        a + s.weight,
      0
    );

  let dir =
    buyWeight > sellWeight
      ? 'BUY'
      : sellWeight > buyWeight
        ? 'SELL'
        : 'WAIT';

  let triggerType =
    'CONSENSUS';

  /*
   * Early trigger is only allowed when
   * the directional vote is not strongly opposite.
   */
  if (
    earlyTrigger?.buy &&
    buyWeight >= sellWeight - 12
  ) {
    dir = 'BUY';
    triggerType =
      'EARLY_SWEEP_STRUCTURE';
  }

  if (
    earlyTrigger?.sell &&
    sellWeight >= buyWeight - 12
  ) {
    dir = 'SELL';
    triggerType =
      'EARLY_SWEEP_STRUCTURE';
  }

  const netWeight =
    Math.abs(
      buyWeight -
      sellWeight
    );

  let confidence =
    50 +
    (
      netWeight /
      totalWeight
    ) * 45;

  if (
    triggerType ===
    'EARLY_SWEEP_STRUCTURE'
  ) {
    confidence += 3;
  }

  if (
    volumeConfirmed &&
    dir !== 'WAIT'
  ) {
    confidence += 2;
  }

  confidence =
    clamp(
      confidence,
      0,
      96
    );

  const agreeCount =
    dir === 'BUY'
      ? buyCount
      : dir === 'SELL'
        ? sellCount
        : Math.max(
            buyCount,
            sellCount
          );

  return {
    dir,

    triggerType,

    buyWeight:
      fmt(buyWeight),

    sellWeight:
      fmt(sellWeight),

    totalWeight:
      fmt(totalWeight),

    confidence:
      fmt(confidence),

    agreeCount,

    totalCount:
      strategies.length,

    neutralCount,

    volumeConfirmed
  };
}

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
    .filter(Number.isFinite);

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

function buildTrade(
  d,
  dir
) {
  const p =
    Number(d.m15.price);

  const a =
    Number(d.m15.atr || 2);

  const levels =
    nearestLevels(
      p,
      dir,
      d
    );

  const entryOffset =
    Math.min(
      a * 0.15,
      MAX_SPREAD_PROXY_ATR * a
    );

  let sl;
  let tp1;
  let tp2;
  let tp3;
  let entryLow;
  let entryHigh;
  let trigger;
  let stopReason;

  if (
    dir === 'BUY'
  ) {
    entryLow =
      p -
      entryOffset;

    entryHigh =
      p +
      entryOffset;

    const recentSwing =
      Number(
        d.m15.range.low
      );

    const baselineRisk =
      Math.max(
        MIN_STOP_USD,
        a * 1.05
      );

    let structuralRisk =
      Number.isFinite(recentSwing)
        ? p -
          (
            recentSwing -
            a * 0.15
          )
        : baselineRisk;

    if (
      !Number.isFinite(structuralRisk) ||
      structuralRisk <= 0
    ) {
      structuralRisk =
        baselineRisk;
    }

    const risk =
      clamp(
        Math.max(
          baselineRisk,
          structuralRisk
        ),
        MIN_STOP_USD,
        a * 2.5
      );

    sl =
      p -
      risk;

    stopReason =
      structuralRisk > a * 2.5
        ? 'structural-stop-too-wide'
        : 'structure-plus-atr';

    const riskDist =
      p - sl;

    const rTarget =
      p +
      riskDist * MIN_RR;

    if (
      levels.nextResistance &&
      levels.nextResistance >
        p
    ) {
      const space =
        levels.nextResistance -
        p;

      tp1 =
        space >=
        riskDist * MIN_RR
          ? Math.min(
              levels.nextResistance,
              rTarget
            )
          : rTarget;
    }

    else {
      tp1 =
        rTarget;
    }

    tp2 =
      p +
      riskDist * 2.4;

    tp3 =
      p +
      riskDist * 3.2;

    trigger =
      d.m15.sweep ===
      'SWEEP_LOW'
        ? 'Sweep Low + reclaim + ساختار صعودی + EMA20 + RSI>50'
        : 'ساختار صعودی + EMA20 + RSI>50';
  }

  else {
    entryLow =
      p -
      entryOffset;

    entryHigh =
      p +
      entryOffset;

    const recentSwing =
      Number(
        d.m15.range.high
      );

    const baselineRisk =
      Math.max(
        MIN_STOP_USD,
        a * 1.05
      );

    let structuralRisk =
      Number.isFinite(recentSwing)
        ? (
            recentSwing +
            a * 0.15
          ) - p
        : baselineRisk;

    if (
      !Number.isFinite(structuralRisk) ||
      structuralRisk <= 0
    ) {
      structuralRisk =
        baselineRisk;
    }

    const risk =
      clamp(
        Math.max(
          baselineRisk,
          structuralRisk
        ),
        MIN_STOP_USD,
        a * 2.5
      );

    sl =
      p +
      risk;

    stopReason =
      structuralRisk > a * 2.5
        ? 'structural-stop-too-wide'
        : 'structure-plus-atr';

    const riskDist =
      sl - p;

    const rTarget =
      p -
      riskDist * MIN_RR;

    if (
      levels.nextSupport &&
      levels.nextSupport <
        p
    ) {
      const space =
        p -
        levels.nextSupport;

      tp1 =
        space >=
        riskDist * MIN_RR
          ? Math.max(
              levels.nextSupport,
              rTarget
            )
          : rTarget;
    }

    else {
      tp1 =
        rTarget;
    }

    tp2 =
      p -
      riskDist * 2.4;

    tp3 =
      p -
      riskDist * 3.2;

    trigger =
      d.m15.sweep ===
      'SWEEP_HIGH'
        ? 'Sweep High + reclaim + ساختار نزولی + EMA20 + RSI<50'
        : 'ساختار نزولی + EMA20 + RSI<50';
  }

  const riskDist =
    Math.abs(
      p - sl
    );

  const rr =
    riskDist > 0
      ? Math.abs(
          tp1 - p
        ) / riskDist
      : 0;

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

    riskDistance:
      fmt(riskDist),

    atrMultiple:
      a > 0
        ? fmt(
            riskDist / a
          )
        : null,

    stopReason,

    trigger,

    levels
  };
}

function getSession(time) {
  const d =
    new Date(time);

  const hour =
    d.getUTCHours();

  if (
    hour >= 0 &&
    hour < 8
  ) {
    return 'ASIA';
  }

  if (
    hour >= 8 &&
    hour < 13
  ) {
    return 'LONDON';
  }

  if (
    hour >= 13 &&
    hour < 17
  ) {
    return 'NEW_YORK';
  }

  return 'NEW_YORK_LATE';
}

function scoreSignalQuality(
  d,
  consensus,
  trade,
  dir,
  signalTime,
  context = {},
  regime = null
) {
  let score = 50;

  const reasons = [];
  const blockers = [];

  const marketRegime =
    regime ||
    getMarketRegime(d);

  /*
   * 1. Consensus
   */
  if (
    consensus.agreeCount >= 4
  ) {
    score += 7;

    reasons.push(
      'اجماع مناسب'
    );
  }

  else if (
    consensus.agreeCount >= 3
  ) {
    score += 3;

    reasons.push(
      'اجماع متوسط'
    );
  }

  else {
    score -= 7;

    blockers.push(
      'تعداد استراتژی‌های هم‌جهت کم است'
    );
  }

  /*
   * 2. Weighted edge
   */
  const weightGap =
    Math.abs(
      Number(
        consensus.buyWeight || 0
      ) -
      Number(
        consensus.sellWeight || 0
      )
    );

  if (
    weightGap >= 35
  ) {
    score += 8;

    reasons.push(
      'برتری وزنی قوی'
    );
  }

  else if (
    weightGap >= 22
  ) {
    score += 5;
  }

  else if (
    weightGap >= 12
  ) {
    score += 2;
  }

  else {
    score -= 5;

    blockers.push(
      'برتری وزنی کافی نیست'
    );
  }

  /*
   * 3. R:R
   */
  const rr =
    Number(
      trade?.rr || 0
    );

  if (
    rr >= 2.5
  ) {
    score += 9;

    reasons.push(
      'R:R بسیار مناسب'
    );
  }

  else if (
    rr >= 2.1
  ) {
    score += 7;

    reasons.push(
      'R:R مناسب'
    );
  }

  else if (
    rr >= MIN_RR
  ) {
    score += 2;
  }

  else {
    score -= 15;

    blockers.push(
      `R:R کمتر از ${MIN_RR}`
    );
  }

  /*
   * 4. Regime
   */
  if (
    marketRegime.regime ===
    'TREND'
  ) {
    if (
      marketRegime.direction ===
      dir
    ) {
      score += 8;

      reasons.push(
        'رژیم روند هم‌جهت با سیگنال'
      );
    }
    else {
      score -= 7;

      blockers.push(
        'جهت سیگنال خلاف روند غالب است'
      );
    }
  }

  else if (
    marketRegime.regime ===
    'RANGE'
  ) {
    /*
     * در Range فقط وقتی اجازه می‌دهیم
     * که Sweep وجود داشته باشد.
     */
    const validRangeTrigger =
      (
        dir === 'BUY' &&
        d.m15.sweep === 'SWEEP_LOW'
      ) ||
      (
        dir === 'SELL' &&
        d.m15.sweep === 'SWEEP_HIGH'
      );

    if (
      validRangeTrigger
    ) {
      score += 6;

      reasons.push(
        'Sweep مناسب در رژیم Range'
      );
    }
    else {
      score -= 6;

      blockers.push(
        'در Range بدون Sweep مناسب'
      );
    }
  }

  else {
    score += 1;

    reasons.push(
      'بازار در Transition'
    );
  }

  /*
   * 5. Higher timeframe
   */
  const h4Bull =
    d.h4.price >
    d.h4.ema20;

  const h4Bear =
    d.h4.price <
    d.h4.ema20;

  const dBull =
    d.daily.price >
    d.daily.ema20;

  const dBear =
    d.daily.price <
    d.daily.ema20;

  if (
    dir === 'BUY' &&
    h4Bull &&
    dBull
  ) {
    score += 8;

    reasons.push(
      '4H و Daily صعودی'
    );
  }

  else if (
    dir === 'SELL' &&
    h4Bear &&
    dBear
  ) {
    score += 8;

    reasons.push(
      '4H و Daily نزولی'
    );
  }

  else if (
    dir === 'BUY' &&
    (h4Bull || dBull)
  ) {
    score += 3;
  }

  else if (
    dir === 'SELL' &&
    (h4Bear || dBear)
  ) {
    score += 3;
  }

  else {
    score -= 5;

    blockers.push(
      'تایم‌فریم‌های بالاتر تأیید کافی نمی‌کنند'
    );
  }

  /*
   * 6. Structure
   */
  const structureBuy =
    d.m15.structure ===
    'BULLISH_BOS';

  const structureSell =
    d.m15.structure ===
    'BEARISH_BOS';

  if (
    dir === 'BUY' &&
    structureBuy
  ) {
    score += 8;

    reasons.push(
      'BOS صعودی 15M'
    );
  }

  else if (
    dir === 'SELL' &&
    structureSell
  ) {
    score += 8;

    reasons.push(
      'BOS نزولی 15M'
    );
  }

  else if (
    (
      dir === 'BUY' &&
      d.m15.sweep === 'SWEEP_LOW'
    ) ||
    (
      dir === 'SELL' &&
      d.m15.sweep === 'SWEEP_HIGH'
    )
  ) {
    score += 3;

    reasons.push(
      'Sweep جایگزین تأیید ساختار'
    );
  }

  else {
    score -= 4;
  }

  /*
   * 7. Momentum
   */
  const rsiValue =
    Number(
      d.m15.rsi || 50
    );

  const price =
    Number(
      d.m15.price
    );

  const ema20 =
    Number(
      d.m15.ema20
    );

  if (
    dir === 'BUY'
  ) {
    if (
      rsiValue >= 50 &&
      rsiValue < 68 &&
      price > ema20
    ) {
      score += 8;

      reasons.push(
        'مومنتوم صعودی سالم'
      );
    }

    else if (
      rsiValue >= 68 &&
      rsiValue < 75
    ) {
      score -= 2;

      reasons.push(
        'RSI بالا؛ ورود با احتیاط'
      );
    }

    else if (
      rsiValue >= 75
    ) {
      score -= 7;

      blockers.push(
        'RSI در اشباع خرید'
      );
    }

    else {
      score -= 4;
    }
  }

  if (
    dir === 'SELL'
  ) {
    if (
      rsiValue <= 50 &&
      rsiValue > 32 &&
      price < ema20
    ) {
      score += 8;

      reasons.push(
        'مومنتوم نزولی سالم'
      );
    }

    else if (
      rsiValue <= 32 &&
      rsiValue > 25
    ) {
      score -= 2;

      reasons.push(
        'RSI پایین؛ ورود با احتیاط'
      );
    }

    else if (
      rsiValue <= 25
    ) {
      score -= 7;

      blockers.push(
        'RSI در اشباع فروش'
      );
    }

    else {
      score -= 4;
    }
  }

  /*
   * 8. Sweep
   */
  const sweepMatch =
    (
      dir === 'BUY' &&
      d.m15.sweep ===
        'SWEEP_LOW'
    ) ||
    (
      dir === 'SELL' &&
      d.m15.sweep ===
        'SWEEP_HIGH'
    );

  if (
    sweepMatch
  ) {
    score += 10;

    reasons.push(
      'Liquidity Sweep تأییدکننده'
    );
  }

  /*
   * 9. Fib context
   */
  const fib =
    context.fib;

  if (
    fib &&
    fib.vote === dir
  ) {
    score += 3;

    reasons.push(
      'Fibonacci با جهت سیگنال هم‌جهت است'
    );
  }

  else if (
    fib &&
    fib.vote !== 'NEUTRAL' &&
    fib.vote !== dir
  ) {
    score -= 3;

    reasons.push(
      'Fibonacci خلاف جهت سیگنال است'
    );
  }

  /*
   * 10. Divergence context
   */
  const div =
    context.divergence;

  if (
    div &&
    div.vote === dir
  ) {
    score += 4;

    reasons.push(
      'واگرایی با جهت سیگنال هم‌جهت است'
    );
  }

  else if (
    div &&
    div.vote !== 'NEUTRAL' &&
    div.vote !== dir
  ) {
    score -= 5;

    reasons.push(
      'واگرایی خلاف جهت سیگنال'
    );
  }

  /*
   * 11. Volume
   */
  if (
    d.m15.volumeState &&
    d.m15.volumeState.confirmed
  ) {
    score += 3;

    reasons.push(
      'حجم تأییدکننده'
    );
  }

  /*
   * 12. SL / ATR
   */
  const atrValue =
    Number(
      d.m15.atr || 0
    );

  if (
    atrValue > 0 &&
    trade?.stopLoss != null
  ) {
    const stopDistance =
      Math.abs(
        price -
        Number(
          trade.stopLoss
        )
      );

    const atrRatio =
      stopDistance /
      atrValue;

    if (
      atrRatio >= 0.85 &&
      atrRatio <= 2.5
    ) {
      score += 5;

      reasons.push(
        'فاصله حد ضرر منطقی'
      );
    }

    else if (
      atrRatio < 0.65
    ) {
      score -= 8;

      blockers.push(
        'حد ضرر بیش از حد نزدیک است'
      );
    }

    else if (
      atrRatio > 2.8
    ) {
      score -= 5;

      blockers.push(
        'حد ضرر بیش از حد بزرگ است'
      );
    }
  }

  /*
   * 13. Location / S&R
   */
  const resistance =
    Number(
      trade?.levels?.nextResistance ||
      d.m15.range.high
    );

  const support =
    Number(
      trade?.levels?.nextSupport ||
      d.m15.range.low
    );

  const riskDist =
    Number(
      trade?.riskDistance || 0
    );

  if (
    atrValue > 0 &&
    riskDist > 0
  ) {
    if (
      dir === 'BUY' &&
      Number.isFinite(resistance)
    ) {
      const distance =
        resistance -
        price;

      if (
        distance <
        riskDist * 1.15
      ) {
        score -= 8;

        blockers.push(
          'BUY بیش از حد نزدیک مقاومت است'
        );
      }

      else if (
        distance >
        riskDist * 2
      ) {
        score += 4;

        reasons.push(
          'فضای مناسب تا مقاومت'
        );
      }
    }

    if (
      dir === 'SELL' &&
      Number.isFinite(support)
    ) {
      const distance =
        price -
        support;

      if (
        distance <
        riskDist * 1.15
      ) {
        score -= 8;

        blockers.push(
          'SELL بیش از حد نزدیک حمایت است'
        );
      }

      else if (
        distance >
        riskDist * 2
      ) {
        score += 4;

        reasons.push(
          'فضای مناسب تا حمایت'
        );
      }
    }
  }

  /*
   * 14. Entry distance
   */
  const entryMid =
    trade?.entry
      ? (
          Number(trade.entry.low) +
          Number(trade.entry.high)
        ) / 2
      : price;

  const entryDistance =
    atrValue > 0
      ? Math.abs(
          entryMid - price
        ) / atrValue
      : 0;

  if (
    entryDistance >
    MAX_SPREAD_PROXY_ATR
  ) {
    score -= 5;

    blockers.push(
      'فاصله ورود از قیمت فعلی زیاد است'
    );
  }

  /*
   * 15. Session — soft filter
   */
  const session =
    getSession(
      signalTime
    );

  if (
    session === 'ASIA'
  ) {
    score += 1;
  }

  else if (
    session === 'LONDON'
  ) {
    score -= 1;
  }

  else if (
    session === 'NEW_YORK'
  ) {
    score -= 2;
  }

  else if (
    session === 'NEW_YORK_LATE'
  ) {
    score += 1;
  }

  /*
   * 16. Final extreme RSI
   */
  if (
    rsiValue >= 80 ||
    rsiValue <= 20
  ) {
    blockers.push(
      'RSI بسیار افراطی است'
    );
  }

  score =
    clamp(score);

  let grade =
    'POOR';

  if (
    score >= 85
  ) {
    grade =
      'EXCELLENT';
  }

  else if (
    score >= 75
  ) {
    grade =
      'GOOD';
  }

  else if (
    score >= 65
  ) {
    grade =
      'FAIR';
  }

  const uniqueBlockers =
    [...new Set(blockers)];

  const tradable =
    score >=
      MIN_QUALITY_SCORE &&
    uniqueBlockers.length === 0;

  return {
    score:
      fmt(score),

    grade,

    session,

    regime:
      marketRegime.regime,

    tradable,

    blockers:
      uniqueBlockers,

    reasons
  };
}

function decide(
  d,
  fund,
  news
) {
  const {
    strategies,
    volumeConfirmed,
    context,
    regime,
    earlyTrigger
  } =
    runStrategies(
      d,
      fund
    );

  const consensus =
    computeConsensus(
      strategies,
      volumeConfirmed,
      earlyTrigger
    );

  const dir =
    consensus.dir;

  const tradeDir =
    dir === 'WAIT'
      ? (
          consensus.buyWeight >=
          consensus.sellWeight
            ? 'BUY'
            : 'SELL'
        )
      : dir;

  const trade =
    buildTrade(
      d,
      tradeDir
    );

  if (
    dir === 'WAIT'
  ) {
    trade.isHypothetical =
      true;
  }

  /*
   * BASE BLOCKERS
   *
   * These are intentionally independent
   * from Quality Engine.
   */
  const baseBlockers = [];

  /*
   * Minimum consensus.
   *
   * Early trigger gets a softer path.
   */
  if (
    consensus.triggerType !==
    'EARLY_SWEEP_STRUCTURE'
  ) {
    if (
      consensus.agreeCount <
      Math.ceil(
        consensus.totalCount / 2
      )
    ) {
      baseBlockers.push(
        `اجماع کافی نیست (${consensus.agreeCount}/${consensus.totalCount})`
      );
    }
  }

  /*
   * Very extreme momentum
   */
  if (
    d.m15.rsi >= 78 ||
    d.m15.rsi <= 22
  ) {
    baseBlockers.push(
      'Momentum در ناحیه بسیار افراطی است'
    );
  }

  /*
   * News
   */
  if (
    news &&
    news.blocked
  ) {
    baseBlockers.push(
      'خبر پرریسک در پنجره زمانی نزدیک'
    );
  }

  /*
   * R:R
   */
  if (
    trade &&
    trade.rr < MIN_RR
  ) {
    baseBlockers.push(
      `R:R کمتر از ${MIN_RR}`
    );
  }

  /*
   * Hard HTF conflict
   */
  if (
    dir === 'BUY' &&
    d.h4.price <
      d.h4.ema20 &&
    d.daily.price <
      d.daily.ema20
  ) {
    baseBlockers.push(
      '4H و Daily هر دو خلاف BUY هستند'
    );
  }

  if (
    dir === 'SELL' &&
    d.h4.price >
      d.h4.ema20 &&
    d.daily.price >
      d.daily.ema20
  ) {
    baseBlockers.push(
      '4H و Daily هر دو خلاف SELL هستند'
    );
  }

  /*
   * Structural stop too wide
   */
  if (
    trade.stopReason ===
    'structural-stop-too-wide'
  ) {
    baseBlockers.push(
      'حد ضرر ساختاری بیش از حد بزرگ است'
    );
  }

  /*
   * Strategy diagnostic
   */
  const strategyVotes =
    Object.fromEntries(
      strategies.map(
        s => [
          s.name,
          s.vote
        ]
      )
    );

  const strategyKey =
    strategies
      .map(
        s => s.vote
      )
      .join('|');

  /*
   * BASE DECISION
   *
   * No quality filter here.
   */
  const baseActive =
    dir !== 'WAIT' &&
    consensus.confidence >=
      MIN_CONFIDENCE &&
    baseBlockers.length === 0;

  /*
   * QUALITY
   */
  const quality =
    scoreSignalQuality(
      d,
      consensus,
      trade,
      tradeDir,
      d.m15.bars?.[
        d.m15.bars.length - 1
      ]?.time ||
      Date.now(),
      context,
      regime
    );

  const qualityBlockers =
    quality.blockers || [];

  const finalBlockers =
    [
      ...new Set([
        ...baseBlockers,
        ...qualityBlockers
      ])
    ];

  /*
   * QUALITY DECISION
   */
  const qualityActive =
    baseActive &&
    quality.tradable;

  /*
   * IMPORTANT:
   *
   * decision = Quality-filtered live decision
   * baseDecision = Base motor without quality
   *
   * This allows backtest.js to compare
   * Base vs Quality correctly.
   */
  return {
    decision:
      qualityActive
        ? dir
        : 'WAIT',

    baseDecision:
      baseActive
        ? dir
        : 'WAIT',

    qualityDecision:
      qualityActive
        ? dir
        : 'WAIT',

    direction:
      dir,

    confidence:
      consensus.confidence,

    scores: {
      buy:
        consensus.buyWeight,

      sell:
        consensus.sellWeight
    },

    consensus: {
      agreeCount:
        consensus.agreeCount,

      totalCount:
        consensus.totalCount,

      neutralCount:
        consensus.neutralCount,

      volumeConfirmed,

      triggerType:
        consensus.triggerType
    },

    marketRegime:
      regime,

    earlyTrigger,

    context: {
      fibonacci:
        context.fib,

      divergence:
        context.divergence
    },

    strategies,

    strategyVotes,

    strategyKey,

    trade,

    /*
     * Keep both blocker levels.
     */
    baseBlockers:
      [...new Set(baseBlockers)],

    qualityBlockers:
      [...new Set(qualityBlockers)],

    blockers:
      finalBlockers,

    quality,

    fundamental:
      fund,

    newsRisk:
      news
  };
}

module.exports = {
  SYMBOL,
  TF,

  MIN_CONFIDENCE,
  MIN_RR,
  MIN_QUALITY_SCORE,

  analyze,
  decide,

  fetchTF,
  fetchTFHistory,
  getHistoryMeta,

  fetchFundamental,
  fetchNewsRisk,

  neutralFundamental,
  neutralNewsRisk,

  getSession,
  scoreSignalQuality
};
