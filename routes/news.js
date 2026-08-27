// /api/news — خبرهای واقعی مرتبط با طلا از Finnhub (کلید رایگان جدا: FINNHUB_API_KEY)
//
// مهم: این بخش «تحلیل هوش مصنوعی» نیست. فقط یک برچسب‌گذاری ساده بر اساس وجود چند کلمه کلیدی
// در تیتر/خلاصه خبر انجام می‌دهد (مثلاً "rate cut" یا "dovish" → گرایش مثبت برای طلا).
// این یک تحلیل زبانی واقعی نیست و ممکن است اشتباه کند — فقط یک راهنمای اولیه سریع است.
// خود خبر واقعی و لینک آن همیشه همراه برچسب نمایش داده می‌شود تا کاربر خودش قضاوت کند.

const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

const RELEVANCE_KEYWORDS = /gold|fed(eral reserve)?|fomc|inflation|cpi|pce|dollar|dxy|yield|treasury|oil|opec|geopolit|war|iran|israel|rate cut|rate hike|hawkish|dovish|nonfarm|payroll|jobless|interest rate/i;
const BULLISH_KEYWORDS = /rate cut|dovish|cuts rates|cutting rates|weak(er)? (jobs|inflation|labor)|geopolitical tension|safe.haven|gold ral|gold surg|gold jump|gold climb/i;
const BEARISH_KEYWORDS = /rate hike|hawkish|raises rates|raising rates|strong(er)? (jobs|inflation|labor)|yields? (rise|surge|jump|climb)|dollar (strengthens|rallies|surges)|gold (falls|drops|slides|slumps)/i;

function tagArticle(text) {
  const bullish = BULLISH_KEYWORDS.test(text);
  const bearish = BEARISH_KEYWORDS.test(text);
  if (bullish && !bearish) return 'bullish';
  if (bearish && !bullish) return 'bearish';
  return 'neutral';
}

router.get('/', async (req, res) => {
  // اگر کلید Finnhub تازه (FINNHUB_API_KEY) تنظیم نشده، از کلید قدیمی که قبلاً برای تقویم استفاده
  // می‌شد هم به‌عنوان جایگزین استفاده می‌کنیم — تا کسی که قبلاً این کلید را ست کرده مجبور نباشد دوباره تنظیمش کند.
  const apiKey = process.env.FINNHUB_API_KEY || process.env.ECONOMIC_CALENDAR_API_KEY;
  if (!apiKey) return res.json({ status: 'UNAVAILABLE', error: 'no-api-key-configured', articles: [] });
  try {
    const url = `https://finnhub.io/api/v1/news?category=general&token=${apiKey}`;
    const r = await fetch(url, { timeout: 8000 });
    if (!r.ok) return res.json({ status: 'UNAVAILABLE', error: `provider-http-${r.status}`, articles: [] });
    const data = await r.json();
    if (!Array.isArray(data)) return res.json({ status: 'UNAVAILABLE', error: 'provider-empty-response', articles: [] });

    const relevant = data.filter((a) => RELEVANCE_KEYWORDS.test(`${a.headline || ''} ${a.summary || ''}`));
    const articles = relevant.slice(0, 15).map((a) => ({
      headline: a.headline || '',
      source: a.source || '',
      url: a.url || '',
      datetime: a.datetime ? new Date(a.datetime * 1000).toISOString() : null,
      tag: tagArticle(`${a.headline || ''} ${a.summary || ''}`)
    }));

    res.json({ status: 'LIVE', articles });
  } catch (e) {
    res.json({ status: 'UNAVAILABLE', error: 'proxy-exception', articles: [] });
  }
});

module.exports = router;
