// رهگیری نتیجه‌ی سیگنال‌های ارسال‌شده.
//
// چرخه‌ی عمر هر سیگنال:
//   PENDING  → سیگنال ارسال شده ولی قیمت هنوز به ناحیه‌ی Entry نرسیده (Entry لیمیتی است).
//   OPEN     → قیمت به ناحیه‌ی Entry رسیده؛ از این لحظه TP/SL شمرده می‌شود.
//   WIN      → TP3 خورد.      LOSS → SL خورد.
//   MISSED   → قبل از پر شدن Entry، قیمت به TP1 یا SL رسید (ورودی‌ای اتفاق نیفتاد).
//   EXPIRED  → تا PENDING_TTL پر نشد.   TIMEOUT → بیش از OPEN_MAX_AGE باز مانده و بسته شد.
//
// فقط سیگنال‌هایی که واقعاً پر شده‌اند (OPEN/WIN/LOSS/TIMEOUT) در آمار برد/باخت حساب می‌شوند.
//
// محدودیت شناخته‌شده: روی دیسک موقت سرویس ذخیره می‌شود و با دیپلوی جدید پاک می‌شود.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.tmpdir(), 'gold-hunter-tracked-signals.json');
const MAX_KEEP = 300;
const PENDING_TTL_MS = Number(process.env.SIGNAL_PENDING_TTL_MS || 2 * 3600000);
const OPEN_MAX_AGE_MS = Number(process.env.SIGNAL_MAX_AGE_MS || 24 * 3600000);

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function save(list) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(list.slice(-MAX_KEEP)));
  } catch (e) {
    // رهگیری بی‌صدا غیرفعال می‌ماند ولی بقیه‌ی سیستم کار می‌کند
  }
}

// آیا قیمت به ناحیه‌ی Entry رسیده (یا از آن عبور کرده)؟
// BUY: ورود لیمیتی پایین‌تر/داخل ناحیه → قیمت ≤ بالای ناحیه.
// SELL: قیمت ≥ پایین ناحیه.
function entryFilled(sig, price) {
  if (!Number.isFinite(sig.entryLow) || !Number.isFinite(sig.entryHigh)) return true; // Entry نامعتبر: مثل قبل رفتار کن
  return sig.decision === 'BUY' ? price <= sig.entryHigh : price >= sig.entryLow;
}

function isActive(sig) {
  return sig.status === 'OPEN' || sig.status === 'PENDING';
}

// یک سیگنال تازه‌ی BUY/SELL را ثبت می‌کند. price = قیمت لحظه‌ی ارسال (برای تشخیص فوری پر شدن).
function addSignal({ decision, entryLow, entryHigh, sl, tp1, tp2, tp3, trigger, price }) {
  if (!['BUY', 'SELL'].includes(decision)) return;
  if (![sl, tp1].every(Number.isFinite)) return;
  const list = load();
  const sig = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    decision, entryLow, entryHigh, sl, tp1, tp2, tp3, trigger,
    openedAt: Date.now(),
    status: 'PENDING',
    tp1Hit: false, tp2Hit: false, tp3Hit: false
  };
  if (Number.isFinite(price) && entryFilled(sig, price)) {
    sig.status = 'OPEN';
    sig.filledAt = Date.now();
  }
  list.push(sig);
  save(list);
}

function getActiveSignals() {
  return load().filter(isActive);
}

// آخرین زمانی که یک سیگنال هم‌جهت (پس از پر شدن) بسته شد؛ برای cooldown بعد از بسته‌شدن.
function getLastClosedAt(decision) {
  let t = 0;
  for (const s of load()) {
    if (s.decision !== decision) continue;
    if (!['WIN', 'LOSS', 'TIMEOUT'].includes(s.status)) continue;
    if (s.closedAt && s.closedAt > t) t = s.closedAt;
  }
  return t;
}

// سیگنال‌های فعال را با قیمت فعلی می‌سنجد و رویدادهای تازه را برمی‌گرداند.
// event ها: FILLED, EXPIRED, MISSED, TIMEOUT, SL, TP1, TP2, TP3
// فقط SL/TP* باید به تلگرام برود؛ بقیه برای لاگ/آمار هستند.
function checkOpenSignals(price) {
  if (!Number.isFinite(price)) return [];
  const list = load();
  const events = [];
  const now = Date.now();
  let changed = false;

  for (const sig of list) {
    if (!isActive(sig)) continue;
    const isBuy = sig.decision === 'BUY';

    if (sig.status === 'PENDING') {
      if (now - sig.openedAt > PENDING_TTL_MS) {
        sig.status = 'EXPIRED'; sig.closedAt = now; changed = true;
        events.push({ ...sig, event: 'EXPIRED' });
        continue;
      }
      // قبل از پر شدن Entry، قیمت به SL یا TP1 رسیده → ورودی از دست رفته
      const invalid = isBuy ? (price <= sig.sl || price >= sig.tp1) : (price >= sig.sl || price <= sig.tp1);
      if (invalid && !entryFilled(sig, price)) {
        sig.status = 'MISSED'; sig.closedAt = now; changed = true;
        events.push({ ...sig, event: 'MISSED' });
        continue;
      }
      if (!entryFilled(sig, price)) continue;
      sig.status = 'OPEN'; sig.filledAt = now; changed = true;
      events.push({ ...sig, event: 'FILLED' });
      // ادامه: همین قیمت را برای SL/TP هم می‌سنجیم
    }

    if (now - (sig.filledAt || sig.openedAt) > OPEN_MAX_AGE_MS) {
      sig.status = 'TIMEOUT'; sig.closedAt = now; changed = true;
      events.push({ ...sig, event: 'TIMEOUT' });
      continue;
    }

    const hitSL = isBuy ? price <= sig.sl : price >= sig.sl;
    if (hitSL) {
      sig.status = 'LOSS'; sig.closedAt = now; changed = true;
      events.push({ ...sig, event: 'SL' });
      continue;
    }

    [1, 2, 3].forEach((n) => {
      const level = sig[`tp${n}`];
      if (level == null || sig[`tp${n}Hit`]) return;
      const hit = isBuy ? price >= level : price <= level;
      if (!hit) return;
      sig[`tp${n}Hit`] = true; changed = true;
      events.push({ ...sig, event: `TP${n}` });
      if (n === 3) { sig.status = 'WIN'; sig.closedAt = now; }
    });
  }

  if (changed) save(list);
  return events;
}

module.exports = { addSignal, checkOpenSignals, getActiveSignals, getLastClosedAt };
