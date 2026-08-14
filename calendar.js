// /api/calendar — تقویم اقتصادی
// این‌جا محل اتصال به یک سرویس تقویم اقتصادی واقعی است، مثلاً:
//  - financialmodelingprep.com/api/v3/economic_calendar
//  - TradingEconomics API
//  - Finnhub /calendar/economic
// کلید API را در .env با نام ECONOMIC_CALENDAR_API_KEY قرار بده.

const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

router.get('/', async (req, res) => {
  const apiKey = process.env.ECONOMIC_CALENDAR_API_KEY;
  if (!apiKey) {
    return res.json({ status: 'UNAVAILABLE', error: 'no-api-key-configured', events: [] });
  }
  try {
    // نمونه: financialmodelingprep
    const url = `https://financialmodelingprep.com/api/v3/economic_calendar?apikey=${apiKey}`;
    const r = await fetch(url, { timeout: 8000 });
    if (!r.ok) return res.json({ status: 'UNAVAILABLE', error: `provider-http-${r.status}`, events: [] });
    const data = await r.json();
    res.json({ status: 'LIVE', events: data });
  } catch (e) {
    res.json({ status: 'UNAVAILABLE', error: 'proxy-exception', events: [] });
  }
});

module.exports = router;
