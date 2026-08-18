// /api/calendar — تقویم اقتصادی واقعی از Finnhub (رایگان، بدون کارت بانکی)
// کلید رایگان: finnhub.io/register → Dashboard → API Key
// کلید را در .env با نام ECONOMIC_CALENDAR_API_KEY قرار بده.

const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

// تبدیل تاریخ میلادی به شمسی (الگوریتم استاندارد، بدون نیاز به کتابخانه خارجی)
function toJalali(gy, gm, gd) {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  jy += Math.floor((days - 1) / 365);
  if (days > 365) days = (days - 1) % 365;
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  const toFa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  return `${toFa(jy)}/${toFa(String(jm).padStart(2, '0'))}/${toFa(String(jd).padStart(2, '0'))}`;
}

function mapImpact(impact) {
  const s = String(impact || '').toLowerCase();
  if (s === '3' || s === 'high') return 'high';
  if (s === '2' || s === 'medium') return 'medium';
  return 'low';
}

router.get('/', async (req, res) => {
  const apiKey = process.env.ECONOMIC_CALENDAR_API_KEY;
  if (!apiKey) {
    return res.json({ status: 'UNAVAILABLE', error: 'no-api-key-configured', events: [] });
  }
  try {
    const today = new Date();
    // بازه شامل ۷ روز گذشته (تا Actual منتشرشده داشته باشیم و نتیجه‌گیری فاندامنتال معنادار شود)
    // به‌علاوه ۱۴ روز آینده (برای نمایش تقویم رویدادهای پیش‌رو)
    const from = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 14 * 86400000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${apiKey}`;
    const r = await fetch(url, { timeout: 8000 });
    if (!r.ok) return res.json({ status: 'UNAVAILABLE', error: `provider-http-${r.status}`, events: [] });
    const data = await r.json();
    const raw = data && Array.isArray(data.economicCalendar) ? data.economicCalendar : [];
    if (!raw.length) return res.json({ status: 'UNAVAILABLE', error: 'no-events-returned', events: [] });

    // فقط رویدادهای مرتبط با کشورهای اثرگذار بر طلا (آمریکا مهم‌ترین) و اهمیت متوسط/بالا
    const filtered = raw.filter((e) => (e.country === 'US') && mapImpact(e.impact) !== 'low');

    const events = filtered.slice(0, 30).map((e) => {
      const dt = new Date(e.time || e.date);
      const isValidDate = !isNaN(dt.getTime());
      return {
        t: e.event || 'رویداد اقتصادی',
        d: isValidDate ? toJalali(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()) : '—',
        time: isValidDate ? dt.toISOString().slice(11, 16) : '—',
        imp: mapImpact(e.impact),
        p: e.prev != null ? String(e.prev) : '—',
        f: e.estimate != null ? String(e.estimate) : '—',
        a: e.actual != null ? String(e.actual) : '—'
      };
    });

    // ساعت‌های باقی‌مانده تا نزدیک‌ترین رویداد پرریسک (برای News Risk Engine سمت فرانت‌اند)
    const now = Date.now();
    const upcoming = filtered
      .map((e) => new Date(e.time || e.date).getTime())
      .filter((t) => !isNaN(t) && t > now)
      .sort((a, b) => a - b);
    const hoursToNextHighImpact = upcoming.length ? Math.round(((upcoming[0] - now) / 3600000) * 10) / 10 : null;

    res.json({ status: 'LIVE', events, hoursToNextHighImpact });
  } catch (e) {
    res.json({ status: 'UNAVAILABLE', error: 'proxy-exception', events: [] });
  }
});

module.exports = router;
