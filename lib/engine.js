// Gold Hunter — Decision Engine Core
// Improved signal quality + calibrated confidence + reliable historical pagination

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

  const low =
    Math.min(...x.map(v => v.low));

  const high =
    Math.max(...x.map(v => v.high));

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

  const hi =
    Math.max(...a.map(v => v.high));

  const lo =
    Math.min(...a.map(v => v.low));

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
    ema(c.slice(-60), 20);

  const e50 =
    ema(c.slice(-100), 50);

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

  return {
    available: true,

    ratio:
      b[b.length - 1].volume / av,

    confirmed:
      b[b.length - 1].volume >
      av * 1.15
  };
}

function fibZone(d) {
  const piv =
    d.m15.pivots;

  if (
    !piv.highs.length ||
    !piv.lows.length
  ) {
    return {
      vote: 'NEUTRAL',
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
      reason:
        'محدوده سوئینگ نامعتبر است'
    };
  }

  const price =
    d.m15.price;

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
      reason:
        `اصلاح فیبوناچی ${Math.round(
          retFromHigh * 100
        )}% در روند صعودی`
    };
  }

  if (
    price < d.m15.ema20 &&
    goldenLow
  ) {
    return {
      vote: 'SELL',
      reason:
        `اصلاح فیبوناچی ${Math.round(
          retFromLow * 100
        )}% در روند نزولی`
    };
  }

  return {
    vote: 'NEUTRAL',
    reason:
      'قیمت در ناحیه کلیدی فیبوناچی نیست'
  };
}

function divergence(bars) {
  if (!bars || bars.length < 30) {
    return {
      vote: 'NEUTRAL',
      reason:
        'داده کافی برای واگرایی نیست'
    };
  }

  const closes =
    bars.map(b => b.close);

  const series = [];

  for (
    let i =
      Math.max(
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
    price: last.close,
    ema20: m.ema20,
    ema50: m.ema50,
    rsi: m.rsi,
    atr: a,

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

  const bars =
    normalizeBars(d.values)
      .sort(
        (a, b) =>
          a.time - b.time
      );

  return bars;
}

/*
 * تبدیل timestamp به فرمت مناسب برای end_date
 *
 * نکته:
 * به جای استفاده از:
 *
 * oldest - 1 millisecond
 *
 * یک ثانیه کامل عقب می‌رویم تا
 * timestamp قبلی در API دوباره
 * با همان کندل overlap نکند.
 */
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

/*
 * ساختن timestamp صفحه بعد.
 *
 * API ممکن است کندل مرزی را inclusive برگرداند.
 * بنابراین یک ثانیه قبل از قدیمی‌ترین
 * کندل فعلی درخواست می‌شود.
 */
function getNextEndDate(oldestTime) {
  if (!Number.isFinite(oldestTime)) {
    return null;
  }

  return formatEndDate(
    oldestTime - 1000
  );
}

/*
 * تاریخچه طولانی:
 *
 * هدف:
 *  - دریافت تا 50,000 کندل
 *  - pagination واقعی
 *  - جلوگیری از duplicate
 *  - تشخیص page تکراری
 *  - تشخیص pagination ناقص
 *  - نگهداری metadata برای backtest
 */
async function fetchTFHistory(
  tf,
  totalBars
) {
  const key =
    process.env.TWELVEDATA_API_KEY;

  if (!key) {
    return null;
  }

  const wanted =
    Math.max(
      220,
      Math.min(
        Number(totalBars) || 220,
        HISTORY_MAX_BARS
      )
    );

  /*
   * برای درخواست‌های کوچک،
   * مسیر معمولی سریع‌تر است.
   */
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

  /*
   * برای جلوگیری از loop بی‌نهایت.
   */
  const maxPages =
    Math.ceil(
      wanted / HISTORY_CHUNK
    ) + 5;

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

    /*
     * cacheKey عمداً شامل endDate است
     * تا هر page cache مستقل داشته باشد.
     */
    const cacheKey =
      `engine-history:${SYMBOL}:${tf}:${HISTORY_CHUNK}:${endDate || 'latest'}`;

    const result =
      await fetchJson(
        cacheKey,
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

    /*
     * قدیمی‌ترین کندل این page.
     */
    const pageOldest =
      bars[0].time;

    const pageNewest =
      bars[bars.length - 1].time;

    /*
     * اگر page جدیدتر/برابر با page قبلی
     * باشد، pagination احتمالاً مرز زمانی
     * را قبول نکرده یا provider همان page
     * را دوباره داده است.
     */
    if (
      previousOldest !== null &&
      pageOldest >= previousOldest
    ) {
      duplicatePages++;

      /*
       * تلاش مجدد با مرز زمانی یک interval
       * کامل عقب‌تر.
       *
       * این قسمت مهم است:
       * اگر end_date دقیقاً درست پردازش نشده
       * باشد، دیگر همان 4500 کندل را
       * بی‌نهایت دریافت نمی‌کنیم.
       */
      const intervalMs = {
        '15M': 15 * 60 * 1000,
        '1H': 60 * 60 * 1000,
        '4H': 4 * 60 * 60 * 1000,
        'Daily': 24 * 60 * 60 * 1000
      }[tf] || 60 * 60 * 1000;

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

    /*
     * فقط کندل‌هایی که قبلاً نداریم
     * وارد all می‌شوند.
     */
    const known =
      new Set(
        all.map(
          b => b.time
        )
      );

    const unique =
      bars.filter(
        b =>
          !known.has(
            b.time
          )
      );

    /*
     * اگر هیچ کندل جدیدی نبود،
     * pagination واقعی جلو نرفته است.
     */
    if (!unique.length) {
      duplicatePages++;

      /*
       * یک بار دیگر با مرز interval
       * عقب‌تر تلاش می‌کنیم.
       */
      const intervalMs = {
        '15M': 15 * 60 * 1000,
        '1H': 60 * 60 * 1000,
        '4H': 4 * 60 * 60 * 1000,
        'Daily': 24 * 60 * 60 * 1000
      }[tf] || 60 * 60 * 1000;

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

    /*
     * چون pageها از جدید به قدیم می‌آیند،
     * به ابتدای all اضافه می‌شوند.
     */
    all.unshift(
      ...unique
    );

    /*
     * اگر به تعداد موردنظر رسیدیم،
     * کار تمام است.
     */
    if (
      all.length >= wanted
    ) {
      stoppedReason =
        'target-reached';

      break;
    }

    /*
     * اگر provider کمتر از chunk داده،
     * احتمالاً به ابتدای تاریخ موجود
     * رسیده‌ایم.
     */
    if (
      bars.length < HISTORY_CHUNK
    ) {
      stoppedReason =
        'provider-history-exhausted';

      break;
    }

    /*
     * مهم‌ترین قسمت pagination:
     *
     * end_date صفحه بعد باید قبل از
     * قدیمی‌ترین کندل page فعلی باشد.
     */
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

  /*
   * مرتب‌سازی نهایی و حذف duplicate
   * حتی اگر provider داده تکراری
   * برگردانده باشد.
   */
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

  /*
   * metadata را non-enumerable
   * ذخیره می‌کنیم تا در عملیات معمولی
   * map/JSON باعث مشکل نشود.
   */
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

function runStrategies(d, fund) {

  const strategies = [];

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

  strategies.push({
    name:
      'روند چندتایم‌فریمی',

    vote:
      trendVote,

    weight: 30,

    reason:
      trendReason
  });

  strategies.push({
    name:
      'ساختار بازار (BOS/CHoCH)',

    vote:
      d.m15.structure ===
        'BULLISH_BOS'
        ? 'BUY'
        : d.m15.structure ===
          'BEARISH_BOS'
            ? 'SELL'
            : 'NEUTRAL',

    weight: 14,

    reason:
      d.m15.structure ===
        'BULLISH_BOS'
        ? 'شکست ساختار صعودی در 15M'
        : d.m15.structure ===
          'BEARISH_BOS'
            ? 'شکست ساختار نزولی در 15M'
            : 'ساختار 15M نامشخص'
  });

  strategies.push({
    name:
      'Liquidity Sweep (SMC)',

    vote:
      d.m15.sweep ===
        'SWEEP_LOW'
        ? 'BUY'
        : d.m15.sweep ===
          'SWEEP_HIGH'
            ? 'SELL'
            : 'NEUTRAL',

    weight: 18,

    reason:
      d.m15.sweep ===
        'SWEEP_LOW'
        ? 'شکار نقدینگی زیر کف و بازگشت'
        : d.m15.sweep ===
          'SWEEP_HIGH'
            ? 'شکار نقدینگی بالای سقف و بازگشت'
            : 'شکار نقدینگی رخ نداده'
  });

  const momVote =
    d.m15.rsi > 50 &&
    d.m15.rsi < 72 &&
    d.m15.price >
      d.m15.ema20

      ? 'BUY'

      : d.m15.rsi < 50 &&
        d.m15.rsi > 28 &&
        d.m15.price <
          d.m15.ema20

        ? 'SELL'

        : 'NEUTRAL';

  strategies.push({
    name:
      'مومنتوم (RSI + EMA20)',

    vote:
      momVote,

    weight: 12,

    reason:
      momVote === 'BUY'
        ? `RSI ${fmt(d.m15.rsi)} و قیمت بالای EMA20`
        : momVote === 'SELL'
          ? `RSI ${fmt(d.m15.rsi)} و قیمت زیر EMA20`
          : 'مومنتوم خنثی یا افراطی'
  });

  const fib =
    fibZone(d);

  strategies.push({
    name:
      'Fibonacci Retracement',

    vote:
      fib.vote,

    weight: 10,

    reason:
      fib.reason
  });

  const div =
    divergence(
      d.m15.bars
    );

  strategies.push({
    name:
      'واگرایی RSI',

    vote:
      div.vote,

    weight: 8,

    reason:
      div.reason
  });

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

  const dir =
    buyWeight > sellWeight
      ? 'BUY'
      : sellWeight > buyWeight
        ? 'SELL'
        : 'WAIT';

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

  let sl;
  let tp1;
  let tp2;
  let tp3;
  let entryLow;
  let entryHigh;
  let trigger;

  if (dir === 'BUY') {

    entryLow =
      p -
      a * 0.20;

    entryHigh =
      p +
      a * 0.20;

    let structuralSL =
      Math.min(
        d.m15.range.low -
          a * 0.25,

        p -
          a * 1.15
      );

    if (
      levels.nextSupport &&
      levels.nextSupport <
        p
    ) {
      structuralSL =
        Math.min(
          structuralSL,
          levels.nextSupport -
            a * 0.15
        );
    }

    sl =
      structuralSL;

    if (
      p - sl <
      MIN_STOP_USD
    ) {
      sl =
        p -
        MIN_STOP_USD;
    }

    const risk =
      p - sl;

    const rTarget =
      p +
      risk * MIN_RR;

    if (
      levels.nextResistance &&
      levels.nextResistance >
        p
    ) {
      const space =
        levels.nextResistance -
        p;

      if (
        space >=
        risk * MIN_RR
      ) {
        tp1 =
          Math.min(
            levels.nextResistance,
            rTarget
          );
      } else {
        tp1 =
          rTarget;
      }
    } else {
      tp1 =
        rTarget;
    }

    tp2 =
      p +
      risk * 2.4;

    tp3 =
      p +
      risk * 3.2;

    trigger =
      d.m15.sweep ===
      'SWEEP_LOW'
        ? '15M Sweep Low + ساختار صعودی + EMA20 + RSI>50'
        : '15M ساختار صعودی + EMA20 + RSI>50';
  }

  else {

    entryLow =
      p -
      a * 0.20;

    entryHigh =
      p +
      a * 0.20;

    let structuralSL =
      Math.max(
        d.m15.range.high +
          a * 0.25,

        p +
          a * 1.15
      );

    if (
      levels.nextResistance &&
      levels.nextResistance >
        p
    ) {
      structuralSL =
        Math.max(
          structuralSL,
          levels.nextResistance +
            a * 0.15
        );
    }

    sl =
      structuralSL;

    if (
      sl - p <
      MIN_STOP_USD
    ) {
      sl =
        p +
        MIN_STOP_USD;
    }

    const risk =
      sl - p;

    const rTarget =
      p -
      risk * MIN_RR;

    if (
      levels.nextSupport &&
      levels.nextSupport <
        p
    ) {
      const space =
        p -
        levels.nextSupport;

      if (
        space >=
        risk * MIN_RR
      ) {
        tp1 =
          Math.max(
            levels.nextSupport,
            rTarget
          );
      } else {
        tp1 =
          rTarget;
      }
    } else {
      tp1 =
        rTarget;
    }

    tp2 =
      p -
      risk * 2.4;

    tp3 =
      p -
      risk * 3.2;

    trigger =
      d.m15.sweep ===
      'SWEEP_HIGH'
        ? '15M Sweep High + ساختار نزولی + EMA20 + RSI<50'
        : '15M ساختار نزولی + EMA20 + RSI<50';
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
  signalTime
) {
  let score = 50;

  const reasons = [];
  const blockers = [];

  /*
   * 1. Consensus
   */
  if (
    consensus.agreeCount >= 5
  ) {
    score += 8;

    reasons.push(
      'اجماع قوی'
    );
  }

  else if (
    consensus.agreeCount >= 4
  ) {
    score += 5;

    reasons.push(
      'اجماع مناسب'
    );
  }

  else if (
    consensus.agreeCount >= 3
  ) {
    score += 1;
  }

  else {
    score -= 8;

    blockers.push(
      'تعداد استراتژی‌های هم‌جهت کم است'
    );
  }

  /*
   * 2. Weight gap
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
      'اختلاف وزن استراتژی‌ها زیاد است'
    );
  }

  else if (
    weightGap >= 25
  ) {
    score += 5;
  }

  else if (
    weightGap >= 15
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
    rr >= 2
  ) {
    score += 6;

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
   * 4. Higher timeframe
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
    score += 9;

    reasons.push(
      '4H و Daily صعودی'
    );
  }

  else if (
    dir === 'SELL' &&
    h4Bear &&
    dBear
  ) {
    score += 9;

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
    score -= 8;

    blockers.push(
      'تایم‌فریم‌های بالاتر تأیید نمی‌کنند'
    );
  }

  if (
    dir === 'BUY' &&
    h4Bear &&
    dBear
  ) {
    blockers.push(
      '4H و Daily هر دو خلاف BUY هستند'
    );
  }

  if (
    dir === 'SELL' &&
    h4Bull &&
    dBull
  ) {
    blockers.push(
      '4H و Daily هر دو خلاف SELL هستند'
    );
  }

  /*
   * 5. Structure
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

  else {
    score -= 5;

    blockers.push(
      'ساختار 15M تأییدکننده نیست'
    );
  }

  /*
   * 6. Momentum
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
      rsiValue >= 68
    ) {
      score -= 5;

      reasons.push(
        'RSI نزدیک اشباع خرید'
      );
    }

    else {
      score -= 5;
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
      rsiValue <= 32
    ) {
      score -= 5;

      reasons.push(
        'RSI نزدیک اشباع فروش'
      );
    }

    else {
      score -= 5;
    }
  }

  /*
   * 7. Sweep
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

  if (sweepMatch) {
    score += 7;

    reasons.push(
      'Liquidity Sweep تأییدکننده'
    );
  }

  /*
   * 8. Volume
   */
  if (
    d.m15.volumeState &&
    d.m15.volumeState.confirmed
  ) {
    score += 2;

    reasons.push(
      'حجم تأییدکننده'
    );
  }

  /*
   * 9. SL / ATR
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
      atrRatio >= 0.8 &&
      atrRatio <= 2.8
    ) {
      score += 5;

      reasons.push(
        'فاصله حد ضرر منطقی'
      );
    }

    else if (
      atrRatio < 0.6
    ) {
      score -= 10;

      blockers.push(
        'حد ضرر بیش از حد نزدیک است'
      );
    }

    else if (
      atrRatio > 3.5
    ) {
      score -= 5;

      reasons.push(
        'حد ضرر بسیار بزرگ'
      );
    }
  }

  /*
   * 10. Location
   */
  const resistance =
    d.m15.range.high;

  const support =
    d.m15.range.low;

  if (
    atrValue > 0 &&
    Number.isFinite(resistance) &&
    Number.isFinite(support)
  ) {
    if (
      dir === 'BUY'
    ) {
      const distance =
        resistance -
        price;

      if (
        distance <
        atrValue * 0.8
      ) {
        score -= 7;

        blockers.push(
          'BUY بیش از حد نزدیک مقاومت 15M است'
        );
      }

      else if (
        distance >
        atrValue * 1.5
      ) {
        score += 3;
      }
    }

    if (
      dir === 'SELL'
    ) {
      const distance =
        price -
        support;

      if (
        distance <
        atrValue * 0.8
      ) {
        score -= 7;

        blockers.push(
          'SELL بیش از حد نزدیک حمایت 15M است'
        );
      }

      else if (
        distance >
        atrValue * 1.5
      ) {
        score += 3;
      }
    }
  }

  /*
   * 11. Session
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
    session ===
    'NEW_YORK_LATE'
  ) {
    score += 2;
  }

  else if (
    session ===
    'LONDON'
  ) {
    score -= 2;
  }

  else if (
    session ===
    'NEW_YORK'
  ) {
    score -= 1;
  }

  /*
   * 12. Extreme RSI
   */
  if (
    rsiValue >= 75 ||
    rsiValue <= 25
  ) {
    blockers.push(
      'RSI در محدوده بسیار افراطی است'
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

  const tradable =
    score >=
      MIN_QUALITY_SCORE &&
    blockers.length === 0;

  return {
    score:
      fmt(score),

    grade,

    session,

    tradable,

    blockers:
      [...new Set(blockers)],

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

  if (
    dir === 'WAIT'
  ) {
    trade.isHypothetical =
      true;
  }

  const blockers = [];

  /*
   * حداقل تعداد رأی
   */
  if (
    consensus.agreeCount <
    Math.ceil(
      consensus.totalCount / 2
    )
  ) {
    blockers.push(
      `اجماع کافی نیست (${consensus.agreeCount}/${consensus.totalCount})`
    );
  }

  /*
   * RSI شدید
   */
  if (
    d.m15.rsi >= 72 ||
    d.m15.rsi <= 28
  ) {
    blockers.push(
      'Momentum در ناحیه افراطی است'
    );
  }

  /*
   * News
   */
  if (
    news &&
    news.blocked
  ) {
    blockers.push(
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
    blockers.push(
      `R:R کمتر از ${MIN_RR}`
    );
  }

  /*
   * HTF conflict
   */
  if (
    dir === 'BUY' &&
    d.h4.price <
      d.h4.ema20 &&
    d.daily.price <
      d.daily.ema20
  ) {
    blockers.push(
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
    blockers.push(
      '4H و Daily هر دو خلاف SELL هستند'
    );
  }

  /*
   * strategy diagnostic
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

  const quality =
    scoreSignalQuality(
      d,
      consensus,
      trade,
      tradeDir,
      d.m15.bars?.[
        d.m15.bars.length - 1
      ]?.time ||
      Date.now()
    );

  const finalBlockers =
    [
      ...new Set([
        ...blockers,
        ...quality.blockers
      ])
    ];

  const active =
    dir !== 'WAIT' &&
    consensus.confidence >=
      MIN_CONFIDENCE &&
    finalBlockers.length === 0 &&
    quality.tradable;

  return {
    decision:
      active
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

      volumeConfirmed
    },

    strategies,

    strategyVotes,

    strategyKey,

    trade,

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

  fetchFundamental,
  fetchNewsRisk,

  neutralFundamental,
  neutralNewsRisk,

  getSession,
  scoreSignalQuality
};
