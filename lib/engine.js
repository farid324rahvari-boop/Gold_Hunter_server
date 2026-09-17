// Gold Hunter — Decision Engine Core
// Shared by live signal and historical backtest.

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
  Number(process.env.MIN_STOP_DISTANCE_USD || 3.0);

const clamp = (x, a = 0, b = 100) =>
  Math.max(a, Math.min(b, x));

const fmt = (x) =>
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
  if (!b || b.length < 8) return 'NONE';

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
    ratio: b[b.length - 1].volume / av,
    confirmed: b[b.length - 1].volume > av * 1.15
  };
}

function fibZone(d) {
  const piv = d.m15.pivots;

  if (!piv.highs.length || !piv.lows.length) {
    return {
      vote: 'NEUTRAL',
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
      reason: 'محدوده سوئینگ نامعتبر است'
    };
  }

  const price = d.m15.price;

  const retFromHigh =
    (swingHigh - price) / span;

  const retFromLow =
    (price - swingLow) / span;

  const inGoldenFromHigh =
    retFromHigh >= 0.382 &&
    retFromHigh <= 0.618;

  const inGoldenFromLow =
    retFromLow >= 0.382 &&
    retFromLow <= 0.618;

  if (
    price > d.m15.ema20 &&
    inGoldenFromHigh
  ) {
    return {
      vote: 'BUY',
      reason:
        `اصلاح تا ناحیه طلایی فیبوناچی (${Math.round(
          retFromHigh * 100
        )}%) در روند صعودی`
    };
  }

  if (
    price < d.m15.ema20 &&
    inGoldenFromLow
  ) {
    return {
      vote: 'SELL',
      reason:
        `اصلاح تا ناحیه طلایی فیبوناچی (${Math.round(
          retFromLow * 100
        )}%) در روند نزولی`
    };
  }

  return {
    vote: 'NEUTRAL',
    reason: 'قیمت در ناحیه کلیدی فیبوناچی قرار ندارد'
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
      reason:
        'واگرایی صعودی قیمت و RSI'
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
  return (values || []).map(v => ({
    time: new Date(v.datetime).getTime(),
    open: +v.open,
    high: +v.high,
    low: +v.low,
    close: +v.close,
    volume: v.volume ? +v.volume : 0
  }));
}

async function fetchTF(tf, limit = 220) {
  const key = process.env.TWELVEDATA_API_KEY;

  if (!key) return null;

  const safeLimit =
    Math.max(
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

async function fetchTFHistory(tf, totalBars) {
  const key = process.env.TWELVEDATA_API_KEY;

  if (!key) return null;

  const wanted =
    Math.max(
      220,
      Math.min(Number(totalBars) || 220, 50000)
    );

  if (wanted <= 4500) {
    return fetchTF(tf, wanted);
  }

  const chunk = 4500;

  const ttlByTf = {
    '15M': 3600000,
    '1H': 3600000,
    '4H': 3600000,
    'Daily': 3600000
  };

  const all = [];
  let endDate = null;

  while (all.length < wanted) {
    let url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=${encodeURIComponent(SYMBOL)}` +
      `&interval=${TF[tf]}` +
      `&outputsize=${chunk}` +
      `&apikey=${key}`;

    if (endDate) {
      url +=
        `&end_date=${encodeURIComponent(endDate)}`;
    }

    const cacheKey =
      `engine-history:${SYMBOL}:${tf}:${chunk}:${endDate || 'latest'}`;

    const result =
      await fetchJson(
        cacheKey,
        url,
        ttlByTf[tf]
      );

    const d = result.data;

    if (
      !d ||
      d.status === 'error' ||
      !Array.isArray(d.values) ||
      !d.values.length
    ) {
      break;
    }

    const bars =
      normalizeBars(d.values)
        .sort((a, b) => a.time - b.time);

    if (!bars.length) break;

    const previousOldest =
      all.length ? all[0].time : Infinity;

    const unique =
      bars.filter(
        b => b.time < previousOldest
      );

    all.unshift(...unique);

    if (
      all.length >= wanted ||
      unique.length === 0
    ) {
      break;
    }

    const oldest =
      bars[0].time - 1;

    endDate =
      new Date(oldest)
        .toISOString()
        .replace('T', ' ')
        .replace('.000Z', '');

    if (bars.length < chunk) break;
  }

  return all
    .slice(-wanted)
    .sort((a, b) => a.time - b.time);
}

async function fetchFundamental() {
  const key = process.env.FRED_API_KEY;

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
        Object.entries(series).map(
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

            const d = await r.json();

            const o =
              (d.observations || [])
                .filter(
                  x => x.value !== '.'
                );

            return [name, o];
          }
        )
      );

    const vals = Object.fromEntries(out);

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

    if (vals.cpi?.length >= 2) {
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

    if (vals.coreCpi?.length >= 2) {
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

    if (vals.unemployment?.length >= 2) {
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

    if (vals.payroll?.length >= 2) {
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
      score: clamp(
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
      error: 'fundamental-fetch-failed'
    };
  }
}

async function fetchNewsRisk() {
  const key = process.env.FINNHUB_API_KEY;

  if (!key) {
    return {
      blocked: false,
      available: false,
      reason: 'news-key-not-configured'
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
        reason: 'news-provider-error'
      };
    }

    const data = await r.json();

    const now = Date.now();

    const wm =
      Number(
        process.env.NEWS_BLOCK_MINUTES || 30
      ) * 60000;

    const words =
      /fed|fomc|cpi|pce|nfp|nonfarm|payroll|interest rate|rate decision|powell|inflation|jobs report/i;

    const recent =
      (Array.isArray(data) ? data : [])
        .filter(a => {
          const ts =
            Number(a.datetime || 0) *
            1000;

          return (
            ts &&
            Math.abs(now - ts) <= wm &&
            words.test(
              `${a.headline || ''} ${a.summary || ''}`
            )
          );
        });

    return {
      blocked: recent.length > 0,
      available: true,
      reason:
        recent.length
          ? 'high-impact-news-window'
          : null,
      articles:
        recent
          .slice(0, 5)
          .map(a => ({
            headline: a.headline,
            source: a.source,
            url: a.url
          }))
    };

  } catch (e) {
    return {
      blocked: false,
      available: false,
      reason: 'news-network-error'
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
    reason: 'not-available-in-backtest'
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

function runStrategies(d, fund) {
  const strategies = [];

  const h4 = trendBias(d.h4);
  const d1 = trendBias(d.daily);
  const h1 = trendBias(d.h1);

  let trendVote = 'NEUTRAL';

  let trendReason =
    'تایم‌فریم‌های بالا هم‌جهت نیستند';

  if (h4 === 1 && d1 === 1) {
    trendVote = 'BUY';

    trendReason =
      'هم‌جهتی 4H و Daily صعودی' +
      (h1 === 1
        ? ' + تأیید 1H'
        : '');
  }

  else if (
    h4 === -1 &&
    d1 === -1
  ) {
    trendVote = 'SELL';

    trendReason =
      'هم‌جهتی 4H و Daily نزولی' +
      (h1 === -1
        ? ' + تأیید 1H'
        : '');
  }

  strategies.push({
    name: 'روند چندتایم‌فریمی',
    vote: trendVote,
    weight: 30,
    reason: trendReason
  });

  strategies.push({
    name: 'ساختار بازار (BOS/CHoCH)',

    vote:
      d.m15.structure === 'BULLISH_BOS'
        ? 'BUY'
        : d.m15.structure === 'BEARISH_BOS'
          ? 'SELL'
          : 'NEUTRAL',

    weight: 14,

    reason:
      d.m15.structure === 'BULLISH_BOS'
        ? 'شکست ساختار صعودی در 15M'
        : d.m15.structure === 'BEARISH_BOS'
          ? 'شکست ساختار نزولی در 15M'
          : 'ساختار 15M نامشخص'
  });

  strategies.push({
    name: 'Liquidity Sweep (SMC)',

    vote:
      d.m15.sweep === 'SWEEP_LOW'
        ? 'BUY'
        : d.m15.sweep === 'SWEEP_HIGH'
          ? 'SELL'
          : 'NEUTRAL',

    weight: 18,

    reason:
      d.m15.sweep === 'SWEEP_LOW'
        ? 'شکار نقدینگی زیر کف و بازگشت قیمت'
        : d.m15.sweep === 'SWEEP_HIGH'
          ? 'شکار نقدینگی بالای سقف و بازگشت قیمت'
          : 'شکار نقدینگی رخ نداده'
  });

  const momVote =
    d.m15.rsi > 50 &&
    d.m15.rsi < 72 &&
    d.m15.price > d.m15.ema20
      ? 'BUY'
      : d.m15.rsi < 50 &&
        d.m15.rsi > 28 &&
        d.m15.price < d.m15.ema20
          ? 'SELL'
          : 'NEUTRAL';

  strategies.push({
    name: 'مومنتوم (RSI + EMA20)',
    vote: momVote,
    weight: 12,

    reason:
      momVote === 'BUY'
        ? `RSI ${fmt(d.m15.rsi)} و قیمت بالای EMA20`
        : momVote === 'SELL'
          ? `RSI ${fmt(d.m15.rsi)} و قیمت زیر EMA20`
          : 'مومنتوم خنثی یا افراطی'
  });

  const fib = fibZone(d);

  strategies.push({
    name: 'Fibonacci Retracement',
    vote: fib.vote,
    weight: 10,
    reason: fib.reason
  });

  const div =
    divergence(d.m15.bars);

  strategies.push({
    name: 'واگرایی RSI',
    vote: div.vote,
    weight: 8,
    reason: div.reason
  });

  const fundVote =
    fund.bias === 'BULLISH'
      ? 'BUY'
      : fund.bias === 'BEARISH'
        ? 'SELL'
        : 'NEUTRAL';

  strategies.push({
    name: 'فاندامنتال (FRED)',
    vote: fundVote,
    weight: 8,

    reason:
      fund.items?.length
        ? fund.items
            .map(i => i.why)
            .join('، ')
        : 'فاندامنتال خنثی/داده ناکافی'
  });

  return {
    strategies,
    volumeConfirmed:
      d.m15.volumeState.confirmed
  };
}

function computeConsensus(
  strategies,
  volumeConfirmed
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

    else if (s.vote === 'SELL') {
      sellWeight += s.weight;
      sellCount++;
    }

    else {
      neutralCount++;
    }
  });

  const totalWeight =
    strategies.reduce(
      (a, s) => a + s.weight,
      0
    );

  const dir =
    buyWeight > sellWeight
      ? 'BUY'
      : sellWeight > buyWeight
        ? 'SELL'
        : 'WAIT';

  let volumeBonus = 0;

  if (
    volumeConfirmed &&
    dir !== 'WAIT'
  ) {
    volumeBonus = 5;
  }

  const netWeight =
    Math.abs(
      buyWeight - sellWeight
    );

  const confidence =
    clamp(
      50 +
      (netWeight / totalWeight) *
        100 *
        0.9 +
      volumeBonus
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
    buyWeight: fmt(buyWeight),
    sellWeight: fmt(sellWeight),
    totalWeight: fmt(totalWeight),
    confidence: fmt(confidence),
    agreeCount,
    totalCount: strategies.length,
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
          x => x > price + 0.15
        )
      )
    ]
      .sort((a, b) => a - b);

  const below =
    [
      ...new Set(
        levels.filter(
          x => x < price - 0.15
        )
      )
    ]
      .sort((a, b) => b - a);

  return {
    nextResistance:
      above[0] || null,

    nextSupport:
      below[0] || null
  };
}

function buildTrade(d, dir) {
  const p = d.m15.price;

  const a =
    d.m15.atr || 2;

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

  const sweep =
    dir === 'BUY'
      ? d.m15.sweep === 'SWEEP_LOW'
      : d.m15.sweep === 'SWEEP_HIGH';

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
        p - a * MAX_SPREAD_PROXY_ATR
      );

    entryHigh =
      Math.min(
        p + a * 0.20,
        support + a * 0.35
      );

    if (entryHigh < entryLow) {
      entryHigh =
        entryLow + a * 0.15;
    }

    sl =
      Math.min(
        d.m15.range.low - a * 0.25,
        p - a * 1.15
      );

    if (
      levels.nextSupport &&
      levels.nextSupport < entryLow
    ) {
      sl =
        Math.min(
          sl,
          levels.nextSupport - a * 0.15
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

    const rTarget =
      entryHigh +
      risk * MIN_RR;

    tp1 =
      levels.nextResistance &&
      levels.nextResistance > entryHigh
        ? Math.min(
            levels.nextResistance,
            rTarget
          )
        : rTarget;

    tp2 =
      entryHigh +
      risk * 2.4;

    tp3 =
      entryHigh +
      risk * 3.2;

    trigger =
      sweep
        ? '15M Sweep Low + CHoCH/BOS صعودی + EMA20 + RSI>50'
        : '15M CHoCH/BOS صعودی + EMA20 + RSI>50';
  }

  else {
    const resistance =
      Math.min(
        d.m15.range.high,
        d.m15.ema20 ||
          d.m15.range.high
      );

    entryHigh =
      Math.min(
        d.m15.range.high,
        p + a * MAX_SPREAD_PROXY_ATR
      );

    entryLow =
      Math.max(
        p - a * 0.20,
        resistance - a * 0.35
      );

    if (entryLow > entryHigh) {
      entryLow =
        entryHigh - a * 0.15;
    }

    sl =
      Math.max(
        d.m15.range.high + a * 0.25,
        p + a * 1.15
      );

    if (
      levels.nextResistance &&
      levels.nextResistance > entryHigh
    ) {
      sl =
        Math.max(
          sl,
          levels.nextResistance + a * 0.15
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

    const rTarget =
      entryLow -
      risk * MIN_RR;

    tp1 =
      levels.nextSupport &&
      levels.nextSupport < entryLow
        ? Math.max(
            levels.nextSupport,
            rTarget
          )
        : rTarget;

    tp2 =
      entryLow -
      risk * 2.4;

    tp3 =
      entryLow -
      risk * 3.2;

    trigger =
      sweep
        ? '15M Sweep High + CHoCH/BOS نزولی + EMA20 + RSI<50'
        : '15M CHoCH/BOS نزولی + EMA20 + RSI<50';
  }

  const rr =
    dir === 'BUY'
      ? (tp1 - entryHigh) /
        (entryHigh - sl)
      : (entryLow - tp1) /
        (sl - entryLow);

  return {
    entry: {
      low: fmt(entryLow),
      high: fmt(entryHigh)
    },

    stopLoss: fmt(sl),

    targets: [
      fmt(tp1),
      fmt(tp2),
      fmt(tp3)
    ],

    rr: fmt(rr),

    trigger,

    levels
  };
}

function getSession(time) {
  const d =
    new Date(time);

  const hour =
    d.getUTCHours();

  if (hour >= 0 && hour < 8) {
    return 'ASIA';
  }

  if (hour >= 8 && hour < 13) {
    return 'LONDON';
  }

  if (hour >= 13 && hour < 17) {
    return 'NEW_YORK';
  }

  return 'NEW_YORK_LATE';
}

function scoreSignalQuality(
  d,
  consensus,
  trade,
  dir,
  signalTime
) {
  let score = 50;

  const reasons = [];
  const blockers = [];

  // 1 — Consensus
  if (consensus.agreeCount >= 5) {
    score += 10;
    reasons.push('اجماع قوی');
  }

  else if (consensus.agreeCount >= 4) {
    score += 7;
    reasons.push('اجماع مناسب');
  }

  else if (consensus.agreeCount >= 3) {
    score += 2;
    reasons.push('اجماع متوسط');
  }

  else {
    score -= 10;
  }

  // 2 — Weight gap
  const weightGap =
    Math.abs(
      Number(consensus.buyWeight || 0) -
      Number(consensus.sellWeight || 0)
    );

  if (weightGap >= 30) {
    score += 8;
  }

  else if (weightGap >= 20) {
    score += 5;
  }

  else if (weightGap < 10) {
    score -= 4;
  }

  // 3 — R:R
  const rr =
    Number(trade?.rr || 0);

  if (rr >= 2.5) {
    score += 10;
  }

  else if (rr >= 2.0) {
    score += 7;
  }

  else if (rr >= MIN_RR) {
    score += 3;
  }

  else {
    score -= 15;

    blockers.push(
      `R:R کمتر از ${MIN_RR}`
    );
  }

  // 4 — Higher timeframe
  const h4Bull =
    d.h4.price > d.h4.ema20;

  const h4Bear =
    d.h4.price < d.h4.ema20;

  const dBull =
    d.daily.price > d.daily.ema20;

  const dBear =
    d.daily.price < d.daily.ema20;

  if (
    (dir === 'BUY' &&
      h4Bull &&
      dBull) ||

    (dir === 'SELL' &&
      h4Bear &&
      dBear)
  ) {
    score += 10;

    reasons.push(
      '4H و Daily هم‌جهت'
    );
  }

  else if (
    (dir === 'BUY' &&
      (h4Bull || dBull)) ||

    (dir === 'SELL' &&
      (h4Bear || dBear))
  ) {
    score += 4;

    reasons.push(
      'یکی از تایم‌فریم‌های بالا تأیید می‌کند'
    );
  }

  else {
    score -= 6;

    if (
      (dir === 'BUY' &&
        h4Bear &&
        dBear) ||

      (dir === 'SELL' &&
        h4Bull &&
        dBull)
    ) {
      blockers.push(
        '4H و Daily هر دو خلاف جهت معامله هستند'
      );
    }
  }

  // 5 — 15M structure
  const structureBuy =
    d.m15.structure ===
    'BULLISH_BOS';

  const structureSell =
    d.m15.structure ===
    'BEARISH_BOS';

  if (
    (dir === 'BUY' &&
      structureBuy) ||

    (dir === 'SELL' &&
      structureSell)
  ) {
    score += 8;

    reasons.push(
      'ساختار 15M هم‌جهت'
    );
  }

  else if (
    d.m15.structure ===
    'MIXED'
  ) {
    score -= 3;
  }

  else {
    score -= 4;
  }

  // 6 — Momentum
  const rsiValue =
    Number(d.m15.rsi || 50);

  const price =
    Number(d.m15.price);

  const ema20 =
    Number(d.m15.ema20);

  if (dir === 'BUY') {
    if (
      rsiValue >= 50 &&
      rsiValue < 68 &&
      price > ema20
    ) {
      score += 8;

      reasons.push(
        'مومنتوم صعودی'
      );
    }

    else if (
      rsiValue >= 68
    ) {
      score -= 4;

      reasons.push(
        'RSI نسبتاً اشباع خرید'
      );
    }

    else {
      score -= 3;
    }
  }

  if (dir === 'SELL') {
    if (
      rsiValue <= 50 &&
      rsiValue > 32 &&
      price < ema20
    ) {
      score += 8;

      reasons.push(
        'مومنتوم نزولی'
      );
    }

    else if (
      rsiValue <= 32
    ) {
      score -= 4;

      reasons.push(
        'RSI نسبتاً اشباع فروش'
      );
    }

    else {
      score -= 3;
    }
  }

  // 7 — Sweep
  const sweepMatch =
    (dir === 'BUY' &&
      d.m15.sweep ===
        'SWEEP_LOW') ||

    (dir === 'SELL' &&
      d.m15.sweep ===
        'SWEEP_HIGH');

  if (sweepMatch) {
    score += 7;

    reasons.push(
      'Liquidity Sweep تأییدکننده'
    );
  }

  // 8 — Volume booster
  if (
    d.m15.volumeState &&
    d.m15.volumeState.confirmed
  ) {
    score += 3;

    reasons.push(
      'حجم تأییدکننده'
    );
  }

  // 9 — SL quality
  const atrValue =
    Number(d.m15.atr || 0);

  if (
    atrValue > 0 &&
    trade?.stopLoss != null
  ) {
    const stopDistance =
      Math.abs(
        price -
        Number(trade.stopLoss)
      );

    const atrRatio =
      stopDistance /
      atrValue;

    if (
      atrRatio >= 0.8 &&
      atrRatio <= 2.5
    ) {
      score += 5;
    }

    else if (
      atrRatio < 0.6
    ) {
      score -= 8;

      blockers.push(
        'حد ضرر بیش از حد نزدیک است'
      );
    }

    else if (
      atrRatio > 3.5
    ) {
      score -= 4;
    }
  }

  // 10 — Session
  const session =
    getSession(signalTime);

  if (session === 'ASIA') {
    score += 3;
  }

  else if (
    session ===
    'NEW_YORK_LATE'
  ) {
    score += 2;
  }

  else if (
    session === 'LONDON'
  ) {
    score -= 2;
  }

  else if (
    session === 'NEW_YORK'
  ) {
    score -= 1;
  }

  score =
    clamp(score);

  let grade = 'POOR';

  if (score >= 85) {
    grade = 'EXCELLENT';
  }

  else if (score >= 75) {
    grade = 'GOOD';
  }

  else if (score >= 65) {
    grade = 'FAIR';
  }

  const tradable =
    score >= MIN_QUALITY_SCORE &&
    blockers.length === 0;

  return {
    score: fmt(score),
    grade,
    session,
    tradable,
    blockers,
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
    volumeConfirmed
  } =
    runStrategies(
      d,
      fund
    );

  const consensus =
    computeConsensus(
      strategies,
      volumeConfirmed
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

  if (dir === 'WAIT') {
    trade.isHypothetical = true;
  }

  const blockers = [];

  if (
    consensus.agreeCount <
    Math.ceil(
      consensus.totalCount / 2
    )
  ) {
    blockers.push(
      `اجماع کافی نیست (فقط ${consensus.agreeCount} از ${consensus.totalCount})`
    );
  }

  if (
    d.m15.rsi >= 72 ||
    d.m15.rsi <= 28
  ) {
    blockers.push(
      'Momentum در ناحیه افراطی است'
    );
  }

  if (news.blocked) {
    blockers.push(
      'خبر پرریسک در پنجره زمانی نزدیک'
    );
  }

  if (
    trade &&
    trade.rr < MIN_RR
  ) {
    blockers.push(
      `R:R کمتر از ${MIN_RR}`
    );
  }

  if (
    dir === 'BUY' &&
    d.h4.price < d.h4.ema20 &&
    d.daily.price < d.daily.ema20
  ) {
    blockers.push(
      '4H و Daily هر دو خلاف BUY هستند'
    );
  }

  if (
    dir === 'SELL' &&
    d.h4.price > d.h4.ema20 &&
    d.daily.price > d.daily.ema20
  ) {
    blockers.push(
      '4H و Daily هر دو خلاف SELL هستند'
    );
  }

  const quality =
    scoreSignalQuality(
      d,
      consensus,
      trade,
      tradeDir,
      d.m15.bars?.[
        d.m15.bars.length - 1
      ]?.time || Date.now()
    );

  const active =
    dir !== 'WAIT' &&
    consensus.confidence >=
      MIN_CONFIDENCE &&
    blockers.length === 0 &&
    quality.tradable;

  /*
   * --------------------------------------------------
   * Diagnostic data
   * --------------------------------------------------
   *
   * رأی دقیق هر یک از 7 استراتژی را جداگانه ذخیره می‌کنیم.
   * این اطلاعات برای بک‌تست و کالیبراسیون بعدی استفاده می‌شود.
   */

  const strategyVotes = Object.fromEntries(
    strategies.map(s => [
      s.name,
      s.vote
    ])
  );

  /*
   * ترکیب کامل رأی‌ها به شکل ثابت.
   *
   * ترتیب دقیقاً همان ترتیب 7 استراتژی است.
   */
  const strategyKey = strategies
    .map(s => s.vote)
    .join('|');

  /*
   * خلاصه خواناتر برای تحلیل:
   */
  const strategyVoteDetails =
    strategies.map(s => ({
      name: s.name,
      vote: s.vote,
      weight: s.weight,
      reason: s.reason
    }));

  return {
    decision:
      active
        ? dir
        : 'WAIT',

    direction: dir,

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

      volumeConfirmed
    },

    strategies,

    /*
     * Diagnostic:
     * رأی جداگانه هر استراتژی
     */
    strategyVotes,

    /*
     * Diagnostic:
     * ترکیب کامل 7 رأی
     */
    strategyKey,

    /*
     * Diagnostic:
     * اطلاعات کامل‌تر هر استراتژی
     */
    strategyVoteDetails,

    trade,

    blockers,

    quality,

    fundamental: fund,

    newsRisk: news
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

  fetchFundamental,
  fetchNewsRisk,

  neutralFundamental,
  neutralNewsRisk,

  getSession,
  scoreSignalQuality
};
