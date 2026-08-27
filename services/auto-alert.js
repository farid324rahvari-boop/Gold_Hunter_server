const { sendTelegramMessage } = require('./telegram');
const fetch = require('node-fetch');

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
  return [
    `<b>شکارچی طلا 🏹</b>`,
    ``,
    `${icon} <b>${esc(s.decision || 'WAIT')}</b> — ${esc(payload.symbol || 'XAU/USD')}`,
    `قیمت: <b>${esc(payload.market?.price)}</b>`,
    `اعتماد: <b>${esc(s.confidence)}%</b>`,
    ``,
    `<b>Entry:</b> ${esc(entry.low)} – ${esc(entry.high)}`,
    `<b>SL:</b> ${esc(s.trade?.stopLoss ?? s.stopLoss)}`,
    `<b>TP1:</b> ${esc(s.trade?.targets?.[0] ?? t[0])}`,
    `<b>TP2:</b> ${esc(s.trade?.targets?.[1] ?? t[1])}`,
    `<b>TP3:</b> ${esc(s.trade?.targets?.[2] ?? t[2])}`,
    `<b>R:R:</b> 1:${esc(s.trade?.rr ?? s.rr)}`,
    ``,
    `<b>Trigger:</b> ${esc(s.trade?.trigger || s.trigger)}`,
    `<b>امتیاز:</b> BUY ${esc(s.scores?.buy)} | SELL ${esc(s.scores?.sell)}`,
    `<b>Fundamental:</b> ${esc(s.fundamental?.bias || 'N/A')}`, 
    s.blockers?.length ? `<b>موانع:</b> ${esc(s.blockers.join(' | '))}` : `موانع: ندارد`,
    ``,
    `<b>زمان:</b> ${new Date(payload.fetchedAt || Date.now()).toLocaleString('fa-IR')}`,
    `<i>هشدار تحلیلی است؛ اجرای معامله خودکار انجام نمی‌شود.</i>`
  ].join('\n');
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
    const s = payload.signal || {};
    if (!['BUY','SELL'].includes(s.decision)) return { ok: true, sent: false, decision: s.decision };

    // یک هشدار فقط برای هر ترکیب جهت/ورود/SL/TP ارسال می‌شود؛ پس هر دقیقه اسپم نمی‌کند.
    const key = [s.decision, s.entry?.low, s.entry?.high, s.stopLoss, ...(s.targets || [])].join('|');
    const cooldown = Number(process.env.AUTO_ALERT_COOLDOWN_MS || 3600000);
    const now = Date.now();
    if (key === lastKey && now - lastSentAt < cooldown) return { ok: true, sent: false, duplicate: true };

    const result = await sendTelegramMessage(formatSignal(payload));
    if (result.ok) { lastKey = key; lastSentAt = now; return { ok: true, sent: true }; }
    return { ok: false, error: result.error || 'telegram-send-failed' };
  } catch (e) {
    return { ok: false, error: e.message || 'auto-alert-error' };
  } finally { running = false; }
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
module.exports = { startAutoAlert, checkAndAlert, status };
