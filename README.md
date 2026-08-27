# Gold Hunter Server — Live Day Trading

## راه‌اندازی
1. `cp .env.example .env`
2. در `.env` حداقل `TWELVEDATA_API_KEY` را قرار بده.
3. `npm install`
4. `npm start`

## داده زنده
منبع پیش‌فرض XAU/USD: TwelveData.

- `GET /api/market/quote?symbol=XAU/USD`
- `GET /api/market/ohlc?symbol=XAU/USD&timeframe=15M&limit=200`
- `GET /api/signal`

`/api/signal` به‌صورت زنده 15M/1H/4H/Daily را می‌گیرد و Entry/Trigger/SL/TP/R:R/Invalidation/Obstacles و BUY/SELL/WAIT تولید می‌کند.

## خبر
اگر `FINNHUB_API_KEY` تنظیم شود، خبرهای پرریسک نزدیک، ورود خودکار را مسدود می‌کنند. نبود کلید خبر باعث توقف بازار نمی‌شود؛ فقط news gate در دسترس نیست.

## Telegram
`TELEGRAM_BOT_TOKEN` و `TELEGRAM_CHAT_ID` را برای ارسال هشدار تنظیم کن. روت `/api/alerts/check` برای Cron خارجی قابل فراخوانی است.

## نکته
کلیدها را در `.env` قرار بده و `.env` را در GitHub آپلود نکن.
