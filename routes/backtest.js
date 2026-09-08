// /api/backtest — بک‌تست واقعی روی داده تاریخی واقعی TwelveData
// دقیقاً همان موتور تصمیم (lib/engine.js) که در /api/signal زنده اجرا می‌شود، اینجا هم
// روی هر نقطه از تاریخ اجرا می‌شود — نه یک شبیه‌سازی جداگانه با منطق متفاوت.
//
// محدودیت‌های صادقانه (حتماً در پاسخ هم ذکر می‌شوند):
// 1) داده فاندامنتال (FRED) و ریسک خبری (Finnhub) لحظه‌به‌لحظه تاریخی در دسترس نیست —
//    در بک‌تست این دو عامل «خنثی» فرض می‌شوند (نه ساختگی)، یعنی نتیجه واقعی معاملات
//    ممکن است در دنیای واقعی به‌خاطر این دو عامل کمی متفاوت باشد.
// 2) قیمت ورود دقیقاً برابر قیمت بسته‌شدن کندلی گرفته می‌شود که سیگنال در آن صادر شده —
//    نه لزوماً همان محدوده Entry پیشنهادی (چون شبیه‌سازی دقیق لمس‌شدن ناحیه ورود در گذشته
//    نیازمند داده تیک‌به‌تیک است که در دسترس نیست).
// 3) اسپرد، کمیسیون و Slippage واقعی بروکر مدل نشده‌اند — نتیجه واقعی معاملات همیشه
//    کمی بدتر از عدد این بک‌تست خواهد بود.
// 4) سقف رایگان TwelveData ممکن است عمق تاریخی/تعداد کندل قابل‌دریافت را محدود کند.

const express = require('express');
const router = express.Router();
const engine = require('../lib/engine');

function advancePointer(bars, ptr, targetTime) {
  while (ptr + 1 < bars.length && bars[ptr + 1].time <= targetTime) ptr++;
  return ptr;
}

router.get('/', async (req, res) => {
  if (!process.env.TWELVEDATA_API_KEY) return res.json({ status: 'UNAVAILABLE', error: 'no-api-key-configured' });

  const m15Bars = Math.min(Number(req.query.bars) || 1500, 3000); // پیش‌فرض ~۱۵ روز کندل ۱۵دقیقه‌ای
  const rollingWindow = 220; // همان اندازه‌ای که سیگنال زنده استفاده می‌کند

  try {
    const [m15, h1, h4, daily] = await Promise.all([
      engine.fetchTF('15M', m15Bars + rollingWindow),
      engine.fetchTF('1H', Math.ceil((m15Bars + rollingWindow) / 4) + rollingWindow),
      engine.fetchTF('4H', Math.ceil((m15Bars + rollingWindow) / 16) + rollingWindow),
      engine.fetchTF('Daily', Math.ceil((m15Bars + rollingWindow) / 96) + rollingWindow)
    ]);
    if (!m15 || !h1 || !h4 || !daily) return res.json({ status: 'UNAVAILABLE', error: 'market-data-unavailable' });
    if (m15.length < rollingWindow + 50) return res.json({ status: 'UNAVAILABLE', error: 'insufficient-history-for-backtest' });

    let h1Ptr = 0, h4Ptr = 0, dPtr = 0;
    const trades = [];
    let position = null; // {dir, entry, sl, tp1, openIndex, openTime}
    const equityCurve = []; // بر حسب واحد R (ریسک هر معامله = ۱R)

    const startIdx = Math.max(rollingWindow, 100);
    for (let i = startIdx; i < m15.length; i++) {
      const bar = m15[i];
      h1Ptr = advancePointer(h1, h1Ptr, bar.time);
      h4Ptr = advancePointer(h4, h4Ptr, bar.time);
      dPtr = advancePointer(daily, dPtr, bar.time);
      if (h1Ptr < rollingWindow - 30 || h4Ptr < 30 || dPtr < 20) continue; // داده کافی قبل از این نقطه نیست

      // اگر معامله باز است: اول چک کن آیا این کندل به SL یا TP1 خورده (فرض: SL/High/Low در همان کندل)
      if (position) {
        const hitSL = position.dir === 'BUY' ? bar.low <= position.sl : bar.high >= position.sl;
        const hitTP = position.dir === 'BUY' ? bar.high >= position.tp1 : bar.low <= position.tp1;
        // اگر هر دو در یک کندل ممکن باشد، به‌صورت محافظه‌کارانه فرض می‌کنیم SL زودتر خورده (بدبینانه، نه خوش‌بینانه)
        if (hitSL) {
          trades.push({ ...position, exit: position.sl, exitTime: bar.time, result: 'LOSS', r: -1 });
          position = null;
        } else if (hitTP) {
          const riskDist = Math.abs(position.entry - position.sl);
          const rewardDist = Math.abs(position.tp1 - position.entry);
          trades.push({ ...position, exit: position.tp1, exitTime: bar.time, result: 'WIN', r: fmtR(rewardDist / riskDist) });
          position = null;
        } else if (i - position.openIndex > 4 * 24) { // حداکثر نگه‌داری ~۱ روز (۹۶ کندل ۱۵دقیقه‌ای) سپس با قیمت فعلی بسته شود
          const pl = position.dir === 'BUY' ? bar.close - position.entry : position.entry - bar.close;
          const riskDist = Math.abs(position.entry - position.sl);
          trades.push({ ...position, exit: bar.close, exitTime: bar.time, result: pl >= 0 ? 'TIMEOUT_WIN' : 'TIMEOUT_LOSS', r: fmtR(pl / riskDist) });
          position = null;
        }
        continue; // تا معامله باز است، سیگنال جدید بررسی نمی‌شود
      }

      const m15Window = m15.slice(Math.max(0, i - rollingWindow + 1), i + 1);
      const h1Window = h1.slice(Math.max(0, h1Ptr - rollingWindow + 1), h1Ptr + 1);
      const h4Window = h4.slice(Math.max(0, h4Ptr - rollingWindow + 1), h4Ptr + 1);
      const dWindow = daily.slice(Math.max(0, dPtr - rollingWindow + 1), dPtr + 1);
      if (h1Window.length < 30 || h4Window.length < 30 || dWindow.length < 20) continue;

      let data;
      try {
        data = { m15: engine.analyze(m15Window), h1: engine.analyze(h1Window), h4: engine.analyze(h4Window), daily: engine.analyze(dWindow) };
      } catch (e) { continue; }

      const signal = engine.decide(data, engine.neutralFundamental(), engine.neutralNewsRisk());
      if (signal.decision === 'BUY' || signal.decision === 'SELL') {
        position = {
          dir: signal.decision, entry: bar.close, sl: signal.trade.stopLoss, tp1: signal.trade.targets[0],
          openIndex: i, openTime: bar.time, confidence: signal.confidence, agreeCount: signal.consensus.agreeCount, totalCount: signal.consensus.totalCount
        };
      }
      equityCurve.push({ time: bar.time, trades: trades.length });
    }
    if (position) { // اگر بازار در پایان بازه هنوز معامله باز داشت، با آخرین قیمت می‌بندیم
      const lastBar = m15[m15.length - 1];
      const pl = position.dir === 'BUY' ? lastBar.close - position.entry : position.entry - lastBar.close;
      const riskDist = Math.abs(position.entry - position.sl);
      trades.push({ ...position, exit: lastBar.close, exitTime: lastBar.time, result: pl >= 0 ? 'OPEN_WIN' : 'OPEN_LOSS', r: fmtR(pl / riskDist) });
    }

    const wins = trades.filter((t) => t.r > 0);
    const losses = trades.filter((t) => t.r <= 0);
    const netR = fmtR(trades.reduce((a, t) => a + t.r, 0));
    const grossWinR = wins.reduce((a, t) => a + t.r, 0);
    const grossLossR = Math.abs(losses.reduce((a, t) => a + t.r, 0));
    let peak = 0, running = 0, maxDD = 0;
    trades.forEach((t) => { running += t.r; peak = Math.max(peak, running); maxDD = Math.max(maxDD, peak - running); });

    res.json({
      status: 'LIVE',
      disclaimer: 'بک‌تست روی داده واقعی تاریخی اجرا شده، اما فاندامنتال/ریسک خبری در این بازه خنثی فرض شده‌اند، ورود دقیقاً با قیمت کندل سیگنال (نه محدوده پیشنهادی) شبیه‌سازی شده، و اسپرد/کمیسیون مدل نشده است — نتیجه واقعی معمولاً کمی ضعیف‌تر از این عدد است.',
      period: { from: new Date(m15[startIdx]?.time || 0).toISOString(), to: new Date(m15[m15.length - 1].time).toISOString(), barsAnalyzed: m15.length - startIdx },
      stats: {
        totalTrades: trades.length, winRate: trades.length ? fmtR((wins.length / trades.length) * 100) : 0,
        netR, profitFactor: grossLossR > 0 ? fmtR(grossWinR / grossLossR) : null,
        avgR: trades.length ? fmtR(netR / trades.length) : 0, maxDrawdownR: fmtR(maxDD),
        winningTrades: wins.length, losingTrades: losses.length
      },
      trades: trades.slice(-40).map((t) => ({
        dir: t.dir, entry: fmtR(t.entry), sl: fmtR(t.sl), tp1: fmtR(t.tp1), exit: fmtR(t.exit),
        result: t.result, r: t.r, openTime: new Date(t.openTime).toISOString(), exitTime: new Date(t.exitTime).toISOString(),
        confidence: t.confidence, consensus: `${t.agreeCount}/${t.totalCount}`
      }))
    });
  } catch (e) {
    res.json({ status: 'UNAVAILABLE', error: 'backtest-exception: ' + e.message });
  }
});

function fmtR(x) { return Number(Number(x).toFixed(3)); }

module.exports = router;
