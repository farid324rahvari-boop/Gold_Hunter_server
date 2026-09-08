// /api/signal — سیگنال زنده روزانه؛ از موتور مشترک lib/engine.js استفاده می‌کند
// (همان منطقی که در /api/signal/backtest هم اجرا می‌شود — نه یک نسخه جداگانه).

const express = require('express');
const router = express.Router();
const engine = require('../lib/engine');

router.get('/', async (req, res) => {
  if (!process.env.TWELVEDATA_API_KEY) return res.json({ status: 'UNAVAILABLE', error: 'no-api-key-configured' });
  try {
    const [m15, h1, h4, d1, fund, news] = await Promise.all([
      engine.fetchTF('15M'), engine.fetchTF('1H'), engine.fetchTF('4H'), engine.fetchTF('Daily'),
      engine.fetchFundamental(), engine.fetchNewsRisk()
    ]);
    if (!m15 || !h1 || !h4 || !d1) return res.json({ status: 'UNAVAILABLE', error: 'market-data-unavailable' });
    const data = { m15: engine.analyze(m15), h1: engine.analyze(h1), h4: engine.analyze(h4), daily: engine.analyze(d1) };
    const signal = engine.decide(data, fund, news);
    res.json({ status: 'LIVE', provider: 'TwelveData', symbol: engine.SYMBOL, fetchedAt: new Date().toISOString(), market: { price: data.m15.price, timeframes: data }, signal });
  } catch (e) { res.json({ status: 'UNAVAILABLE', error: 'signal-engine-exception' }); }
});

module.exports = router;
