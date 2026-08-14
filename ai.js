// /api/ai/analyze  (POST)
// این روت هرگز قیمت یا داده بازار تولید نمی‌کند.
// ورودی: خروجی ساختاریافته Rule Engine / Technical Engine / Fundamental Engine
//        (همان چیزی که در فرانت‌اند صفحه AI Analyst می‌سازد)
// خروجی: تحلیل روایی (narrative) تولیدشده توسط یک مدل زبانی واقعی، صرفاً بر پایه
//        همان داده‌های ساختاریافته — نه حدس قیمت.
//
// اگر AI_API_KEY تنظیم نشده باشد، این روت با status=UNAVAILABLE پاسخ می‌دهد
// و فرانت‌اند به‌صورت شفاف اعلام می‌کند که AI واقعی متصل نیست
// (و از تحلیل قانون‌محور محلی/Rule Engine به‌عنوان جایگزین شفاف استفاده می‌کند).

const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

router.post('/analyze', async (req, res) => {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    return res.json({ status: 'UNAVAILABLE', error: 'no-ai-key-configured' });
  }

  const structuredState = req.body && req.body.state;
  if (!structuredState) {
    return res.status(400).json({ status: 'UNAVAILABLE', error: 'missing-state-payload' });
  }

  const systemPrompt = `تو تحلیل‌گر ارشد بازار طلا (XAU/USD) هستی. فقط و فقط بر اساس داده‌های JSON ساختاریافته‌ای که
دریافت می‌کنی تحلیل بنویس. هرگز قیمت، اندیکاتور یا رویداد خبری جدید نساز و از خودت عدد تولید نکن.
اگر داده‌ای برای نتیجه‌گیری کافی نیست، صریحاً بگو "WAIT" و دلیل را توضیح بده.
خروجی را به فارسی و کوتاه (حداکثر ۱۲۰ کلمه) و کاربردی برای یک معامله‌گر بنویس.`;

  try {
    const r = await fetch(process.env.AI_API_BASE_URL || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `داده‌های ساختاریافته سیستم:\n${JSON.stringify(structuredState)}` }
        ]
      }),
      timeout: 15000
    });

    if (!r.ok) return res.json({ status: 'UNAVAILABLE', error: `ai-provider-http-${r.status}` });
    const data = await r.json();
    const text = (data.content || []).map((b) => b.text || '').join('\n').trim();
    if (!text) return res.json({ status: 'UNAVAILABLE', error: 'ai-empty-response' });

    res.json({ status: 'LIVE', narrative: text });
  } catch (e) {
    res.json({ status: 'UNAVAILABLE', error: 'proxy-exception' });
  }
});

module.exports = router;
