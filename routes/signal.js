// Gold Hunter — Decision Engine (v3: Transparent Multi-Strategy Consensus)
// هر استراتژی جداگانه رأی خودش (BUY/SELL/NEUTRAL) را با دلیل می‌دهد؛ یک لایه اجماع
// این رأی‌ها را با وزن مشخص جمع می‌زند و تصمیم نهایی BUY/SELL/WAIT را می‌سازد.
// هیچ استراتژی به‌تنهایی تصمیم‌گیرنده نیست — خروجی `strategies` همه رأی‌ها را شفاف نشان می‌دهد.

const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

const SYMBOL = process.env.XAU_SYMBOL || 'XAU/USD';
const TF = { '15M': '15min', '1H': '1h', '4H': '4h', 'Daily': '1day' };
const MIN_CONFIDENCE = Number(process.env.MIN_SIGNAL_CONFIDENCE || 72);
const MIN_RR = Number(process.env.MIN_SIGNAL_RR || 1.8);
const MAX_SPREAD_PROXY_ATR = Number(process.env.MAX_ENTRY_ATR_DISTANCE || 0.55);

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
  const x = b.slice(-12), p = b.slice(-24, -12);
  if (x.length < 8 || p.length < 8) return 'MIXED';
  const h = Math.max(...x.map(v => v.high)), l = Math.min(...x.map(v => v.low));
  const ph = Math.max(...p.map(v => v.high)), pl = Math.min(...p.map(v => v.low));
  if (h > ph && l > pl) return 'BULLISH_BOS';
  if (h < ph && l < pl) return 'BEARISH_BOS';
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

// --- Fibonacci Retracement: آیا قیمت در ناحیه طلایی (38.2%-61.8%) اصلاح یک سوئینگ اخیر نشسته؟ ---
function fibZone(d) {
  const piv = d.m15.pivots;
  if (!piv.highs.length || !piv.lows.length) return { vote: 'NEUTRAL', reason: 'داده کافی برای تشخیص سوئینگ فیبوناچی نیست' };
  const swingHigh = Math.max(...piv.highs.slice(-3));
  const swingLow = Math.min(...piv.lows.slice(-3));
  const span = swingHigh - swingLow;
  if (!(span > 0)) return { vote: 'NEUTRAL', reason: 'محدوده سوئینگ نامعتبر است' };
  const price = d.m15.price;
  const retFromHigh = (swingHigh - price) / span;
  const retFromLow = (price - swingLow) / span;
  const inGoldenFromHigh = retFromHigh >= 0.382 && retFromHigh <= 0.618;
  const inGoldenFromLow = retFromLow >= 0.382 && retFromLow <= 0.618;
  if (d.m15.price > d.m15.ema20 && inGoldenFromHigh) return { vote: 'BUY', reason: `اصلاح تا ناحیه طلایی فیبوناچی (${Math.round(retFromHigh * 100)}%) در روند صعودی` };
  if (d.m15.price < d.m15.ema20 && inGoldenFromLow) return { vote: 'SELL', reason: `اصلاح تا ناحیه طلایی فیبوناچی (${Math.round(retFromLow * 100)}%) در روند نزولی` };
  return { vote: 'NEUTRAL', reason: 'قیمت در ناحیه کلیدی فیبوناچی قرار ندارد' };
}

// --- واگرایی RSI: مقایسه سقف/کف قیمت با سقف/کف RSI در دو نیمه اخیر بازه ---
function divergence(bars) {
  if (!bars || bars.length < 30) return { vote: 'NEUTRAL', reason: 'داده کافی برای واگرایی نیست' };
  const closes = bars.map((b) => b.close);
  const series = [];
  for (let i = Math.max(14, closes.length - 40); i < closes.length; i++) {
    series.push({ price: closes[i], rsi: rsi(closes.slice(0, i + 1), 14) });
  }
  if (series.length < 16) return { vote: 'NEUTRAL', reason: 'داده کافی برای واگرایی نیست' };
  const half = Math.floor(series.length / 2);
  const first = series.slice(0, half), second = series.slice(half);
  const firstMax = first.reduce((a, b) => (b.price > a.price ? b : a));
  const secondMax = second.reduce((a, b) => (b.price > a.price ? b : a));
  const firstMin = first.reduce((a, b) => (b.price < a.price ? b : a));
  const secondMin = second.reduce((a, b) => (b.price < a.price ? b : a));
  if (secondMax.price > firstMax.price && secondMax.rsi < firstMax.rsi) return { vote: 'SELL', reason: 'واگرایی نزولی: سقف قیمتی جدیدتر بالاتر، ولی RSI پایین‌تر' };
  if (secondMin.price < firstMin.price && secondMin.rsi > firstMin.rsi) return { vote: 'BUY', reason: 'واگرایی صعودی: کف قیمتی جدیدتر پایین‌تر، ولی RSI بالاتر' };
  return { vote: 'NEUTRAL', reason: 'واگرایی مشخصی بین قیمت و RSI دیده نمی‌شود' };
}

function analyze(b) {
  const last = b[b.length - 1], m = momentum(b), a = atr(b), sr = range(b), pv = pivots(b), vol = volumeState(b);
  return { price: last.close, ema20: m.ema20, ema50: m.ema50, rsi: m.rsi, atr: a, structure: structure(b), sweep: sweepSignal(b), range: sr, pivots: pv, volume: last.volume, volumeState: vol, bars: b };
}

async function fetchTF(tf, limit = 220) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return null;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=${TF[tf]}&outputsize=${limit}&apikey=${key}`;
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d || d.status === 'error' || !Array.isArray(d.values) || !d.values.length) return null;
  return d.values.map((v) => ({ time: new Date(v.datetime).getTime(), open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: v.volume ? +v.volume : 0 })).reverse();
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

function trendBias(x) { if (x.price > x.ema20 && x.ema20 > x.ema50) return 1; if (x.price < x.ema20 && x.ema20 < x.ema50) return -1; return 0; }

// --- هر استراتژی جدا رأی خودش را با وزن و دلیل می‌دهد — هیچ‌کدام به‌تنهایی تصمیم‌گیرنده نیست ---
function runStrategies(d, fund) {
  const strategies = [];

  const h4 = trendBias(d.h4), d1 = trendBias(d.daily), h1 = trendBias(d.h1);
  let trendVote = 'NEUTRAL', trendReason = 'تایم‌فریم‌های بالا (4H/Daily) هم‌جهت نیستند';
  if (h4 === 1 && d1 === 1) { trendVote = 'BUY'; trendReason = 'هم‌جهتی 4H و Daily صعودی' + (h1 === 1 ? ' + تأیید 1H' : ''); }
  else if (h4 === -1 && d1 === -1) { trendVote = 'SELL'; trendReason = 'هم‌جهتی 4H و Daily نزولی' + (h1 === -1 ? ' + تأیید 1H' : ''); }
  strategies.push({ name: 'روند چندتایم‌فریمی', vote: trendVote, weight: 30, reason: trendReason });

  strategies.push({
    name: 'ساختار بازار (BOS/CHoCH)',
    vote: d.m15.structure === 'BULLISH_BOS' ? 'BUY' : d.m15.structure === 'BEARISH_BOS' ? 'SELL' : 'NEUTRAL',
    weight: 14,
    reason: d.m15.structure === 'BULLISH_BOS' ? 'شکست ساختار صعودی در 15M' : d.m15.structure === 'BEARISH_BOS' ? 'شکست ساختار نزولی در 15M' : 'ساختار 15M نامشخص/آمیخته'
  });

  strategies.push({
    name: 'Liquidity Sweep (SMC)',
    vote: d.m15.sweep === 'SWEEP_LOW' ? 'BUY' : d.m15.sweep === 'SWEEP_HIGH' ? 'SELL' : 'NEUTRAL',
    weight: 18,
    reason: d.m15.sweep === 'SWEEP_LOW' ? 'شکار نقدینگی زیر کف اخیر و بازگشت قیمت' : d.m15.sweep === 'SWEEP_HIGH' ? 'شکار نقدینگی بالای سقف اخیر و بازگشت قیمت' : 'شکار نقدینگی رخ نداده است'
  });

  const momVote = (d.m15.rsi > 50 && d.m15.rsi < 72 && d.m15.price > d.m15.ema20) ? 'BUY' : (d.m15.rsi < 50 && d.m15.rsi > 28 && d.m15.price < d.m15.ema20) ? 'SELL' : 'NEUTRAL';
  strategies.push({
    name: 'مومنتوم (RSI + EMA20)', vote: momVote, weight: 12,
    reason: momVote === 'BUY' ? `RSI (${fmt(d.m15.rsi)}) و موقعیت نسبت به EMA20 صعودی است` : momVote === 'SELL' ? `RSI (${fmt(d.m15.rsi)}) و موقعیت نسبت به EMA20 نزولی است` : 'مومنتوم خنثی یا در ناحیه افراطی است'
  });

  const fib = fibZone(d);
  strategies.push({ name: 'Fibonacci Retracement', vote: fib.vote, weight: 10, reason: fib.reason });

  const div = divergence(d.m15.bars);
  strategies.push({ name: 'واگرایی RSI', vote: div.vote, weight: 8, reason: div.reason });

  const fundVote = fund.bias === 'BULLISH' ? 'BUY' : fund.bias === 'BEARISH' ? 'SELL' : 'NEUTRAL';
  strategies.push({
    name: 'فاندامنتال (FRED)', vote: fundVote, weight: 8,
    reason: fund.items && fund.items.length ? fund.items.map((i) => i.why).join('، ') : 'داده فاندامنتال کافی برای نتیجه‌گیری نیست'
  });

  // حجم مستقل جهت‌دار نیست — فقط اگر جهت غالب را «تقویت» کند در امتیاز اعمال می‌شود، نه به‌عنوان یک رأی جدا.
  const volumeConfirmed = d.m15.volumeState.confirmed;

  return { strategies, volumeConfirmed };
}

// --- لایه اجماع: رأی‌های وزن‌دار همه استراتژی‌ها را جمع می‌زند؛ تصمیم را خودِ اجماع می‌سازد ---
function computeConsensus(strategies, volumeConfirmed) {
  let buyWeight = 0, sellWeight = 0, buyCount = 0, sellCount = 0, neutralCount = 0;
  strategies.forEach((s) => {
    if (s.vote === 'BUY') { buyWeight += s.weight; buyCount++; }
    else if (s.vote === 'SELL') { sellWeight += s.weight; sellCount++; }
    else neutralCount++;
  });
  const totalWeight = strategies.reduce((a, s) => a + s.weight, 0);
  const dir = buyWeight > sellWeight ? 'BUY' : sellWeight > buyWeight ? 'SELL' : 'WAIT';
  // حجم فقط تقویت‌کننده جهت غالب است، نه یک رأی مستقل
  let volumeBonus = 0;
  if (volumeConfirmed && dir !== 'WAIT') volumeBonus = 5;
  const netWeight = Math.abs(buyWeight - sellWeight);
  const confidence = clamp(50 + (netWeight / totalWeight) * 100 * 0.9 + volumeBonus);
  const agreeCount = dir === 'BUY' ? buyCount : dir === 'SELL' ? sellCount : Math.max(buyCount, sellCount);
  return { dir, buyWeight: fmt(buyWeight), sellWeight: fmt(sellWeight), totalWeight: fmt(totalWeight), confidence: fmt(confidence), agreeCount, totalCount: strategies.length, neutralCount, volumeConfirmed };
}

function nearestLevels(price, dir, d) {
  const levels = [...d.m15.pivots.highs, ...d.m15.pivots.lows, d.h1.range.high, d.h1.range.low, d.h4.range.high, d.h4.range.low, d.daily.range.high, d.daily.range.low].filter(Number.isFinite);
  const above = [...new Set(levels.filter((x) => x > price + 0.15))].sort((a, b) => a - b);
  const below = [...new Set(levels.filter((x) => x < price - 0.15))].sort((a, b) => b - a);
  return { nextResistance: above[0] || null, nextSupport: below[0] || null };
}

function buildTrade(d, dir) {
  const p = d.m15.price, a = d.m15.atr || 2, levels = nearestLevels(p, dir, d);
  let entryLow, entryHigh, sl, tp1, tp2, tp3, trigger;
  const sweep = dir === 'BUY' ? d.m15.sweep === 'SWEEP_LOW' : d.m15.sweep === 'SWEEP_HIGH';
  if (dir === 'BUY') {
    const support = Math.max(d.m15.range.low, d.m15.ema20 || d.m15.range.low);
    entryLow = Math.max(d.m15.range.low, p - a * MAX_SPREAD_PROXY_ATR);
    entryHigh = Math.min(p + a * .20, support + a * .35);
    if (entryHigh < entryLow) entryHigh = entryLow + a * .15;
    sl = Math.min(d.m15.range.low - a * .25, p - a * 1.15);
    if (levels.nextSupport && levels.nextSupport < entryLow) sl = Math.min(sl, levels.nextSupport - a * .15);
    const risk = entryHigh - sl, rTarget = entryHigh + risk * MIN_RR;
    tp1 = levels.nextResistance && levels.nextResistance > entryHigh ? Math.min(levels.nextResistance, rTarget) : rTarget;
    tp2 = entryHigh + risk * 2.4; tp3 = entryHigh + risk * 3.2;
    trigger = sweep ? '15M Sweep Low + CHoCH/BOS صعودی + کلوز بالای EMA20 + RSI>50 + حجم تأیید' : '15M CHoCH/BOS صعودی + کلوز بالای EMA20 + RSI>50 + حجم تأیید';
  } else {
    const resistance = Math.min(d.m15.range.high, d.m15.ema20 || d.m15.range.high);
    entryHigh = Math.min(d.m15.range.high, p + a * MAX_SPREAD_PROXY_ATR);
    entryLow = Math.max(p - a * .20, resistance - a * .35);
    if (entryLow > entryHigh) entryLow = entryHigh - a * .15;
    sl = Math.max(d.m15.range.high + a * .25, p + a * 1.15);
    if (levels.nextResistance && levels.nextResistance > entryHigh) sl = Math.max(sl, levels.nextResistance + a * .15);
    const risk = sl - entryLow, rTarget = entryLow - risk * MIN_RR;
    tp1 = levels.nextSupport && levels.nextSupport < entryLow ? Math.max(levels.nextSupport, rTarget) : rTarget;
    tp2 = entryLow - risk * 2.4; tp3 = entryLow - risk * 3.2;
    trigger = sweep ? '15M Sweep High + CHoCH/BOS نزولی + کلوز زیر EMA20 + RSI<50 + حجم تأیید' : '15M CHoCH/BOS نزولی + کلوز زیر EMA20 + RSI<50 + حجم تأیید';
  }
  const rr = dir === 'BUY' ? (tp1 - entryHigh) / (entryHigh - sl) : (entryLow - tp1) / (sl - entryLow);
  return { entry: { low: fmt(entryLow), high: fmt(entryHigh) }, stopLoss: fmt(sl), targets: [fmt(tp1), fmt(tp2), fmt(tp3)], rr: fmt(rr), trigger, levels };
}

function decide(d, fund, news) {
  const { strategies, volumeConfirmed } = runStrategies(d, fund);
  const consensus = computeConsensus(strategies, volumeConfirmed);
  const dir = consensus.dir;

  // حتی وقتی اجماع کاملاً خنثی است (dir=WAIT)، یک سناریوی فرضی بر اساس سمتی که (هرچند به‌سختی)
  // امتیاز بالاتری دارد ساخته می‌شود — تا همیشه یک Entry/SL/TP برای نمایش/ارسال دستی وجود داشته باشد.
  const tradeDir = dir === 'WAIT' ? (consensus.buyWeight >= consensus.sellWeight ? 'BUY' : 'SELL') : dir;
  const trade = buildTrade(d, tradeDir);
  if (dir === 'WAIT') trade.isHypothetical = true;

  const blockers = [];
  if (consensus.agreeCount < Math.ceil(consensus.totalCount / 2)) blockers.push(`اجماع کافی نیست (فقط ${consensus.agreeCount} از ${consensus.totalCount} استراتژی هم‌جهت‌اند)`);
  if (d.m15.structure === 'MIXED') blockers.push('ساختار 15M شفاف نیست');
  if (d.m15.rsi >= 72 || d.m15.rsi <= 28) blockers.push('Momentum در ناحیه افراطی است');
  if (news.blocked) blockers.push('خبر پرریسک در پنجره زمانی نزدیک');
  if (trade && trade.rr < MIN_RR) blockers.push(`R:R کمتر از ${MIN_RR}`);
  if (dir === 'BUY' && d.h4.price < d.h4.ema20 && d.daily.price < d.daily.ema20) blockers.push('4H و Daily هر دو خلاف BUY هستند');
  if (dir === 'SELL' && d.h4.price > d.h4.ema20 && d.daily.price > d.daily.ema20) blockers.push('4H و Daily هر دو خلاف SELL هستند');

  const active = dir !== 'WAIT' && consensus.confidence >= MIN_CONFIDENCE && blockers.length === 0;
  return {
    decision: active ? dir : 'WAIT', direction: dir, confidence: consensus.confidence,
    scores: { buy: consensus.buyWeight, sell: consensus.sellWeight },
    consensus: { agreeCount: consensus.agreeCount, totalCount: consensus.totalCount, volumeConfirmed },
    strategies, trade, blockers, fundamental: fund, newsRisk: news
  };
}

router.get('/', async (req, res) => {
  if (!process.env.TWELVEDATA_API_KEY) return res.json({ status: 'UNAVAILABLE', error: 'no-api-key-configured' });
  try {
    const [m15, h1, h4, d1, fund, news] = await Promise.all([fetchTF('15M'), fetchTF('1H'), fetchTF('4H'), fetchTF('Daily'), fetchFundamental(), fetchNewsRisk()]);
    if (!m15 || !h1 || !h4 || !d1) return res.json({ status: 'UNAVAILABLE', error: 'market-data-unavailable' });
    const data = { m15: analyze(m15), h1: analyze(h1), h4: analyze(h4), daily: analyze(d1) };
    const signal = decide(data, fund, news);
    res.json({ status: 'LIVE', provider: 'TwelveData', symbol: SYMBOL, fetchedAt: new Date().toISOString(), market: { price: data.m15.price, timeframes: data }, signal });
  } catch (e) { res.json({ status: 'UNAVAILABLE', error: 'signal-engine-exception' }); }
});

module.exports = router;
