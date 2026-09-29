// Gold Hunter — Decision Engine Core (مشترک بین /api/signal زنده و /api/signal/backtest)
// این فایل هیچ درخواست شبکه یا Express را مستقیم اجرا نمی‌کند مگر توابع fetch* که صراحتاً شبکه‌ای‌اند.
// هدف اصلی: بک‌تست دقیقاً همان منطقی را اجرا کند که سیگنال زنده اجرا می‌کند — نه یک نسخه جداگانه.

const fetch = require('node-fetch');
const { fetchJson } = require('./market-cache');

const SYMBOL = process.env.XAU_SYMBOL || 'XAU/USD';
const TF = { '15M': '15min', '1H': '1h', '4H': '4h', 'Daily': '1day' };
const MIN_CONFIDENCE = Number(process.env.MIN_SIGNAL_CONFIDENCE || 72);
const MIN_RR = Number(process.env.MIN_SIGNAL_RR || 1.8);
const MAX_SPREAD_PROXY_ATR = Number(process.env.MAX_ENTRY_ATR_DISTANCE || 0.55);
// حداقل فاصله مجاز حد ضرر (به دلار) — در بازه‌های کم‌نوسان (ATR خیلی کوچک)، بدون این محافظ
// حد ضرر می‌تواند غیرواقعی نزدیک شود (مثلاً ۰.۳ دلار روی طلا) که حتی اسپرد عادی بروکر آن را می‌زند.
const MIN_STOP_USD = Number(process.env.MIN_STOP_DISTANCE_USD || 3.0);
const MIN_STOP_ATR = Number(process.env.MIN_STOP_ATR || 0.65);
const MAX_STOP_ATR = Number(process.env.MAX_STOP_ATR || 3.5);

// Last historical-fetch diagnostics, keyed by timeframe.
// Kept outside the returned array so Array.slice()/spread operations do not lose it.
const historyDiagnostics = new Map();

const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const fmt = (x) => Number(Number(x).toFixed(2));

function ema(a, n) { if (a.length < n) return null; const k = 2 / (n + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; }
function rsi(a, n = 14) { if (a.length < n + 1) return 50; let g = 0, l = 0; for (let i = a.length - n; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; } if (l === 0) return 100; return 100 - 100 / (1 + g / l); }
function atr(b, n = 14) { if (b.length < n + 1) return null; let s = 0; for (let i = b.length - n; i < b.length; i++) s += Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)); return s / n; }
function range(b, n = 50) { const x = b.slice(-n); return { low: Math.min(...x.map(v => v.low)), high: Math.max(...x.map(v => v.high)), mid: (Math.min(...x.map(v => v.low)) + Math.max(...x.map(v => v.high))) / 2 }; }
function pivots(b, n = 30) {
  const x = b.slice(-n); const highs = [], lows = [];
  for (let i = 2; i < x.length - 2; i++) {
    if (x[i].high > x[i - 1].high && x[i].high > x[i - 2].high && x[i].high > x[i + 1].high && x[i].high > x[i + 2].high) highs.push(x[i].high);
    if (x[i].low < x[i - 1].low && x[i].low < x[i - 2].low && x[i].low < x[i + 1].low && x[i].low < x[i + 2].low) lows.push(x[i].low);
  }
  return { highs: highs.slice(-6), lows: lows.slice(-6) };
}
function structure(b) {
  // Require a close-based break with displacement, then a second-candle hold
  // above/below the broken level. This avoids treating a single impulsive wick
  // as a durable BOS while keeping confirmation to one candle.
  if (b.length < 28) return 'MIXED';
  const x = b.slice(-8), p = b.slice(-22, -8);
  if (x.length < 8 || p.length < 12) return 'MIXED';
  const a = atr(b, 14) || 0;
  if (!(a > 0)) return 'MIXED';
  const last = x[x.length - 1], prev = x[x.length - 2];
  const ph = Math.max(...p.map(v => v.high));
  const pl = Math.min(...p.map(v => v.low));
  const prevBody = Math.abs(prev.close - prev.open);
  const lastBody = Math.abs(last.close - last.open);
  const prevRange = Math.max(prev.high - prev.low, 1e-9);
  const lastRange = Math.max(last.high - last.low, 1e-9);
  const prevLoc = (prev.close - prev.low) / prevRange;
  const lastLoc = (last.close - last.low) / lastRange;
  const bullBreak = prev.close > ph;
  const bearBreak = prev.close < pl;
  const bullDisplacement = prevBody >= a * 0.35 && prevLoc >= 0.65;
  const bearDisplacement = prevBody >= a * 0.35 && prevLoc <= 0.35;
  const bullHold = last.close > ph && last.close > last.open && lastBody >= a * 0.15 && lastLoc >= 0.55;
  const bearHold = last.close < pl && last.close < last.open && lastBody >= a * 0.15 && lastLoc <= 0.45;
  if (bullBreak && bullDisplacement && bullHold) return 'BULLISH_BOS';
  if (bearBreak && bearDisplacement && bearHold) return 'BEARISH_BOS';
  return 'MIXED';
}
function sweepSignal(b) {
  if (b.length < 8) return 'NONE';
  const a = b.slice(-8, -1), c = b[b.length - 1];
  const hi = Math.max(...a.map(v => v.high)), lo = Math.min(...a.map(v => v.low));
  if (c.high > hi && c.close < hi) return 'SWEEP_HIGH';
  if (c.low < lo && c.close > lo) return 'SWEEP_LOW';
  return 'NONE';
}
function momentum(b) {
  const c = b.map(x => x.close), e20 = ema(c.slice(-60), 20), e50 = ema(c.slice(-100), 50), rr = rsi(c);
  return { ema20: e20, ema50: e50, rsi: rr, bull: e20 != null && e50 != null && e20 > e50 && rr > 50, bear: e20 != null && e50 != null && e20 < e50 && rr < 50 };
}
function volumeState(b) {
  const v = b.slice(-21).map(x => x.volume).filter(x => x > 0);
  if (v.length < 10) return { available: false, ratio: null, confirmed: false };
  const av = v.slice(0, -1).reduce((a, x) => a + x, 0) / (v.length - 1);
  return { available: true, ratio: b[b.length - 1].volume / av, confirmed: b[b.length - 1].volume > av * 1.15 };
}

function fibZone(d) {
  const piv = d.m15.pivots;
  if (!piv.highs.length || !piv.lows.length) return { vote: 'NEUTRAL', score: 0, reason: 'داده کافی برای تشخیص سوئینگ فیبوناچی نیست' };
  const swingHigh = Math.max(...piv.highs.slice(-3));
  const swingLow = Math.min(...piv.lows.slice(-3));
  const span = swingHigh - swingLow;
  if (!(span > 0)) return { vote: 'NEUTRAL', score: 0, reason: 'محدوده سوئینگ نامعتبر است' };

  const price = d.m15.price;
  const bars = d.m15.bars || [];
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const a = Number(d.m15.atr || 0);
  if (!last || !prev || !(a > 0)) return { vote: 'NEUTRAL', score: 0, reason: 'داده/ATR کافی برای تأیید واکنش فیبوناچی نیست' };

  // Retracement levels measured from swing low to swing high.
  const f382 = swingLow + span * 0.382;
  const f50 = swingLow + span * 0.500;
  const f618 = swingLow + span * 0.618;
  const tolerance = a * 0.18;
  const bullishTrend = price > d.m15.ema20 && d.m15.rsi > 50;
  const bearishTrend = price < d.m15.ema20 && d.m15.rsi < 50;

  // Do not trigger merely because price sits inside the 38.2–61.8% zone.
  // Require an actual rejection/reclaim candle at the zone.
  const bullishTouch = last.low <= f618 + tolerance && last.low >= f382 - tolerance;
  const bearishTouch = last.high >= f382 - tolerance && last.high <= f618 + tolerance;
  const bullishReclaim = last.close > f50 && last.close > last.open &&
    (prev.close <= f50 || last.close > prev.high);
  const bearishReclaim = last.close < f50 && last.close < last.open &&
    (prev.close >= f50 || last.close < prev.low);

  if (bullishTrend && bullishTouch && bullishReclaim) {
    return { vote: 'BUY', score: 2, confirmed: true, reason: 'واکنش صعودی معتبر در ناحیه 38.2–61.8% + reclaim سطح 50%' };
  }
  if (bearishTrend && bearishTouch && bearishReclaim) {
    return { vote: 'SELL', score: -2, confirmed: true, reason: 'واکنش نزولی معتبر در ناحیه 38.2–61.8% + rejection زیر سطح 50%' };
  }
  return { vote: 'NEUTRAL', score: 0, confirmed: false, reason: 'ناحیه فیبوناچی بدون واکنش/بازپس‌گیری معتبر' };
}

function divergence(bars) {
  if (!bars || bars.length < 36) return { vote: 'NEUTRAL', reason: 'داده کافی برای واگرایی نیست' };
  const closes = bars.map((b) => b.close);
  const series = [];
  for (let i = Math.max(14, closes.length - 48); i < closes.length; i++) {
    series.push({ price: closes[i], rsi: rsi(closes.slice(0, i + 1), 14), index: i });
  }
  if (series.length < 20) return { vote: 'NEUTRAL', reason: 'داده کافی برای واگرایی نیست' };
  const half = Math.floor(series.length / 2);
  const first = series.slice(0, half), second = series.slice(half);
  const firstMax = first.reduce((a, b) => (b.price > a.price ? b : a));
  const secondMax = second.reduce((a, b) => (b.price > a.price ? b : a));
  const firstMin = first.reduce((a, b) => (b.price < a.price ? b : a));
  const secondMin = second.reduce((a, b) => (b.price < a.price ? b : a));
  const last = bars[bars.length - 1], prev = bars[bars.length - 2];
  const a = atr(bars, 14) || 0;
  const bullish = secondMin.price < firstMin.price && secondMin.rsi > firstMin.rsi;
  const bearish = secondMax.price > firstMax.price && secondMax.rsi < firstMax.rsi;
  if (a <= 0) return { vote: 'NEUTRAL', reason: 'ATR نامعتبر است' };
  // Divergence is a setup. Trigger only after a small price/RSI reversal is
  // visible; this prevents entering while price is still extending the move.
  const bullConfirm = last.close > last.open && last.close >= prev.close && last.close > last.high - a * 0.55;
  const bearConfirm = last.close < last.open && last.close <= prev.close && last.close < last.low + a * 0.55;
  if (bearish && bearConfirm) return { vote: 'SELL', reason: 'واگرایی نزولی + تأیید برگشت قیمت' };
  if (bullish && bullConfirm) return { vote: 'BUY', reason: 'واگرایی صعودی + تأیید برگشت قیمت' };
  if (bearish) return { vote: 'SELL_SETUP', reason: 'واگرایی نزولی دیده شد ولی Trigger برگشت هنوز تأیید نشده' };
  if (bullish) return { vote: 'BUY_SETUP', reason: 'واگرایی صعودی دیده شد ولی Trigger برگشت هنوز تأیید نشده' };
  return { vote: 'NEUTRAL', reason: 'واگرایی مشخصی بین قیمت و RSI دیده نمی‌شود' };
}

function analyze(b) {
  const last = b[b.length - 1], m = momentum(b), a = atr(b), sr = range(b), pv = pivots(b), vol = volumeState(b);
  return { price: last.close, ema20: m.ema20, ema50: m.ema50, rsi: m.rsi, atr: a, structure: structure(b), sweep: sweepSignal(b), range: sr, pivots: pv, volume: last.volume, volumeState: vol, bars: b };
}

function normalizeBars(values) {
  return (values || []).map((v) => ({
    time: new Date(v.datetime).getTime(), open: +v.open, high: +v.high,
    low: +v.low, close: +v.close, volume: v.volume ? +v.volume : 0
  }));
}

async function fetchTF(tf, limit = 220) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return null;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 220, 5000));
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=${TF[tf]}&outputsize=${safeLimit}&apikey=${key}`;
  const ttlByTf = { '15M': 90000, '1H': 300000, '4H': 600000, 'Daily': 1800000 };
  const result = await fetchJson(`engine-ohlc:${SYMBOL}:${tf}:${safeLimit}`, url, ttlByTf[tf] || 300000);
  const d = result.data;
  if (!d || d.status === 'error' || !Array.isArray(d.values) || !d.values.length) return null;
  return normalizeBars(d.values).reverse();
}

// Historical fetch for large backtests.
// Twelve Data limits one /time_series response to 5,000 records. We therefore
// page backwards with explicit UTC end_date boundaries, merge, de-duplicate,
// and stop only when the provider can no longer move further into history.
// This keeps live/signal requests unchanged while allowing large backtests.
function formatProviderDate(ms) {
  const d=new Date(ms);
  const pad=n=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

async function fetchTFHistory(tf, totalBars) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key || !TF[tf]) return null;

  const wanted = Math.max(220, Math.min(Number(totalBars) || 220, 100000));
  const intervalMs = {
    '15M': 15 * 60 * 1000,
    '1H': 60 * 60 * 1000,
    '4H': 4 * 60 * 60 * 1000,
    'Daily': 24 * 60 * 60 * 1000
  }[tf] || 15 * 60 * 1000;

  // Keep pages comfortably below provider limits. The important part is that
  // pagination never silently stops merely because one page is shorter than the
  // requested chunk: a short page can be a provider plan boundary rather than
  // the end of the symbol's history.
  const chunk = Math.min(5000, Number(process.env.HISTORY_PAGE_SIZE || 4500));
  const ttl = 6 * 60 * 60 * 1000;
  const all = new Map();
  const pages = [];
  const seenBoundaries = new Set();
  let endMs = null;
  let stoppedReason = 'target-reached';

  for (let page = 0; page < 80 && all.size < wanted; page++) {
    let url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=${encodeURIComponent(SYMBOL)}` +
      `&interval=${TF[tf]}` +
      `&outputsize=${chunk}` +
      `&timezone=UTC` +
      `&apikey=${key}`;

    if (endMs !== null) {
      url += `&end_date=${encodeURIComponent(formatProviderDate(endMs))}`;
    }

    const boundary = endMs === null ? 'latest' : formatProviderDate(endMs);
    const cacheKey = `engine-history-v5:${SYMBOL}:${tf}:${chunk}:${boundary}`;
    const result = await fetchJson(cacheKey, url, ttl);
    const data = result.data;

    if (!data || data.status === 'error' || !Array.isArray(data.values) || !data.values.length) {
      stoppedReason = data?.status === 'error' ? 'provider-error' : 'provider-no-more-data';
      break;
    }

    const bars = normalizeBars(data.values)
      .filter(b => Number.isFinite(b.time))
      .sort((a, b) => a.time - b.time);

    if (!bars.length) {
      stoppedReason = 'invalid-page';
      break;
    }

    const oldest = bars[0].time;
    const newest = bars[bars.length - 1].time;
    const pageKey = `${oldest}|${newest}`;

    if (seenBoundaries.has(pageKey)) {
      stoppedReason = 'repeated-page';
      break;
    }
    seenBoundaries.add(pageKey);

    const before = all.size;
    for (const bar of bars) all.set(bar.time, bar);
    const uniqueAdded = all.size - before;

    pages.push({
      page: page + 1,
      received: bars.length,
      uniqueAdded,
      oldest: new Date(oldest).toISOString(),
      newest: new Date(newest).toISOString()
    });

    if (all.size >= wanted) {
      stoppedReason = 'target-reached';
      break;
    }

    // Always continue from strictly before the oldest returned candle.
    // This is more reliable than relying on provider-side inclusive/exclusive
    // semantics around end_date.
    const nextEndMs = oldest - Math.max(1000, intervalMs / 10);
    if (endMs !== null && nextEndMs >= endMs) {
      stoppedReason = 'pagination-boundary-did-not-move';
      break;
    }
    endMs = nextEndMs;

    // If a short page still contains new history, continue. Only an empty page
    // or a repeated boundary is considered exhaustion.
  }

  const out = Array.from(all.values())
    .sort((a, b) => a.time - b.time)
    .slice(-wanted);

  const meta = {
    requested: wanted,
    returned: out.length,
    pages: pages.length,
    complete: out.length >= wanted,
    providerLimited: out.length < wanted && stoppedReason === 'provider-no-more-data',
    stoppedReason,
    oldest: out.length ? new Date(out[0].time).toISOString() : null,
    newest: out.length ? new Date(out[out.length - 1].time).toISOString() : null,
    pageDiagnostics: pages
  };

  Object.defineProperty(out, 'historyMeta', {
    value: meta,
    enumerable: false,
    configurable: false
  });

  historyDiagnostics.set(tf, meta);

  return out;
}

function getHistoryMeta(tf) {
  const meta = historyDiagnostics.get(tf);
  return meta ? JSON.parse(JSON.stringify(meta)) : null;
}

async function fetchFundamental() {
  const key = process.env.FRED_API_KEY;
  if (!key) return { available: false, bias: 'NEUTRAL', score: 0, items: [] };
  const series = { fed: 'FEDFUNDS', unemployment: 'UNRATE', cpi: 'CPIAUCSL', coreCpi: 'CPILFESL', payroll: 'PAYEMS' };
  try {
    const out = await Promise.all(Object.entries(series).map(async ([name, id]) => {
      const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=4`;
      const r = await fetch(u, { timeout: 8000 });
      if (!r.ok) return [name, null];
      const d = await r.json();
      const o = (d.observations || []).filter((x) => x.value !== '.');
      return [name, o];
    }));
    const vals = Object.fromEntries(out);
    let score = 0, items = [];
    const add = (name, s, why) => { score += s; items.push({ name, score: s, why }); };
    if (vals.cpi?.length >= 2) { const ch = +vals.cpi[0].value - +vals.cpi[1].value; add('CPI', ch > 0 ? -5 : 5, ch > 0 ? 'تورم رو به افزایش؛ فشار انقباضی برای طلا' : 'تورم رو به کاهش؛ فضای مساعدتر برای طلا'); }
    if (vals.coreCpi?.length >= 2) { const ch = +vals.coreCpi[0].value - +vals.coreCpi[1].value; add('Core CPI', ch > 0 ? -5 : 5, ch > 0 ? 'Core CPI بالاتر' : 'Core CPI پایین‌تر'); }
    if (vals.unemployment?.length >= 2) { const ch = +vals.unemployment[0].value - +vals.unemployment[1].value; add('Unemployment', ch > 0 ? 4 : -4, ch > 0 ? 'بیکاری بالاتر' : 'بیکاری پایین‌تر'); }
    if (vals.payroll?.length >= 2) { const ch = +vals.payroll[0].value - +vals.payroll[1].value; add('Payroll', ch < 0 ? 4 : -4, ch < 0 ? 'اشتغال ضعیف‌تر' : 'اشتغال قوی‌تر'); }
    const bias = score >= 6 ? 'BULLISH' : score <= -6 ? 'BEARISH' : 'NEUTRAL';
    return { available: true, bias, score: clamp(50 + score * 3, 0, 100), items };
  } catch (e) { return { available: false, bias: 'NEUTRAL', score: 0, items: [], error: 'fundamental-fetch-failed' }; }
}

async function fetchNewsRisk() {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return { blocked: false, available: false, reason: 'news-key-not-configured' };
  try {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${key}`, { timeout: 8000 });
    if (!r.ok) return { blocked: false, available: false, reason: 'news-provider-error' };
    const data = await r.json();
    const now = Date.now(), wm = Number(process.env.NEWS_BLOCK_MINUTES || 30) * 60000;
    const words = /fed|fomc|cpi|pce|nfp|nonfarm|payroll|interest rate|rate decision|powell|inflation|jobs report/i;
    const recent = (Array.isArray(data) ? data : []).filter((a) => {
      const ts = Number(a.datetime || 0) * 1000;
      return ts && Math.abs(now - ts) <= wm && words.test(`${a.headline || ''} ${a.summary || ''}`);
    });
    return { blocked: recent.length > 0, available: true, reason: recent.length ? 'high-impact-news-window' : null, articles: recent.slice(0, 5).map((a) => ({ headline: a.headline, source: a.source, url: a.url })) };
  } catch (e) { return { blocked: false, available: false, reason: 'news-network-error' }; }
}

// نسخه بدون شبکه برای بک‌تست — چون داده تاریخی خبر/فاندامنتال لحظه‌به‌لحظه در دسترس نیست،
// این عامل‌ها در بک‌تست خنثی/غیرفعال هستند (نه ساختگی) و این محدودیت به‌صراحت اعلام می‌شود.
function neutralFundamental() { return { available: false, bias: 'NEUTRAL', score: 50, items: [] }; }
function neutralNewsRisk() { return { blocked: false, available: false, reason: 'not-available-in-backtest' }; }

function getSession(timeMs) {
  const d = new Date(Number(timeMs));
  if (!Number.isFinite(d.getTime())) return 'UNKNOWN';
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (minutes < 8 * 60) return 'ASIA';
  if (minutes < 13 * 60) return 'LONDON';
  if (minutes < 17 * 60) return 'NEW_YORK';
  return 'NEW_YORK_LATE';
}

function trendBias(x) { if (x.price > x.ema20 && x.ema20 > x.ema50) return 1; if (x.price < x.ema20 && x.ema20 < x.ema50) return -1; return 0; }

function trendStrategy(d) {
  const h4 = trendBias(d.h4), d1 = trendBias(d.daily), h1 = trendBias(d.h1);
  const m = d.m15;
  const bars = m.bars || [];
  const atrValue = Number(m.atr || 0);
  const price = Number(m.price);

  const base = {
    name: 'روند چندتایم‌فریمی',
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

  if (!m || !Number.isFinite(price) || !Number.isFinite(atrValue) || atrValue <= 0) {
    return { ...base, reason: 'داده/ATR کافی برای Trend Following موجود نیست' };
  }
  if (h4 === 0 || d1 === 0 || h4 !== d1) {
    return { ...base, reason: 'Daily و 4H روند هم‌جهت و معتبر ندارند' };
  }

  const dir = h4 === 1 ? 'BUY' : 'SELL';
  const ema20 = Number(m.ema20 || price);
  const ema50 = Number(m.ema50 || ema20);
  const rrsi = Number(m.rsi || 50);
  const recent = bars.slice(-8);
  const prior = bars.slice(-13, -2);
  if (recent.length < 6 || prior.length < 6) {
    return { ...base, direction: dir, reason: 'برای تشخیص Pullback/Continuation داده 15M کافی نیست' };
  }

  // Pullback must actually interact with the trend's dynamic area; this avoids
  // chasing a candle that is already extended far from EMA20.
  const pullbackTouched = dir === 'BUY'
    ? recent.slice(0, -1).some(b => b.low <= ema20 + atrValue * 0.35)
    : recent.slice(0, -1).some(b => b.high >= ema20 - atrValue * 0.35);

  const priorHigh = Math.max(...prior.map(b => b.high));
  const priorLow = Math.min(...prior.map(b => b.low));
  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const continuation = dir === 'BUY'
    ? (last.close > prev.high || last.close > priorHigh)
    : (last.close < prev.low || last.close < priorLow);

  const healthyRsi = dir === 'BUY' ? rrsi >= 48 && rrsi <= 75 : rrsi >= 25 && rrsi <= 52;
  const emaAligned = dir === 'BUY'
    ? price > ema20 && ema20 >= ema50
    : price < ema20 && ema20 <= ema50;
  const notChasing = Math.abs(price - ema20) <= atrValue * 1.15;

  // 1H is a confirmation/quality factor, not a hard requirement. This keeps
  // the independent Trend engine from becoming as restrictive as consensus.
  const h1Confirm = h1 === h4;

  let confidence = 50;
  if (h4 === d1) confidence += 14;
  if (h1Confirm) confidence += 8;
  if (pullbackTouched) confidence += 12;
  if (continuation) confidence += 14;
  if (emaAligned) confidence += 8;
  if (healthyRsi) confidence += 6;
  if (notChasing) confidence += 5;
  confidence = Math.round(clamp(confidence));

  const setup = pullbackTouched && emaAligned && healthyRsi && notChasing;
  const triggered = setup && continuation;

  if (!setup) {
    return {
      ...base,
      status: 'WATCH',
      vote: dir,
      direction: dir,
      confidence,
      reason: `روند ${dir === 'BUY' ? 'صعودی' : 'نزولی'} است اما Pullback/شرایط ورود کامل نشده`,
      trigger: dir === 'BUY' ? '15M کلوز بالای سقف Trigger پس از Pullback' : '15M کلوز زیر کف Trigger پس از Pullback'
    };
  }

  if (!triggered) {
    return {
      ...base,
      status: 'SETUP',
      vote: dir,
      direction: dir,
      confidence,
      reason: `روند ${dir === 'BUY' ? 'صعودی' : 'نزولی'} + Pullback معتبر؛ منتظر Continuation 15M`,
      trigger: dir === 'BUY' ? `کلوز 15M بالای ${fmt(prev.high)}` : `کلوز 15M زیر ${fmt(prev.low)}`
    };
  }

  // Strategy-specific trade construction: SL is behind the actual pullback
  // invalidation, not an arbitrary fixed ATR distance.
  const pullbackBars = recent.slice(0, -1);
  const pullbackLow = Math.min(...pullbackBars.map(b => b.low));
  const pullbackHigh = Math.max(...pullbackBars.map(b => b.high));
  let sl, risk;
  if (dir === 'BUY') {
    sl = pullbackLow - atrValue * 0.15;
    const minStop = Math.max(MIN_STOP_USD, atrValue * MIN_STOP_ATR);
    if (price - sl < minStop) sl = price - minStop;
    risk = price - sl;
  } else {
    sl = pullbackHigh + atrValue * 0.15;
    const minStop = Math.max(MIN_STOP_USD, atrValue * MIN_STOP_ATR);
    if (sl - price < minStop) sl = price + minStop;
    risk = sl - price;
  }

  // Do not manufacture a trade when the next structural level leaves no room.
  const levels = nearestLevels(price, dir, d);
  const structuralTarget = dir === 'BUY' ? levels.nextResistance : levels.nextSupport;
  const minTarget = dir === 'BUY' ? price + risk * MIN_RR : price - risk * MIN_RR;
  const hasSpace = dir === 'BUY'
    ? (!structuralTarget || structuralTarget >= minTarget)
    : (!structuralTarget || structuralTarget <= minTarget);
  if (!hasSpace) {
    return {
      ...base,
      status: 'SETUP',
      vote: dir,
      direction: dir,
      confidence: Math.min(confidence, 69),
      reason: 'Trend فعال است ولی فضای کافی تا سطح ساختاری بعدی برای R:R مطلوب وجود ندارد',
      trigger: 'پس از ایجاد فضای کافی دوباره بررسی شود'
    };
  }

  const tp1 = structuralTarget && ((dir === 'BUY' && structuralTarget >= minTarget) || (dir === 'SELL' && structuralTarget <= minTarget))
    ? structuralTarget
    : minTarget;
  const tp2 = dir === 'BUY' ? price + risk * 2.4 : price - risk * 2.4;
  const tp3 = dir === 'BUY' ? price + risk * 3.2 : price - risk * 3.2;
  const rr = Math.abs(tp1 - price) / risk;

  return {
    ...base,
    status: 'ACTIVE',
    vote: dir,
    direction: dir,
    confidence,
    reason: `Trend ${dir === 'BUY' ? 'BUY' : 'SELL'}: Daily+4H هم‌جهت، Pullback و Continuation تأیید شد`,
    trigger: dir === 'BUY' ? `کلوز 15M بالای ${fmt(prev.high)}` : `کلوز 15M زیر ${fmt(prev.low)}`,
    entry: { low: fmt(price - atrValue * 0.05), high: fmt(price + atrValue * 0.05) },
    stopLoss: fmt(sl),
    targets: [fmt(tp1), fmt(tp2), fmt(tp3)],
    rr: fmt(rr),
    invalidation: dir === 'BUY' ? `کلوز 15M زیر ${fmt(pullbackLow)}` : `کلوز 15M بالای ${fmt(pullbackHigh)}`,
    levels
  };
}

function independentTradeStrategy(base, d, dir, confidence, reason, trigger) {
  if (!['BUY','SELL'].includes(dir)) return null;
  const trade = buildTrade(d, dir);
  const a = Number(d.m15.atr || 0);
  const p = Number(d.m15.price);
  const stopDist = Math.abs(p - Number(trade?.stopLoss));
  const stopAtr = a > 0 ? stopDist / a : 0;
  const safeRR = Number(trade?.rr || 0) >= MIN_RR;
  const safeStop = stopAtr >= MIN_STOP_ATR && stopAtr <= MAX_STOP_ATR;
  const active = safeRR && safeStop;
  return {
    name: base.name,
    strategyId: base.strategyId,
    status: active ? 'ACTIVE' : 'SETUP',
    vote: dir,
    direction: dir,
    confidence: Math.round(clamp(confidence)),
    weight: 0,
    reason: safeStop ? reason : `${reason}؛ حدضرر خارج محدوده ATR مجاز است`,
    trigger,
    entry: trade.entry,
    stopLoss: trade.stopLoss,
    targets: trade.targets,
    rr: trade.rr,
    invalidation: trade.invalidation || null,
    levels: trade.levels || null
  };
}

function structureStrategy(d) {
  const v = d.m15.structure === 'BULLISH_BOS' ? 'BUY' : d.m15.structure === 'BEARISH_BOS' ? 'SELL' : 'WAIT';
  if (v === 'WAIT') return { name:'ساختار بازار (BOS/CHoCH)', strategyId:'STRUCTURE', status:'WATCH', vote:'NEUTRAL', direction:'WAIT', confidence:0, weight:0, reason:'BOS معتبر با Close و displacement شکل نگرفته' };

  const td = v === 'BUY' ? 1 : -1;
  const mom = v === 'BUY' ? d.m15.rsi >= 52 && d.m15.price > d.m15.ema20 : d.m15.rsi <= 48 && d.m15.price < d.m15.ema20;
  const h4 = trendBias(d.h4), d1 = trendBias(d.daily);
  let c = 68;
  if (mom) c += 10;
  if (h4 === td) c += 8;
  if (d1 === td) c += 8;
  const trig = v === 'BUY'
    ? 'BOS صعودی معتبر: Close بالای ساختار + displacement + RSI>52 + بالای EMA20'
    : 'BOS نزولی معتبر: Close زیر ساختار + displacement + RSI<48 + زیر EMA20';
  if (!mom) return { name:'ساختار بازار (BOS/CHoCH)', strategyId:'STRUCTURE', status:'SETUP', vote:v, direction:v, confidence:Math.round(clamp(c)), weight:0, reason:'BOS معتبر است ولی مومنتوم هنوز تأیید کامل نیست', trigger:trig };
  return independentTradeStrategy({name:'ساختار بازار (BOS/CHoCH)',strategyId:'STRUCTURE'}, d, v, c, v==='BUY'?'BOS معتبر + displacement + مومنتوم صعودی':'BOS معتبر + displacement + مومنتوم نزولی', trig);
}

function sweepStrategy(d) {
  const v = d.m15.sweep === 'SWEEP_LOW' ? 'BUY' : d.m15.sweep === 'SWEEP_HIGH' ? 'SELL' : 'WAIT';
  if (v === 'WAIT') return { name:'Liquidity Sweep (SMC)', strategyId:'LIQUIDITY_SWEEP', status:'WATCH', vote:'NEUTRAL', direction:'WAIT', confidence:0, weight:0, reason:'Sweep فعال وجود ندارد' };
  const bars = d.m15.bars || [];
  const last = bars[bars.length - 1], prev = bars[bars.length - 2];
  const a = Number(d.m15.atr || 0);
  const bodyOk = last && prev && a > 0 && Math.abs(last.close - last.open) >= a * 0.15;
  const mom = v === 'BUY'
    ? d.m15.price > d.m15.ema20 && d.m15.rsi > 50 && bodyOk && last.close >= prev.close
    : d.m15.price < d.m15.ema20 && d.m15.rsi < 50 && bodyOk && last.close <= prev.close;
  let c = 68 + (mom ? 15 : 0);
  const trig = v === 'BUY' ? 'Sweep Low + reclaim + کلوز 15M بالای EMA20' : 'Sweep High + reclaim + کلوز 15M زیر EMA20';
  if (!mom) return { name:'Liquidity Sweep (SMC)', strategyId:'LIQUIDITY_SWEEP', status:'SETUP', vote:v, direction:v, confidence:c, weight:0, reason:'Sweep انجام شده ولی reclaim/momentum کامل نیست', trigger:trig };
  return independentTradeStrategy({name:'Liquidity Sweep (SMC)',strategyId:'LIQUIDITY_SWEEP'}, d, v, c, v==='BUY'?'Sweep Low و reclaim صعودی':'Sweep High و reclaim نزولی', trig);
}

function momentumStrategy(d) {
  const m=d.m15;
  const buy=m.price>m.ema20 && m.rsi>52 && m.rsi<72;
  const sell=m.price<m.ema20 && m.rsi<48 && m.rsi>28;
  if (!buy && !sell) return { name:'مومنتوم (RSI + EMA20)', strategyId:'MOMENTUM', status:'WATCH', vote:'NEUTRAL', direction:'WAIT', confidence:0, weight:0, reason:'مومنتوم خنثی یا افراطی است' };
  const dir=buy?'BUY':'SELL';
  const h4=trendBias(d.h4), d1=trendBias(d.daily), h1=trendBias(d.h1), td=dir==='BUY'?1:-1;
  let c=70;
  if(h4===td)c+=8; if(d1===td)c+=8; if(h1===td)c+=5;
  const trig=dir==='BUY'?'قیمت بالای EMA20 + RSI>52 و زیر 72':'قیمت زیر EMA20 + RSI<48 و بالای 28';
  return independentTradeStrategy({name:'مومنتوم (RSI + EMA20)',strategyId:'MOMENTUM'},d,dir,c,dir==='BUY'?'مومنتوم صعودی سالم':'مومنتوم نزولی سالم',trig);
}

function fibonacciStrategy(d, fib) {
  if (!fib || !['BUY','SELL'].includes(fib.vote) || !fib.confirmed) {
    return { name:'Fibonacci Retracement', strategyId:'FIBONACCI', status:'WATCH', vote:'NEUTRAL', direction:'WAIT', confidence:0, weight:0, contextVote:fib?.vote||'NEUTRAL', reason:fib?.reason||'فیبوناچی Trigger معتبر ندارد' };
  }
  const dir=fib.vote;
  const aligned=dir==='BUY' ? d.m15.price>d.m15.ema20 && d.m15.rsi>50 : d.m15.price<d.m15.ema20 && d.m15.rsi<50;
  let c=74+(aligned?10:0);
  const trig=dir==='BUY'
    ? 'واکنش 38.2–61.8% + reclaim 50% + Close صعودی + EMA20/RSI'
    : 'واکنش 38.2–61.8% + rejection زیر 50% + Close نزولی + EMA20/RSI';
  if(!aligned) return { name:'Fibonacci Retracement',strategyId:'FIBONACCI',status:'SETUP',vote:dir,direction:dir,confidence:c,weight:0,contextVote:dir,reason:'واکنش فیبوناچی شکل گرفته ولی مومنتوم هم‌جهت نیست',trigger:trig };
  return independentTradeStrategy({name:'Fibonacci Retracement',strategyId:'FIBONACCI'},d,dir,c,fib.reason,trig);
}

function divergenceStrategy(d, div) {
  if (!div || !['BUY','SELL'].includes(div.vote)) return { name:'واگرایی RSI',strategyId:'RSI_DIVERGENCE',status:'WATCH',vote:'NEUTRAL',direction:'WAIT',confidence:0,weight:0,contextVote:div?.vote||'NEUTRAL',reason:div?.reason||'واگرایی Trigger معتبر ندارد' };
  const dir=div.vote;
  const aligned=dir==='BUY' ? d.m15.price>d.m15.ema20 && d.m15.rsi>45 : d.m15.price<d.m15.ema20 && d.m15.rsi<55;
  let c=70+(aligned?12:0);
  const trig=dir==='BUY'?'واگرایی صعودی + reclaim EMA20':'واگرایی نزولی + rejection زیر EMA20';
  if(!aligned) return {name:'واگرایی RSI',strategyId:'RSI_DIVERGENCE',status:'SETUP',vote:dir,direction:dir,confidence:c,weight:0,contextVote:dir,reason:'واگرایی وجود دارد ولی reclaim/momentum کامل نیست',trigger:trig};
  return independentTradeStrategy({name:'واگرایی RSI',strategyId:'RSI_DIVERGENCE'},d,dir,c,div.reason,trig);
}

function fundamentalStrategy(d, fund) {
  const v=fund?.bias==='BULLISH'?'BUY':fund?.bias==='BEARISH'?'SELL':'WAIT';
  if(v==='WAIT') return {name:'فاندامنتال (FRED)',strategyId:'FUNDAMENTAL',status:'WATCH',vote:'NEUTRAL',direction:'WAIT',confidence:0,weight:0,reason:'فاندامنتال جهت مستقل فعال ندارد'};
  const c=68+Math.min(20,Math.abs(Number(fund.score||50)-50));
  return independentTradeStrategy({name:'فاندامنتال (FRED)',strategyId:'FUNDAMENTAL'},d,v,c,'بایاس فاندامنتال '+v,'فاندامنتال هم‌جهت + تأیید قیمت/ریسک')
}

// Finds the most recent contiguous block of 15M bars whose timestamps fall in
// the ASIA session (00:00-08:00 UTC), scanning backward from the newest bar.
// Used as the reference range for the session breakout strategy below.
function lastAsiaSessionBars(bars) {
  const out = [];
  for (let i = bars.length - 1; i >= 0; i--) {
    const session = getSession(bars[i].time);
    if (session === 'ASIA') {
      out.unshift(bars[i]);
    } else if (out.length) {
      break;
    }
  }
  return out;
}

function sessionBreakoutStrategy(d) {
  const name = 'بریک‌اوت رنج سشن آسیا', strategyId = 'SESSION_BREAKOUT';
  const base = { name, strategyId, status: 'WATCH', vote: 'NEUTRAL', direction: 'WAIT', confidence: 0, weight: 0, reason: '' };
  const m = d.m15;
  const bars = m?.bars || [];
  const atrValue = Number(m?.atr || 0);
  const price = Number(m?.price);
  if (!m || bars.length < 40 || !Number.isFinite(price) || !Number.isFinite(atrValue) || atrValue <= 0) {
    return { ...base, reason: 'داده 15M کافی برای محاسبه رنج سشن آسیا موجود نیست' };
  }

  const lastBar = bars[bars.length - 1];
  const curSession = getSession(lastBar.time);
  if (curSession === 'ASIA') {
    return { ...base, reason: 'در سشن آسیا هستیم؛ رنج هنوز در حال شکل‌گیری است' };
  }

  const asiaBars = lastAsiaSessionBars(bars.slice(0, -1));
  if (asiaBars.length < 10) {
    return { ...base, reason: 'رنج کامل سشن آسیا در داده موجود قابل بازسازی نیست' };
  }

  const asiaHigh = Math.max(...asiaBars.map(b => b.high));
  const asiaLow = Math.min(...asiaBars.map(b => b.low));
  const rangeSize = asiaHigh - asiaLow;
  if (!(rangeSize > 0)) {
    return { ...base, reason: 'رنج سشن آسیا معتبر نیست' };
  }
  // A very wide Asia range (relative to ATR) makes a "breakout" of it far less
  // meaningful, so we only treat tight/compressed ranges as valid setups.
  const tight = rangeSize <= atrValue * 4;

  const prevBar = bars[bars.length - 2];
  const brokeUp = lastBar.close > asiaHigh && prevBar && prevBar.close <= asiaHigh;
  const brokeDown = lastBar.close < asiaLow && prevBar && prevBar.close >= asiaLow;
  if (!brokeUp && !brokeDown) {
    return {
      ...base,
      status: 'SETUP',
      reason: `رنج آسیا (${fmt(asiaLow)}-${fmt(asiaHigh)}) شکل گرفته؛ منتظر شکست معتبر`,
      trigger: `کلوز 15M بالای ${fmt(asiaHigh)} یا زیر ${fmt(asiaLow)}`
    };
  }

  const dir = brokeUp ? 'BUY' : 'SELL';
  const rsi = Number(m.rsi || 50);
  const ema20 = Number(m.ema20 || price);
  const momentumOk = dir === 'BUY' ? (price > ema20 && rsi > 50) : (price < ema20 && rsi < 50);
  const h4 = trendBias(d.h4), h1 = trendBias(d.h1), td = dir === 'BUY' ? 1 : -1;

  let c = 66;
  if (tight) c += 8;
  if (momentumOk) c += 12;
  if (h4 === td) c += 6;
  if (h1 === td) c += 6;
  c = Math.round(clamp(c));

  const trig = dir === 'BUY'
    ? `کلوز 15M بالای سقف رنج آسیا (${fmt(asiaHigh)})`
    : `کلوز 15M زیر کف رنج آسیا (${fmt(asiaLow)})`;

  if (!momentumOk) {
    return { ...base, status: 'SETUP', vote: dir, direction: dir, confidence: c, reason: 'شکست رنج آسیا رخ داده ولی مومنتوم هنوز هم‌جهت نیست', trigger: trig };
  }

  return independentTradeStrategy(
    { name, strategyId },
    d, dir, c,
    dir === 'BUY' ? 'شکست معتبر سقف رنج آسیا با تأیید مومنتوم' : 'شکست معتبر کف رنج آسیا با تأیید مومنتوم',
    trig
  );
}

function volatilitySqueezeStrategy(d) {
  const name = 'شکست فشردگی نوسان (Bollinger)', strategyId = 'VOLATILITY_SQUEEZE';
  const base = { name, strategyId, status: 'WATCH', vote: 'NEUTRAL', direction: 'WAIT', confidence: 0, weight: 0, reason: '' };
  const m = d.m15;
  const bars = m?.bars || [];
  const atrValue = Number(m?.atr || 0);
  const price = Number(m?.price);
  const BB_PERIOD = 20, LOOKBACK = 60, SQUEEZE_LAG = 6;
  if (!m || bars.length < BB_PERIOD + LOOKBACK + SQUEEZE_LAG || !Number.isFinite(price) || !Number.isFinite(atrValue) || atrValue <= 0) {
    return { ...base, reason: 'داده 15M کافی برای محاسبه باند بولینگر موجود نیست' };
  }

  // 20-period SMA/stddev Bollinger Band (2σ) ending at bar index `end`.
  function bollingerAt(end) {
    const slice = bars.slice(end - BB_PERIOD + 1, end + 1);
    const closes = slice.map(b => b.close);
    const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
    const variance = closes.reduce((a, b) => a + (b - sma) * (b - sma), 0) / closes.length;
    const sd = Math.sqrt(variance);
    return { sma, sd, upper: sma + sd * 2, lower: sma - sd * 2, width: sma > 0 ? (sd * 4) / sma : 0 };
  }

  const lastIdx = bars.length - 1;
  const current = bollingerAt(lastIdx);
  const prevBand = bollingerAt(lastIdx - 1);

  // A "squeeze" is graded by how tight the band was a few bars before the
  // breakout candle, relative to its own recent history (not an absolute
  // number, since normal band width varies by period/volatility regime).
  const widths = [];
  for (let i = lastIdx - SQUEEZE_LAG; i >= BB_PERIOD - 1 && widths.length < LOOKBACK; i--) {
    widths.push(bollingerAt(i).width);
  }
  if (widths.length < 20) {
    return { ...base, reason: 'تاریخچه کافی برای سنجش فشردگی نوسان موجود نیست' };
  }
  const preBreakoutWidth = widths[0];
  const rank = widths.filter(w => w <= preBreakoutWidth).length / widths.length;
  const wasSqueezed = rank <= 0.30;

  const lastBar = bars[lastIdx];
  const prevBar = bars[lastIdx - 1];
  const brokeUp = lastBar.close > current.upper && prevBar.close <= prevBand.upper;
  const brokeDown = lastBar.close < current.lower && prevBar.close >= prevBand.lower;

  if (!wasSqueezed || (!brokeUp && !brokeDown)) {
    return {
      ...base,
      status: 'SETUP',
      reason: wasSqueezed ? 'فشردگی نوسان شکل گرفته؛ منتظر شکست معتبر باند' : 'فشردگی نوسان کافی برای اعتبار شکست شکل نگرفته',
      trigger: 'کلوز 15M بیرون از باند بولینگر (۲ انحراف معیار) پس از فشردگی'
    };
  }

  const dir = brokeUp ? 'BUY' : 'SELL';
  const rsi = Number(m.rsi || 50);
  const ema20 = Number(m.ema20 || price);
  const momentumOk = dir === 'BUY' ? (price > ema20 && rsi > 52) : (price < ema20 && rsi < 48);
  const h4 = trendBias(d.h4), h1 = trendBias(d.h1), td = dir === 'BUY' ? 1 : -1;

  let c = 66 + Math.round((1 - rank) * 10);
  if (momentumOk) c += 12;
  if (h4 === td) c += 5;
  if (h1 === td) c += 5;
  c = Math.round(clamp(c));

  const trig = dir === 'BUY'
    ? 'کلوز 15M بالای باند بالایی بولینگر پس از فشردگی نوسان'
    : 'کلوز 15M زیر باند پایینی بولینگر پس از فشردگی نوسان';

  if (!momentumOk) {
    return { ...base, status: 'SETUP', vote: dir, direction: dir, confidence: c, reason: 'شکست باند رخ داده ولی مومنتوم هنوز هم‌جهت نیست', trigger: trig };
  }

  return independentTradeStrategy(
    { name, strategyId },
    d, dir, c,
    dir === 'BUY' ? 'شکست معتبر باند بالایی بولینگر پس از فشردگی نوسان' : 'شکست معتبر باند پایینی بولینگر پس از فشردگی نوسان',
    trig
  );
}

function runStrategies(d, fund) {
  const trend = trendStrategy(d);
  const structure = structureStrategy(d);
  const sweep = sweepStrategy(d);
  const momentum = momentumStrategy(d);
  const fib = fibZone(d);
  const fibonacci = fibonacciStrategy(d, fib);
  const div = divergence(d.m15.bars);
  const divergenceS = divergenceStrategy(d, div);
  const fundamental = fundamentalStrategy(d, fund);
  const sessionBreakout = sessionBreakoutStrategy(d);
  const volatilitySqueeze = volatilitySqueezeStrategy(d);
  const strategies = [trend, structure, sweep, momentum, fibonacci, divergenceS, fundamental, sessionBreakout, volatilitySqueeze];
  const active = strategies.filter(s=>s.status==='ACTIVE');
  // RSI_DIVERGENCE (and anything else in DIAGNOSTIC_ONLY_STRATEGY_IDS) still runs
  // and still shows up in `active`/context for confluence and diagnostics, but is
  // never picked as the live trigger — see getIndependentSignals for why.
  const triggerCandidates = active.filter(s => !DIAGNOSTIC_ONLY_STRATEGY_IDS.has(s.strategyId));
  return {
    strategies,
    volumeConfirmed: !!d.m15.volumeState.confirmed,
    triggerStrategy: triggerCandidates[0] || null,
    context: { fib, divergence:div, sweep:{vote:sweep.vote}, structure:{vote:structure.vote}, h4Trend:trendBias(d.h4), d1Trend:trendBias(d.daily), h1Trend:trendBias(d.h1) }
  };
}

// Kept only as a compatibility helper for older API consumers. It does NOT
// participate in the new decision path and never creates a signal.
function computeConsensus(strategies, volumeConfirmed) {
  const active = strategies.filter(s => s.status === 'ACTIVE');
  const trigger = active[0] || null;
  return {
    mode: 'INDEPENDENT_STRATEGIES',
    dir: trigger?.direction || 'WAIT',
    confidence: trigger?.confidence || 0,
    triggerStrategy: trigger?.strategyId || null,
    activeStrategies: active.map(s => s.strategyId),
    agreeCount: active.length,
    totalCount: strategies.length,
    volumeConfirmed: !!volumeConfirmed
  };
}

function marketRegime(d) {
  const h4Trend=trendBias(d.h4), d1Trend=trendBias(d.daily), m=d.m15;
  const aligned = h4Trend !== 0 && h4Trend === d1Trend;
  const atr = m.atr || 0;
  const rangeWidth = (m.range?.high || 0) - (m.range?.low || 0);
  const atrPct = m.price ? atr / m.price : 0;
  if (aligned && atr > 0) return {name:'TREND', score:2, reason:'4H و Daily هم‌جهت‌اند'};
  if (rangeWidth > 0 && atr > 0 && rangeWidth / atr < 10) return {name:'RANGE', score:-1, reason:'محدوده نسبتاً فشرده در برابر ATR'};
  return {name:'TRANSITION', score:0, reason:'روند و رنج هم‌زمان شفاف نیستند', atrPct};
}

function scoreSignalQuality(d, consensus, context, trade, news) {
  let score = 45;
  const reasons = [];
  const penalties = [];
  const dir = consensus.dir;
  const reg = marketRegime(d);

  // Quality is a graded execution-quality layer. It does NOT create direction
  // and it does not change the Base signal; backtest mode can explicitly bypass
  // this layer to compare Base vs Quality.
  if (reg.name === 'TREND') { score += 8; reasons.push('رژیم روندی'); }
  else if (reg.name === 'RANGE') { score -= 3; penalties.push('رژیم رنج'); }
  else { score -= 1; penalties.push('رژیم Transition'); }

  const structure = context?.structure?.vote || 'NEUTRAL';
  const sweep = context?.sweep?.vote || 'NEUTRAL';

  if (structure === dir) { score += 12; reasons.push('ساختار 15M هم‌جهت'); }
  else if (structure === 'NEUTRAL') { score -= 4; penalties.push('ساختار 15M خنثی'); }
  else { score -= 8; penalties.push('ساختار خلاف جهت'); }

  if (sweep === dir) { score += 15; reasons.push('Liquidity Sweep هم‌جهت'); }
  else if (sweep === 'NEUTRAL') { score -= 4; penalties.push('Sweep تأیید نشده'); }
  else { score -= 10; penalties.push('Sweep خلاف جهت'); }

  const momentumDir =
    (d.m15.rsi > 50 && d.m15.rsi < 72 && d.m15.price > d.m15.ema20) ? 'BUY' :
    (d.m15.rsi < 50 && d.m15.rsi > 28 && d.m15.price < d.m15.ema20) ? 'SELL' : 'NEUTRAL';

  if (momentumDir === dir) { score += 8; reasons.push('مومنتوم سالم'); }
  else { score -= 4; penalties.push('مومنتوم تأیید نمی‌کند'); }

  const h4Trend = trendBias(d.h4);
  const d1Trend = trendBias(d.daily);
  if ((dir === 'BUY' && h4Trend === 1 && d1Trend === 1) ||
      (dir === 'SELL' && h4Trend === -1 && d1Trend === -1)) {
    score += 8; reasons.push('4H و Daily هم‌جهت');
  } else if ((dir === 'BUY' && (h4Trend === 1 || d1Trend === 1)) ||
             (dir === 'SELL' && (h4Trend === -1 || d1Trend === -1))) {
    score += 3; reasons.push('یکی از تایم‌فریم‌های بالا هم‌جهت است');
  } else {
    score -= 6; penalties.push('تایم‌فریم‌های بالا خلاف جهت‌اند');
  }

  if (consensus.agreeCount >= 4) { score += 5; reasons.push('اجماع فعال مناسب'); }
  else if (consensus.agreeCount >= 3) score += 2;
  else { score -= 5; penalties.push('اجماع ضعیف'); }

  if (consensus.confidence >= 85) score += 4;
  else if (consensus.confidence >= 80) score += 3;
  else if (consensus.confidence < 75) score -= 3;

  if (consensus.volumeConfirmed) { score += 3; reasons.push('حجم تأییدکننده'); }

  const fibVote = context?.fib?.vote || 'NEUTRAL';
  if (fibVote === dir) { score += 2; reasons.push('Fibonacci هم‌جهت'); }
  else if (fibVote !== 'NEUTRAL') score -= 1;

  const divVote = context?.divergence?.vote || 'NEUTRAL';
  if (divVote === dir) { score += 2; reasons.push('واگرایی هم‌جهت'); }
  else if (divVote !== 'NEUTRAL') score -= 1;

  const rr = Number(trade?.rr || 0);
  if (rr >= 2.5) score += 5;
  else if (rr >= 2.0) score += 4;
  else if (rr >= MIN_RR) score += 2;
  else { score -= 12; penalties.push(`R:R کمتر از ${MIN_RR}`); }

  if (news?.blocked) { score -= 30; penalties.push('خبر پرریسک'); }

  const atrValue = Number(d.m15.atr || 0);
  const price = Number(d.m15.price);
  if (atrValue > 0 && Number.isFinite(trade?.stopLoss)) {
    const stopDistance = Math.abs(price - Number(trade.stopLoss));
    const stopAtr = stopDistance / atrValue;
    if (stopAtr >= 0.8 && stopAtr <= 2.8) score += 4;
    else if (stopAtr < 0.6) { score -= 8; penalties.push('حد ضرر بیش از حد نزدیک'); }
    else if (stopAtr > 3.5) { score -= 3; penalties.push('حد ضرر بسیار بزرگ'); }
  }

  // Entry distance acts as a spread/slippage proxy. It is deliberately soft:
  // this is not real spread because TwelveData OHLC has no bid/ask history.
  if (atrValue > 0 && trade?.entry) {
    const entryMid = (Number(trade.entry.low) + Number(trade.entry.high)) / 2;
    const entryDistanceAtr = Math.abs(entryMid - price) / atrValue;
    if (entryDistanceAtr > MAX_SPREAD_PROXY_ATR) {
      score -= 8;
      penalties.push(`فاصله ورود از قیمت فعلی > ${MAX_SPREAD_PROXY_ATR} ATR`);
    }
  }

  score = Math.round(clamp(score));
  let grade = 'POOR';
  if (score >= 85) grade = 'EXCELLENT';
  else if (score >= 75) grade = 'GOOD';
  else if (score >= 65) grade = 'FAIR';

  const tradable = score >= 65 && !news?.blocked;
  return {
    score,
    grade,
    tradable,
    regime: reg,
    reasons: [...new Set(reasons)],
    penalties: [...new Set(penalties)],
    blockers: [...new Set(penalties.filter(x =>
      /خبر|R:R|ضرر|خلاف جهت|فاصله ورود/.test(x)
    ))]
  };
}

function nearestLevels(price, dir, d) {
  const levels = [...d.m15.pivots.highs, ...d.m15.pivots.lows, d.h1.range.high, d.h1.range.low, d.h4.range.high, d.h4.range.low, d.daily.range.high, d.daily.range.low].filter(Number.isFinite);
  const above = [...new Set(levels.filter((x) => x > price + 0.15))].sort((a, b) => a - b);
  const below = [...new Set(levels.filter((x) => x < price - 0.15))].sort((a, b) => b - a);
  return { nextResistance: above[0] || null, nextSupport: below[0] || null };
}

function buildTrade(d, dir) {
  const p=d.m15.price, a=Math.max(d.m15.atr || 2, 1.5), levels=nearestLevels(p,dir,d);
  let entryLow,entryHigh,sl,tp1,tp2,tp3,trigger;
  if(dir==='BUY'){
    const support=Math.max(d.m15.range.low,d.m15.ema20||d.m15.range.low);
    entryLow=Math.max(d.m15.range.low,p-a*0.35);
    entryHigh=Math.min(p+a*0.12,support+a*0.30);
    if(entryHigh<entryLow) entryHigh=entryLow+a*0.12;
    sl=Math.min(d.m15.range.low-a*0.20,p-a*1.05);
    if(levels.nextSupport && levels.nextSupport<entryLow) sl=Math.min(sl,levels.nextSupport-a*0.12);
    const minStop=Math.max(MIN_STOP_USD,a*MIN_STOP_ATR);
    if(entryHigh-sl<minStop) sl=entryHigh-minStop;
    const risk=entryHigh-sl;
    const structuralTarget=levels.nextResistance && levels.nextResistance>entryHigh ? levels.nextResistance : Infinity;
    const rTarget=entryHigh+risk*MIN_RR;
    tp1=Math.max(rTarget, entryHigh+risk*1.8);
    if(structuralTarget!==Infinity && structuralTarget>=rTarget) tp1=structuralTarget;
    tp2=entryHigh+risk*2.4; tp3=entryHigh+risk*3.2;
    trigger='15M: Sweep Low ترجیحاً + BOS/CHoCH صعودی + کلوز بالای EMA20 + RSI>50';
  } else {
    const resistance=Math.min(d.m15.range.high,d.m15.ema20||d.m15.range.high);
    entryHigh=Math.min(d.m15.range.high,p+a*0.35);
    entryLow=Math.max(p-a*0.12,resistance-a*0.30);
    if(entryLow>entryHigh) entryLow=entryHigh-a*0.12;
    sl=Math.max(d.m15.range.high+a*0.20,p+a*1.05);
    if(levels.nextResistance && levels.nextResistance>entryHigh) sl=Math.max(sl,levels.nextResistance+a*0.12);
    const minStop=Math.max(MIN_STOP_USD,a*MIN_STOP_ATR);
    if(sl-entryLow<minStop) sl=entryLow+minStop;
    const risk=sl-entryLow;
    const structuralTarget=levels.nextSupport && levels.nextSupport<entryLow ? levels.nextSupport : -Infinity;
    const rTarget=entryLow-risk*MIN_RR;
    tp1=Math.min(rTarget, entryLow-risk*1.8);
    if(structuralTarget!==-Infinity && structuralTarget<=rTarget) tp1=structuralTarget;
    tp2=entryLow-risk*2.4; tp3=entryLow-risk*3.2;
    trigger='15M: Sweep High ترجیحاً + BOS/CHoCH نزولی + کلوز زیر EMA20 + RSI<50';
  }
  const rr=dir==='BUY'?(tp1-entryHigh)/(entryHigh-sl):(entryLow-tp1)/(sl-entryLow);
  return {entry:{low:fmt(entryLow),high:fmt(entryHigh)},stopLoss:fmt(sl),targets:[fmt(tp1),fmt(tp2),fmt(tp3)],rr:fmt(rr),trigger,levels};
}

function evaluateIndependentQuality(signal, d, result) {
  if (!signal || !['BUY','SELL'].includes(signal.direction)) return { tradable:false, score:0, grade:'POOR', reasons:[], blockers:['بدون Trigger'] };
  const dir = signal.direction;
  const blockers = [];
  const reasons = [];
  let score = 60;
  const h4 = trendBias(d.h4), d1 = trendBias(d.daily);
  const td = dir === 'BUY' ? 1 : -1;
  if (h4 === td && d1 === td) { score += 15; reasons.push('4H و Daily هم‌جهت'); }
  else if (h4 === td || d1 === td) { score += 7; reasons.push('یکی از تایم‌فریم‌های بالا هم‌جهت'); }
  else { score -= 10; blockers.push('تایم‌فریم بالاتر خلاف جهت'); }

  const m = d.m15;
  const momentumOk = dir === 'BUY'
    ? m.price > m.ema20 && m.rsi > 50 && m.rsi < 75
    : m.price < m.ema20 && m.rsi < 50 && m.rsi > 25;
  if (momentumOk) { score += 10; reasons.push('مومنتوم هم‌جهت'); }
  else { score -= 8; blockers.push('مومنتوم تأیید نمی‌کند'); }

  const aligned = (result?.active || []).filter(x => x.strategyId !== signal.strategyId && x.direction === dir).length;
  if (aligned >= 2) { score += 10; reasons.push('حداقل دو موتور مستقل هم‌جهت'); }
  else if (aligned === 1) { score += 4; reasons.push('یک موتور مستقل هم‌جهت'); }

  const a = Number(m.atr || 0);
  const stopDist = Math.abs(Number(m.price) - Number(signal.stopLoss));
  const stopAtr = a > 0 ? stopDist / a : 0;
  if (!(stopAtr >= MIN_STOP_ATR && stopAtr <= MAX_STOP_ATR)) blockers.push('حد ضرر خارج از محدوده ATR مجاز');
  else score += 5;

  const rr = Number(signal.rr || 0);
  if (rr < MIN_RR) blockers.push(`R:R کمتر از ${MIN_RR}`);
  else if (rr >= 2.2) { score += 5; reasons.push('فضای سود مناسب'); }
  else score += 2;

  score = Math.round(clamp(score));
  // Quality is intentionally a soft gate: it rejects only clearly conflicted
  // setups, not every trade lacking perfect confluence.
  const tradable = score >= 68 && blockers.length <= 1 && rr >= MIN_RR && stopAtr >= MIN_STOP_ATR && stopAtr <= MAX_STOP_ATR;
  const grade = score >= 85 ? 'EXCELLENT' : score >= 75 ? 'GOOD' : score >= 68 ? 'FAIR' : 'POOR';
  return { tradable, score, grade, reasons, blockers };
}

// Strategies in this set still run, still cast a vote in strategyVotes/context,
// and still count toward confluence — but they no longer open their own
// independent position. Backtest data showed RSI_DIVERGENCE's own directional
// calls (BUY/SELL) underperform its own NEUTRAL baseline (net R roughly -34 vs
// +14 across ~327 independent trades on the 2026-05..09 sample), i.e. the
// signal is actively counter-predictive as a standalone trigger. Demoting it
// to context-only removed that drag without touching any other strategy's
// trades (positions are independent per strategy).
const DIAGNOSTIC_ONLY_STRATEGY_IDS = new Set(['RSI_DIVERGENCE', 'VOLATILITY_SQUEEZE']);

function getIndependentSignals(d, fund, news = {}) {
  const { strategies, volumeConfirmed, context } = runStrategies(d, fund);
  const active = strategies.filter(s =>
    s.status === 'ACTIVE' &&
    ['BUY', 'SELL'].includes(s.direction) &&
    !DIAGNOSTIC_ONLY_STRATEGY_IDS.has(s.strategyId)
  );
  return { strategies, active, volumeConfirmed, context };
}

function decide(d, fund, news, options = {}) {
  const {strategies, volumeConfirmed, context, triggerStrategy}=runStrategies(d,fund);
  const trend = strategies.find(s => s.strategyId === 'TREND_FOLLOWING');
  const activeStrategies = strategies.filter(s => s.status === 'ACTIVE');

  // Independent architecture: every strategy may trigger on its own.
  // No weighted consensus is required; corroborating strategies are quality context only.
  const signal = triggerStrategy;
  const dir = signal?.direction || 'WAIT';
  const trade = signal?.status === 'ACTIVE' ? {
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    targets: signal.targets,
    rr: signal.rr,
    trigger: signal.trigger,
    invalidation: signal.invalidation,
    levels: signal.levels
  } : buildTrade(d, dir === 'WAIT' ? (trend?.direction || 'BUY') : dir);
  if (!signal) trade.isHypothetical = true;

  const blockers=[];
  if (!signal) blockers.push(trend?.status === 'SETUP' ? 'Trend setup تشکیل شده ولی Trigger هنوز فعال نشده' : 'هیچ استراتژی مستقل فعلاً Trigger فعال ندارد');
  if (news?.blocked) blockers.push('خبر پرریسک در پنجره نزدیک');
  if (signal?.rr < MIN_RR) blockers.push(`R:R کمتر از ${MIN_RR}`);

  const confidence = signal?.confidence || 0;
  const reg = marketRegime(d);
  const quality = {
    score: confidence,
    grade: confidence >= 85 ? 'EXCELLENT' : confidence >= 75 ? 'GOOD' : confidence >= 65 ? 'FAIR' : 'POOR',
    tradable: !!signal && confidence >= MIN_CONFIDENCE && !news?.blocked && Number(signal.rr || 0) >= MIN_RR,
    regime: reg,
    reasons: signal ? [signal.reason] : [],
    penalties: blockers,
    blockers: blockers
  };

  const consensus = computeConsensus(strategies, volumeConfirmed);
  // Preserve a small compatibility surface for the existing backtest/UI,
  // while explicitly marking that these are NOT votes.
  consensus.dir = dir;
  consensus.confidence = confidence;
  consensus.triggerStrategy = signal?.strategyId || null;
  consensus.activeStrategies = activeStrategies.map(s=>s.strategyId);

  const hardActive = !!signal && signal.status === 'ACTIVE' && confidence >= MIN_CONFIDENCE && blockers.length === 0;
  const active = options.ignoreQuality ? hardActive : (hardActive && quality.tradable);
  return {
    decision: active ? dir : 'WAIT',
    direction: dir,
    confidence,
    scores: { buy: dir === 'BUY' ? confidence : 0, sell: dir === 'SELL' ? confidence : 0 },
    consensus,
    architecture: 'INDEPENDENT_STRATEGIES',
    triggerStrategy: signal?.strategyId || null,
    regime: quality.regime,
    quality,
    strategies,
    trade,
    blockers,
    fundamental: fund,
    newsRisk: news,
    diagnostics: {
      independent: true,
      activeStrategies: activeStrategies.map(s=>s.strategyId),
      activeStrategyEngines: activeStrategies.map(s=>s.strategyId),
      allEnginesCanTrigger: true,
      otherEnginesAreDiagnosticOnly: false
    }
  };
}

module.exports = {
  SYMBOL, TF, MIN_CONFIDENCE, MIN_RR,
  analyze, decide, getIndependentSignals, evaluateIndependentQuality, fetchTF, fetchTFHistory, getHistoryMeta, getSession, fetchFundamental, fetchNewsRisk, neutralFundamental, neutralNewsRisk
};
