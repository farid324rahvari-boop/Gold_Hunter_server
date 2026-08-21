// Gold Hunter — Backend Proxy
// نقش این سرور: نگهداری امن API Key ها (که هرگز نباید در فرانت‌اند/مرورگر قرار بگیرند)
// و پل ارتباطی بین اپ فرانت‌اند (index.html) و سرویس‌های واقعی داده و AI.
//
// اجرا:
//   1) cp .env.example .env   و مقادیر واقعی را پر کن
//   2) npm install
//   3) npm start
//   سرور روی http://localhost:8787 بالا می‌آید.
//   سپس در اپ (صفحه تنظیمات) آدرس API_BASE_URL را به همین آدرس ست کن.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

// بارگذاری امن هر روت — اگر یک فایل روت گم یا خراب باشد (مثلاً هنوز آپلود نشده)،
// فقط همان بخش غیرفعال می‌شود، نه کل سرور. این از کرش کامل سرور (که همه‌چیز از جمله
// بخش‌های سالم را هم از کار می‌انداخت) جلوگیری می‌کند.
function safeRequireRoute(path, mountPath, app) {
  try {
    const router = require(path);
    app.use(mountPath, router);
    console.log(`[gold-hunter-proxy] route loaded: ${mountPath}`);
  } catch (e) {
    console.error(`[gold-hunter-proxy] failed to load route ${mountPath} (${path}):`, e.message);
    app.use(mountPath, (req, res) => res.json({ status: 'UNAVAILABLE', error: `route-not-loaded: ${e.message}` }));
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'gold-hunter-proxy', time: new Date().toISOString() });
});

safeRequireRoute('./routes/market', '/api/market', app);
safeRequireRoute('./routes/calendar', '/api/calendar', app);
safeRequireRoute('./routes/ai', '/api/ai', app);
safeRequireRoute('./routes/alerts', '/api/alerts', app);
safeRequireRoute('./routes/fundamentals', '/api/fundamentals', app);
safeRequireRoute('./routes/news', '/api/news', app);

// خطای عمومی — هرگز کرش نکن، همیشه پاسخ ساختاریافته بده
app.use((err, req, res, next) => {
  console.error('[gold-hunter-proxy] error:', err);
  res.status(500).json({ status: 'UNAVAILABLE', error: 'internal-error' });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Gold Hunter proxy listening on :${PORT}`));
