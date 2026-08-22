// /api/fundamentals — داده‌های واقعی کلان اقتصادی از FRED (پایگاه رسمی فدرال‌رزرو، همیشه رایگان)
// کلید رایگان: fredaccount.stlouisfed.org/apikeys
//
// برخلاف یک «تقویم» با پیش‌بینی/واقعی، FRED آخرین مقدار واقعی هر شاخص را می‌دهد —
// همان چیزی که برای نرخ بهره، تورم، اشتغال و بیکاری لازم است.

const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

const SERIES = {
  fedFundsRate: { id: 'FEDFUNDS', label: 'نرخ بهره فدرال رزرو', unit: '%' },
  unemploymentRate: { id: 'UNRATE', label: 'نرخ بیکاری', unit: '%' },
  cpi: { id: 'CPIAUCSL', label: 'CPI (شاخص، نه درصد)', unit: '' },
  coreCpi: { id: 'CPILFESL', label: 'Core CPI (شاخص، نه درصد)', unit: '' },
  nonfarmPayroll: { id: 'PAYEMS', label: 'اشتغال غیرکشاورزی (هزار نفر)', unit: 'K' }
};

async function fetchSeries(seriesId, apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=3`;
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) return null;
  const data = await r.json();
  const obs = (data.observations || []).filter((o) => o.value !== '.');
  if (!obs.length) return null;
  return obs; // [most recent, previous, ...] چون sort_order=desc
}

router.get('/', async (req, res) => {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return res.json({ status: 'UNAVAILABLE', error: 'no-api-key-configured', indicators: {} });

  try {
    const keys = Object.keys(SERIES);
    const results = await Promise.all(keys.map((k) => fetchSeries(SERIES[k].id, apiKey)));

    const indicators = {};
    let anySuccess = false;
    keys.forEach((k, i) => {
      const obs = results[i];
      if (!obs) { indicators[k] = { status: 'UNAVAILABLE', label: SERIES[k].label }; return; }
      anySuccess = true;
      const latest = parseFloat(obs[0].value);
      const previous = obs[1] ? parseFloat(obs[1].value) : null;
      indicators[k] = {
        status: 'LIVE', label: SERIES[k].label, unit: SERIES[k].unit,
        value: latest, date: obs[0].date,
        previousValue: previous, previousDate: obs[1] ? obs[1].date : null,
        change: previous != null ? Math.round((latest - previous) * 1000) / 1000 : null
      };
    });

    if (!anySuccess) return res.json({ status: 'UNAVAILABLE', error: 'all-series-failed', indicators: {} });
    res.json({ status: 'LIVE', indicators });
  } catch (e) {
    res.json({ status: 'UNAVAILABLE', error: 'proxy-exception', indicators: {} });
  }
});

module.exports = router;
