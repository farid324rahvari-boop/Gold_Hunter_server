// /api/calendar — داده‌های اقتصادی واقعی از Alpha Vantage (رایگان، بدون کارت بانکی)
// کلید رایگان: alphavantage.co/support/#api-key
// کلید را در .env با نام ECONOMIC_CALENDAR_API_KEY قرار بده.
//
// توجه مهم: بر خلاف تلاش‌های قبلی (Finnhub/FMP که تقویم اقتصادی را فقط در پلن پولی می‌دهند)،
// Alpha Vantage به‌جای «تقویم رویدادهای آینده با پیش‌بینی»، آخرین مقادیر واقعی منتشرشده را می‌دهد.
// یعنی ستون «پیش‌بینی» همیشه — خواهد بود (چون این داده اصلاً در این API وجود ندارد)،
// اما ستون «واقعی» و «قبلی» واقعی و زنده است — که برای موتور نتیجه‌گیری فاندامنتال کافی است.
// محدودیت شناخته‌شده: سقف رایگان این سرویس پایین است (توصیه: در طول روز زیاد رفرش نکنید).

const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

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
function jalaliFromStr(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

const INDICATORS = [
  { fn: 'CPI', label: 'CPI آمریکا (ماهانه)', imp: 'high', interval: 'monthly' },
  { fn: 'UNEMPLOYMENT', label: 'نرخ بیکاری آمریکا', imp: 'high', interval: null },
  { fn: 'NONFARM_PAYROLL', label: 'اشتغال غیرکشاورزی (NFP)', imp: 'high', interval: null },
  { fn: 'FEDERAL_FUNDS_RATE', label: 'نرخ بهره فدرال رزرو', imp: 'high', interval: 'monthly' },
  { fn: 'INFLATION', label: 'نرخ تورم سالانه آمریکا', imp: 'medium', interval: null }
];

async function fetchIndicator(ind, apiKey) {
  const intervalParam = ind.interval ? `&interval=${ind.interval}` : '';
  const url = `https://www.alphavantage.co/query?function=${ind.fn}${intervalParam}&apikey=${apiKey}`;
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) return null;
  const json = await r.json();
  if (json.Note || json.Information || json['Error Message']) return null; // Rate limit یا خطا
  const series = json.data;
  if (!Array.isArray(series) || series.length < 2) return null;
  return {
    t: ind.label, imp: ind.imp,
    d: jalaliFromStr(series[0].date),
    time: '—',
    p: series[1].value != null ? String(series[1].value) : '—',
    f: '—', // Alpha Vantage پیش‌بینی نمی‌دهد — فقط داده واقعی منتشرشده
    a: series[0].value != null ? String(series[0].value) : '—'
  };
}

router.get('/', async (req, res) => {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) return res.json({ status: 'UNAVAILABLE', error: 'no-api-key-configured', events: [] });
  try {
    const results = await Promise.all(INDICATORS.map((ind) => fetchIndicator(ind, apiKey).catch(() => null)));
    const events = results.filter((e) => e !== null);
    if (!events.length) return res.json({ status: 'UNAVAILABLE', error: 'provider-empty-or-rate-limited', events: [] });

    // این سرویس تاریخ رویداد آینده نمی‌دهد؛ پس محاسبه «ساعت تا خبر بعدی» ممکن نیست — صادقانه null
    res.json({ status: 'LIVE', events, hoursToNextHighImpact: null });
  } catch (e) {
    res.json({ status: 'UNAVAILABLE', error: 'proxy-exception', events: [] });
  }
});

module.exports = router;
