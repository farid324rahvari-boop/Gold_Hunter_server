// رهگیری نتیجه‌ی سیگنال‌های ارسال‌شده: هر سیگنال BUY/SELL که به تلگرام می‌رود، اینجا هم
// ذخیره می‌شود؛ هر بار که قیمت تازه می‌رسد (همان چرخه‌ی auto-alert)، قیمت با SL/TP1/TP2/TP3
// هر سیگنال بازِ ذخیره‌شده مقایسه می‌شود و رویدادهای تازه (رسیدن به هدف یا خوردن حد ضرر)
// برگردانده می‌شود تا یک پیام نتیجه برای آن‌ها به تلگرام فرستاده شود.
//
// محدودیت شناخته‌شده: روی دیسک همین سرویس (نه یک دیتابیس واقعی) ذخیره می‌شود — روی پلن
// رایگان Render این فایل با هر دیپلوی جدید پاک می‌شود (ولی بین درخواست‌های یک دیپلوی ثابت
// می‌ماند). اگر در آینده پایداری کامل لازم شد، باید به یک دیتابیس واقعی مهاجرت کرد.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.tmpdir(), 'gold-hunter-tracked-signals.json');
const MAX_KEEP = 300; // جلوگیری از رشد بی‌پایان فایل با گذشت زمان

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return []; // فایل هنوز وجود ندارد یا خراب است — شروع از لیست خالی
  }
}

function save(list) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(list.slice(-MAX_KEEP)));
  } catch (e) {
    // فضای ذخیره در دسترس نیست؛ رهگیری بی‌صدا غیرفعال می‌ماند ولی بقیه‌ی سیستم کار می‌کند
  }
}

// یک سیگنال تازه‌ی BUY/SELL را برای رهگیری ثبت می‌کند.
function addSignal({ decision, entryLow, entryHigh, sl, tp1, tp2, tp3, trigger }) {
  if (!['BUY', 'SELL'].includes(decision)) return;
  if (![sl, tp1].every(Number.isFinite)) return; // بدون SL/TP1 معتبر، قابل رهگیری نیست
  const list = load();
  list.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    decision, entryLow, entryHigh, sl, tp1, tp2, tp3, trigger,
    openedAt: Date.now(),
    status: 'OPEN',
    tp1Hit: false, tp2Hit: false, tp3Hit: false
  });
  save(list);
}

// سیگنال‌های باز را با قیمت فعلی می‌سنجد. هر سیگنال با خوردن SL یا رسیدن TP3 بسته می‌شود
// (هرکدام زودتر اتفاق بیفتد)؛ TP1/TP2 به‌عنوان رویدادهای میانی گزارش می‌شوند ولی سیگنال تا
// TP3 یا SL باز می‌ماند (دقیقاً مثل منطق backtest موجود در پروژه).
function checkOpenSignals(price) {
  if (!Number.isFinite(price)) return [];
  const list = load();
  const events = [];
  let changed = false;

  for (const sig of list) {
    if (sig.status !== 'OPEN') continue;
    const isBuy = sig.decision === 'BUY';

    const hitSL = isBuy ? price <= sig.sl : price >= sig.sl;
    if (hitSL) {
      sig.status = 'LOSS';
      sig.closedAt = Date.now();
      events.push({ ...sig, event: 'SL' });
      changed = true;
      continue;
    }

    [1, 2, 3].forEach((n) => {
      const level = sig[`tp${n}`];
      if (level == null || sig[`tp${n}Hit`]) return;
      const hit = isBuy ? price >= level : price <= level;
      if (!hit) return;
      sig[`tp${n}Hit`] = true;
      changed = true;
      events.push({ ...sig, event: `TP${n}` });
      if (n === 3) { sig.status = 'WIN'; sig.closedAt = Date.now(); }
    });
  }

  if (changed) save(list);
  return events;
}

module.exports = { addSignal, checkOpenSignals };
