// /api/ai/analyze  (POST)
// این روت هرگز قیمت یا داده بازار تولید نمی‌کند.
// ورودی: خروجی ساختاریافته Rule Engine / Technical Engine / Fundamental Engine
//        (همان چیزی که در فرانت‌اند صفحه AI Analyst می‌سازد)
// خروجی: تحلیل روایی (narrative) تولیدشده توسط یک مدل زبانی واقعی، صرفاً بر پایه
//        همان داده‌های ساختاریافته — نه حدس قیمت.
//
// از Google Gemini API استفاده می‌کند (رایگان، بدون نیاز به کارت بانکی —
// کلید را از aistudio.google.com بگیر).
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

  const model = process.env.AI_MODEL || 'gemini-flash-latest';
  const baseUrl = process.env.AI_API_BASE_URL || `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    const r = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [
          { role: 'user', parts: [{ text: `داده‌های ساختاریافته سیستم:\n${JSON.stringify(structuredState)}` }] }
        ],
        generationConfig: { maxOutputTokens: 500 }
      }),
      timeout: 15000
    });

    if (!r.ok) return res.json({ status: 'UNAVAILABLE', error: `ai-provider-http-${r.status}` });
    const data = await r.json();
    const candidate = data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map((p) => p.text || '').join('\n').trim()
      : '';
    if (!text) return res.json({ status: 'UNAVAILABLE', error: 'ai-empty-response' });

    res.json({ status: 'LIVE', narrative: text });
  } catch (e) {
    res.json({ status: 'UNAVAILABLE', error: 'proxy-exception' });
  }
});

module.exports = router;
