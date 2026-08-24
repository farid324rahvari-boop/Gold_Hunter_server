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

  const systemPrompt = `تو تحلیل‌گر ارشد بازار طلا (XAU/USD) هستی که برای یک معامله‌گر روزانه توضیح می‌دهی.
فقط و فقط بر اساس داده‌های JSON ساختاریافته‌ای که دریافت می‌کنی تحلیل بنویس. هرگز قیمت، اندیکاتور
یا رویداد خبری جدید نساز و از خودت عدد تولید نکن — فقط از همان اعدادی که در ورودی داده شده استفاده کن.

ورودی شامل چند بخش کاملاً متفاوت است که باید همه را در تحلیل خودت واقعاً به‌کار ببری، نه فقط یکی:
- timeframes: تحلیل تکنیکال Weekly/Daily/4H/1H/15M (روند، RSI، ATR، ساختار بازار BOS/CHoCH)
- marketRegime / breakoutStatus / range: وضعیت کلی بازار و شکست/رنج
- fundamentalBias / fundamentalReasons: نتیجه‌گیری فاندامنتال از تقویم اقتصادی
- macroIndicators: داده‌های واقعی و رسمی فدرال رزرو (نرخ بهره، تورم CPI/Core CPI، بیکاری، اشتغال)
- newsRisk: ریسک نزدیک بودن یک خبر مهم
اگر یکی از این بخش‌ها در تحلیل نهایی نقشی دارد (مثلاً نرخ بهره بالا یا تورم پایین)، صریحاً به آن اشاره کن.

پاسخ را دقیقاً با این ساختار و به فارسی روان بنویس (نه فهرست کدنویسی‌شده، متن طبیعی):

۱. **تصمیم نهایی**: یکی از BUY / SELL / WAIT را با یک جمله واضح اعلام کن.
۲. **تحلیل تکنیکال**: وضعیت روند/رنج و ساختار بازار در تایم‌فریم‌های اصلی (4H و Daily) را خلاصه کن.
۳. **تحلیل فاندامنتال و کلان**: بر اساس macroIndicators و fundamentalBias توضیح بده فضای کلان اقتصادی
   (نرخ بهره، تورم، اشتغال) در حال حاضر برای طلا مثبت است یا منفی و چرا.
۴. **جمع‌بندی و شرط ورود**: اگر WAIT است، دقیقاً بگو چه اتفاقی (تکنیکال یا خبری) باید بیفتد تا شرایط
   ورود فراهم شود. اگر BUY/SELL است، با استفاده از همان اعداد ورودی، نقطه ورود تقریبی، حد ضرر
   ساختاری، و حداقل یک هدف قیمتی مشخص و عددی بنویس.

طول پاسخ: حداکثر ۳۰۰ کلمه — کامل و کاربردی، نه تلگرافی، ولی بدون حاشیه‌روی اضافه.`;

  const model = process.env.AI_MODEL || 'gemini-flash-latest';
  const baseUrl = process.env.AI_API_BASE_URL || `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  async function callGemini() {
    return fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [
          { role: 'user', parts: [{ text: `داده‌های ساختاریافته سیستم:\n${JSON.stringify(structuredState)}` }] }
        ],
        generationConfig: { maxOutputTokens: 1200, thinkingConfig: { thinkingBudget: 0 } }
      }),
      timeout: 15000
    });
  }

  try {
    let r = await callGemini();
    if (r.status === 503) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      r = await callGemini();
    }

    if (!r.ok) return res.json({ status: 'UNAVAILABLE', error: `ai-provider-http-${r.status}` });
    const data = await r.json();
    const candidate = data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.filter((p) => !p.thought).map((p) => p.text || '').join('\n').trim()
      : '';
    if (!text) return res.json({ status: 'UNAVAILABLE', error: 'ai-empty-response' });

    res.json({ status: 'LIVE', narrative: text });
  } catch (e) {
    res.json({ status: 'UNAVAILABLE', error: 'proxy-exception' });
  }
});

module.exports = router;
