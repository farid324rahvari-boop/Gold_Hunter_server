// سرویس ارسال پیام به تلگرام
// از Telegram Bot API استفاده می‌کند (رایگان، بدون نیاز به کارت بانکی).

const fetch = require('node-fetch');

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { ok: false, error: 'telegram-not-configured' };
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      timeout: 10000
    });
    const data = await r.json();
    if (!data.ok) return { ok: false, error: data.description || 'telegram-api-error' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'telegram-network-error' };
  }
}

module.exports = { sendTelegramMessage };
