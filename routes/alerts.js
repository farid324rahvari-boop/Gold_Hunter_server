// GET /api/alerts/check
// این روت باید هر چند دقیقه یک‌بار توسط یک Cron خارجی رایگان (مثل cron-job.org) فراخوانی شود
// (پلن رایگان Render خودش زمان‌بند داخلی ندارد و وقتی بی‌کار بماند می‌خوابد؛
// فراخوانی دوره‌ای این روت هم چک هشدار را انجام می‌دهد و هم سرور را بیدار نگه می‌دارد).
//
// منطق این فایل نسخه ساده‌شده‌ای از Rule Engine / Alert Engine سمت فرانت‌اند است —
// فقط برای تشخیص شرایطی که ارزش اطلاع‌رسانی فوری (Push) دارند، نه یک تحلیل کامل.
// هرگز پیام را با داده ساختگی نمی‌فرستد؛ اگر داده Live در دسترس نباشد، فقط سکوت می‌کند.

const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();
const { sendTelegramMessage } = require('../services/telegram');

const SYMBOL = 'XAU/USD';
const MIN_MINUTES_BETWEEN_SAME_ALERT = 60; // از اسپم‌شدن همان هشدار در بازه کوتاه جلوگیری می‌کند

// حافظه ساده در RAM سرور (بین ری‌استارت‌های سرور پاک می‌شود — برای این کاربرد کافی است)
let lastAlertSentAt = {};

function calcEMA(closes, period) {
  if (!closes.length) return null;
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}
function calcRSI(closes, period) {
  period = period || 14;
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function supportResistance(bars, lookback) {
  const slice = bars.slice(-(lookback || 40));
  return { support: Math.min(...slice.map((b) => b.low)), resistance: Math.max(...slice.map((b) => b.high)) };
}

async function fetchOHLC(interval, outputsize) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) return null;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=${interval}&outputsize=${outputsize}&apikey=${apiKey}`;
  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) return null;
  const data = await r.json();
  if (!data || data.status === 'error' || !Array.isArray(data.values) || !data.values.length) return null;
  return data.values
    .map((v) => ({
      time: new Date(v.datetime).getTime(),
      open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low),
      close: parseFloat(v.close), volume: v.volume ? parseFloat(v.volume) : 0
    }))
    .reverse();
}

async function canSend(key) {
  const now = Date.now();
  const last = lastAlertSentAt[key] || 0;
  if (now - last < MIN_MINUTES_BETWEEN_SAME_ALERT * 60 * 1000) return false;
  lastAlertSentAt[key] = now;
  return true;
}

router.get('/check', async (req, res) => {
  if (!process.env.TWELVEDATA_API_KEY) {
    return res.json({ ok: false, error: 'no-market-api-key-configured' });
  }
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return res.json({ ok: false, error: 'telegram-not-configured' });
  }

  try {
    const h4 = await fetchOHLC('4h', 60);
    const daily = await fetchOHLC('1day', 40);
    if (!h4 || !daily) {
      return res.json({ ok: false, error: 'market-data-unavailable' });
    }

    const closes4h = h4.map((b) => b.close);
    const price = closes4h[closes4h.length - 1];
    const ema20 = calcEMA(closes4h.slice(-40), 20);
    const rsi = calcRSI(closes4h, 14);
    const dailySR = supportResistance(daily, 20);
    const h4SR = supportResistance(h4, 20);

    const distToResistancePct = ((dailySR.resistance - price) / price) * 100;
    const distToSupportPct = ((price - dailySR.support) / price) * 100;

    const alertsFired = [];

    if (distToResistancePct < 0.5 && (await canSend('near-resistance'))) {
      alertsFired.push(`🎯 قیمت طلا نزدیک مقاومت کلیدی شده!\nقیمت: ${price.toFixed(2)}\nمقاومت: ${dailySR.resistance.toFixed(2)} (فاصله ${distToResistancePct.toFixed(2)}٪)`);
    }
    if (distToSupportPct < 0.5 && (await canSend('near-support'))) {
      alertsFired.push(`🎯 قیمت طلا نزدیک حمایت کلیدی شده!\nقیمت: ${price.toFixed(2)}\nحمایت: ${dailySR.support.toFixed(2)} (فاصله ${distToSupportPct.toFixed(2)}٪)`);
    }
    if (rsi > 70 && (await canSend('rsi-overbought'))) {
      alertsFired.push(`📊 RSI طلا (4H) وارد ناحیه اشباع خرید شد: ${rsi.toFixed(1)}\nقیمت فعلی: ${price.toFixed(2)}`);
    }
    if (rsi < 30 && (await canSend('rsi-oversold'))) {
      alertsFired.push(`📊 RSI طلا (4H) وارد ناحیه اشباع فروش شد: ${rsi.toFixed(1)}\nقیمت فعلی: ${price.toFixed(2)}`);
    }
    if (h4[h4.length - 1].close > h4SR.resistance && h4[h4.length - 2] && h4[h4.length - 2].close <= h4SR.resistance && (await canSend('breakout-up'))) {
      alertsFired.push(`🚀 احتمال شکست مقاومت کوتاه‌مدت (4H)!\nقیمت: ${price.toFixed(2)} بالای ${h4SR.resistance.toFixed(2)}\n⚠ این فقط هشدار اولیه است — قبل از ورود، اپ را برای تأیید کامل Breakout چک کن.`);
    }

    // سیگنال ترکیبی ساده: روند صعودی (قیمت بالای EMA20) + RSI سالم (نه اشباع) + فاصله امن از مقاومت
    // یعنی چند شرط هم‌زمان برقرارند — نه فقط یک عامل تنها. این معادل ساده‌شده Confidence Score اصلی است.
    const bullishSetup = price > ema20 && rsi > 50 && rsi < 70 && distToResistancePct > 1 && distToSupportPct > 1;
    const bearishSetup = price < ema20 && rsi < 50 && rsi > 30 && distToSupportPct > 1 && distToResistancePct > 1;
    if (bullishSetup && (await canSend('confluence-buy'))) {
      alertsFired.push(`✅ چند شرط هم‌زمان برای خرید هم‌راستا شده‌اند!\nقیمت: ${price.toFixed(2)} · بالای EMA20 (${ema20.toFixed(2)}) · RSI سالم (${rsi.toFixed(1)})\n⚠ قبل از ورود حتماً اپ را برای تأیید کامل (امتیاز اطمینان، R:R) چک کن.`);
    }
    if (bearishSetup && (await canSend('confluence-sell'))) {
      alertsFired.push(`✅ چند شرط هم‌زمان برای فروش هم‌راستا شده‌اند!\nقیمت: ${price.toFixed(2)} · زیر EMA20 (${ema20.toFixed(2)}) · RSI سالم (${rsi.toFixed(1)})\n⚠ قبل از ورود حتماً اپ را برای تأیید کامل (امتیاز اطمینان، R:R) چک کن.`);
    }

    for (const msg of alertsFired) {
      await sendTelegramMessage(`<b>شکارچی طلا 🪙</b>\n\n${msg}`);
    }

    res.json({ ok: true, checkedAt: new Date().toISOString(), price, rsi, alertsSent: alertsFired.length });
  } catch (e) {
    res.json({ ok: false, error: 'check-exception' });
  }
});

module.exports = router;
