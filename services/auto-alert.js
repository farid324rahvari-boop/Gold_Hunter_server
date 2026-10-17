const { sendTelegramMessage } = require('./telegram');
const fetch = require('node-fetch');
const { addSignal, checkOpenSignals } = require('../lib/signal-tracker');

let timer = null;
let running = false;
let lastKey = null;
let lastSentAt = 0;
let lastCheck = null;

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatSignal(payload) {
  const s = payload.signal || {};
  const icon = s.decision === 'BUY' ? '🟢' : s.decision === 'SELL' ? '🔴' : '🟡';
  const t = s.targets || [];
  const entry = s.trade?.entry || s.entry || {};
  const hypothetical = s.trade?.isHypothetical;
  const voteIcon = (v) => v === 'BUY' ? '🟢' : v === 'SELL' ? '🔴' : '⚪';
  const strategyLines = (s.strategies || []).map((st) => `${voteIcon(st.vote)} ${esc(st.name)}: ${esc(st.vote)}`);
  return [
    `<b>شکارچی طلا 🏹</b>`,
    ``,
    `${icon} <b>${esc(s.decision || 'WAIT')}</b> — ${esc(payload.symbol || 'XAU/USD')}`,
    `قیمت: <b>${esc(payload.market?.price)}</b>`,
    `اعتماد اجماع: <b>${esc(s.confidence)}%</b> (${esc(s.consensus?.agreeCount)}/${esc(s.consensus?.totalCount)} استراتژی هم‌جهت)`,
    ``,
    `<b>رأی هر استراتژی:</b>`,
    ...strategyLines,
    ``,
    hypothetical ? `⚠ <i>سیگنال ورود فعال نیست — سطوح زیر صرفاً یک سناریوی فرضی (نزدیک‌ترین جهت محتمل) برای اطلاع است، نه توصیه ورود:</i>` : ``,
    `<b>Entry:</b> ${esc(entry.low)} – ${esc(entry.high)}`,
    `<b>SL:</b> ${esc(s.trade?.stopLoss ?? s.stopLoss)}`,
    `<b>TP1:</b> ${esc(s.trade?.targets?.[0] ?? t[0])}`,
    `<b>TP2:</b> ${esc(s.trade?.targets?.[1] ?? t[1])}`,
    `<b>TP3:</b> ${esc(s.trade?.targets?.[2] ?? t[2])}`,
    `<b>R:R:</b> 1:${esc(s.trade?.rr ?? s.rr)}`,
    ``,
    `<b>Trigger:</b> ${esc(s.trade?.trigger || s.trigger)}`,
    `<b>امتیاز وزنی:</b> BUY ${esc(s.scores?.buy)} | SELL ${esc(s.scores?.sell)}`,
    s.blockers?.length ? `<b>موانع:</b> ${esc(s.blockers.join(' | '))}` : `موانع: ندارد`,
    ``,
    // توجه: فقط دادن locale='fa-IR' کافی نیست — آن فقط شکل اعداد/تقویم را فارسی می‌کند،
    // ولی ساعت را طبق منطقه‌زمانی سرور (روی Render معمولاً UTC) حساب می‌کند، نه ایران.
    // باید timeZone را صریح مشخص کرد تا ساعت واقعی تهران نمایش داده شود.
    `<b>زمان:</b> ${new Date(payload.fetchedAt || Date.now()).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })}`,
    `<i>هشدار تحلیلی است؛ اجرای معامله خودکار انجام نمی‌شود.</i>`
  ].filter(Boolean).join('\n');
}

// پیام کوتاه نتیجه‌ی یک سیگنال قبلی — وقتی قیمت به یکی از TP ها برسد یا SL بخورد فرستاده می‌شود.
function formatResult(ev) {
  const dirFa = ev.decision === 'BUY' ? 'خرید' : 'فروش';
  const openTime = new Date(ev.openedAt).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' });
  if (ev.event === 'SL') {
    return [
      `❌ <b>نتیجه سیگنال ${dirFa} (${openTime})</b>`,
      `حد ضرر خورد: <b>${esc(ev.sl)}</b>`,
      `Entry بود: ${esc(ev.entryLow)} – ${esc(ev.entryHigh)}`
    ].join('\n');
  }
  const tpN = ev.event.replace('TP', '');
  const final = ev.event === 'TP3' ? ' (هدف نهایی — سیگنال بسته شد)' : '';
  return [
    `✅ <b>نتیجه سیگنال ${dirFa} (${openTime})</b>`,
    `${esc(ev.event)} خورد: <b>${esc(ev[`tp${tpN}`])}</b>${final}`,
    `Entry بود: ${esc(ev.entryLow)} – ${esc(ev.entryHigh)}`
  ].join('\n');
}

async function reportResolvedSignals(price) {
  const events = checkOpenSignals(price);
  for (const ev of events) {
    await sendTelegramMessage(formatResult(ev)).catch(() => {});
  }
  return events.length;
}

async function fetchSignal() {
  const base = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`;
  const r = await fetch(`${base.replace(/\/$/,'')}/api/signal`, { timeout: 15000 });
  if (!r.ok) throw new Error(`signal-http-${r.status}`);
  return r.json();
}

async function checkAndAlert() {
  if (running) return { ok: false, skipped: 'already-running' };
  running = true;
  try {
    lastCheck = new Date().toISOString();
    if (process.env.AUTO_ALERT_ENABLED !== 'true') return { ok: true, enabled: false };
    const payload = await fetchSignal();
    if (payload.status !== 'LIVE') return { ok: false, error: payload.error || 'signal-unavailable' };

    // صرف‌نظر از اینکه تصمیم فعلی BUY/SELL/WAIT باشد، همیشه با قیمت تازه چک می‌کنیم که آیا
    // یکی از سیگنال‌های قبلیِ بازِ ذخیره‌شده به TP/SL رسیده — این مستقل از منطق ارسال سیگنال
    // جدید زیر است.
    const currentPrice = Number(payload.market?.price);
    const resolvedCount = await reportResolvedSignals(currentPrice);

    const s = payload.signal || {};
    if (!['BUY','SELL'].includes(s.decision)) return { ok: true, sent: false, decision: s.decision, resolvedCount };

    // کلید بر اساس «جهت + متن تریگر» است، نه Entry/SL/TP خام — چون قیمت طلا هر دقیقه کمی
    // جابه‌جا می‌شود و Entry/SL/TP هر بار دوباره محاسبه می‌شوند، حتی وقتی علت سیگنال (مثلاً
    // «بایاس فاندامنتال نزولی») روزها بدون تغییر باقی مانده. اگر کلید بر پایه آن قیمت‌های
    // دائم‌در‌حال‌تغییر باشد، cooldown عملاً هیچ‌وقت match نمی‌کند و همان سیگنال معنایی هر ساعت
    // دوباره ارسال می‌شود (اسپم). با کلید بر پایه تریگر، فقط وقتی علتِ سیگنال واقعاً عوض شود
    // (یا جهت برعکس شود) پیام تازه ارسال می‌شود.
    const key = [s.decision, s.trade?.trigger || s.trigger].join('|');
    const cooldown = Number(process.env.AUTO_ALERT_COOLDOWN_MS || 3600000);
    const now = Date.now();
    if (key === lastKey && now - lastSentAt < cooldown) return { ok: true, sent: false, duplicate: true, resolvedCount };

    const result = await sendTelegramMessage(formatSignal(payload));
    if (result.ok) {
      lastKey = key; lastSentAt = now;
      // سیگنال تازه‌ارسال‌شده را برای رهگیری TP/SL آینده ذخیره می‌کنیم.
      const entry = s.trade?.entry || s.entry || {};
      const t = s.trade?.targets || s.targets || [];
      addSignal({
        decision: s.decision,
        entryLow: Number(entry.low), entryHigh: Number(entry.high),
        sl: Number(s.trade?.stopLoss ?? s.stopLoss),
        tp1: Number(t[0]), tp2: Number(t[1]), tp3: Number(t[2]),
        trigger: s.trade?.trigger || s.trigger
      });
      return { ok: true, sent: true, resolvedCount };
    }
    return { ok: false, error: result.error || 'telegram-send-failed' };
  } catch (e) {
    return { ok: false, error: e.message || 'auto-alert-error' };
  } finally { running = false; }
}

// ارسال فوری و دستی — برخلاف checkAndAlert، صرف‌نظر از اینکه تصمیم BUY/SELL باشد یا WAIT،
// و صرف‌نظر از Cooldown/تکراری‌بودن، وضعیت فعلی را همین الان به تلگرام می‌فرستد.
// این برای دکمه «ارسال تحلیل به تلگرام» در خود اپ استفاده می‌شود، نه برای هشدار خودکار دوره‌ای.
async function sendNow() {
  try {
    const payload = await fetchSignal();
    if (payload.status !== 'LIVE') return { ok: false, error: payload.error || 'signal-unavailable' };
    const result = await sendTelegramMessage(formatSignal(payload));
    if (result.ok) return { ok: true, sent: true, decision: payload.signal?.decision };
    return { ok: false, error: result.error || 'telegram-send-failed' };
  } catch (e) {
    return { ok: false, error: e.message || 'send-now-error' };
  }
}

function startAutoAlert() {
  if (timer) clearInterval(timer);
  if (process.env.AUTO_ALERT_ENABLED !== 'true') return false;
  const ms = Math.max(30000, Number(process.env.AUTO_ALERT_INTERVAL_MS || 60000));
  timer = setInterval(() => checkAndAlert(), ms);
  setTimeout(() => checkAndAlert(), 5000);
  return true;
}

function status() { return { enabled: process.env.AUTO_ALERT_ENABLED === 'true', running, lastCheck, lastSentAt: lastSentAt ? new Date(lastSentAt).toISOString() : null }; }
module.exports = { startAutoAlert, checkAndAlert, sendNow, status };
