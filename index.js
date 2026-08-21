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

const marketRoutes = require('./routes/market');
const calendarRoutes = require('./routes/calendar');
const aiRoutes = require('./routes/ai');
const alertsRoutes = require('./routes/alerts');
const fundamentalsRoutes = require('./routes/fundamentals');
const newsRoutes = require('./routes/news');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'gold-hunter-proxy', time: new Date().toISOString() });
});

app.use('/api/market', marketRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/fundamentals', fundamentalsRoutes);
app.use('/api/news', newsRoutes);

// خطای عمومی — هرگز کرش نکن، همیشه پاسخ ساختاریافته بده
app.use((err, req, res, next) => {
  console.error('[gold-hunter-proxy] error:', err);
  res.status(500).json({ status: 'UNAVAILABLE', error: 'internal-error' });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Gold Hunter proxy listening on :${PORT}`));
