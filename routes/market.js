// /api/market/quote?symbol=XAU/USD
// /api/market/ohlc?symbol=XAU/USD&timeframe=4H&limit=200
//
// این فایل محل واقعی اتصال به Data Provider است.
// پیاده‌سازی نمونه برای TwelveData آورده شده — اگر از سرویس دیگری استفاده می‌کنی
// (Metals-API, GoldAPI, Polygon, ...)، فقط تابع fetchQuoteFromProvider /
// fetchOHLCFromProvider را با تماس API واقعی همان سرویس جایگزین کن.
// ساختار پاسخ به فرانت‌اند (status/price/...) را همینطور نگه دار تا UI بدون تغییر کار کند.

const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

const TF_MAP = { '15M': '15min', '1H': '1h', '4H': '4h', 'Daily': '1day', 'Weekly': '1week' };

async function fetchQuoteFromProvider(symbol) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) return { status: 'UNAVAILABLE', error: 'no-api-key-configured' };

  // از اندپوینت /quote (نه /price) استفاده می‌کنیم چون علاوه بر قیمت، تغییر روزانه،
  // درصد تغییر، بیشترین/کمترین امروز را هم می‌دهد — دقیقاً چیزی که داشبورد نیاز دارد.
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) return { status: 'UNAVAILABLE', error: `provider-http-${r.status}` };
  const data = await r.json();
  if (data && data.status === 'error') return { status: 'UNAVAILABLE', error: `twelvedata: ${data.message || data.code || 'unknown-error'}` };
  if (!data || !data.close) return { status: 'UNAVAILABLE', error: 'provider-empty-response' };

  const price = parseFloat(data.close);
  const change = data.change != null ? parseFloat(data.change) : 0;
  const changePercent = data.percent_change != null ? parseFloat(data.percent_change) : 0;
  const high = data.high != null ? parseFloat(data.high) : price;
  const low = data.low != null ? parseFloat(data.low) : price;

  return {
    status: 'LIVE',
    symbol,
    price, change, changePercent, high, low,
    fetchedAt: new Date().toISOString()
  };
}

async function fetchOHLCFromProvider(symbol, timeframe, limit) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) return { status: 'UNAVAILABLE', error: 'no-api-key-configured' };
  const interval = TF_MAP[timeframe] || '4h';

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${limit || 200}&apikey=${apiKey}`;
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) return { status: 'UNAVAILABLE', error: `provider-http-${r.status}` };
  const data = await r.json();
  // TwelveData گاهی خطا را با HTTP 200 برمی‌گرداند (مثلاً {"status":"error","message":"..."})؛
  // پیام واقعی را برای دیباگ راحت‌تر برمی‌گردانیم، نه فقط یک خطای عمومی.
  if (data && data.status === 'error') return { status: 'UNAVAILABLE', error: `twelvedata: ${data.message || data.code || 'unknown-error'}` };
  if (!data || !Array.isArray(data.values) || data.values.length === 0) return { status: 'UNAVAILABLE', error: 'provider-empty-or-no-data' };

  const bars = data.values
    .map((v) => ({
      time: Math.floor(new Date(v.datetime).getTime() / 1000),
      open: parseFloat(v.open), high: parseFloat(v.high),
      low: parseFloat(v.low), close: parseFloat(v.close),
      volume: v.volume ? parseFloat(v.volume) : 0
    }))
    .reverse();

  return { status: 'LIVE', symbol, timeframe, bars };
}

router.get('/quote', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XAU/USD';
    const result = await fetchQuoteFromProvider(symbol);
    res.json(result);
  } catch (e) {
    res.json({ status: 'UNAVAILABLE', error: 'proxy-exception' });
  }
});

router.get('/ohlc', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XAU/USD';
    const timeframe = req.query.timeframe || '4H';
    const limit = parseInt(req.query.limit, 10) || 200;
    const result = await fetchOHLCFromProvider(symbol, timeframe, limit);
    res.json(result);
  } catch (e) {
    res.json({ status: 'UNAVAILABLE', error: 'proxy-exception' });
  }
});

module.exports = router;
