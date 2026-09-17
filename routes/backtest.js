// /api/backtest — بک‌تست واقعی روی داده تاریخی واقعی TwelveData
//
// همان موتور تصمیم lib/engine.js که در /api/signal زنده استفاده می‌شود.
//
// قابلیت‌های اضافه:
// - 20k پیش‌فرض / حداکثر 50k کندل 15M
// - BUY / SELL جداگانه
// - Consensus جداگانه
// - Confidence buckets
// - Hour / Session analysis
// - Trade duration
// - MFE / MAE
// - R:R
// - Max Drawdown
//
// محدودیت‌ها:
// 1) FRED و Finnhub به‌صورت تاریخی لحظه‌ای در این بک‌تست در دسترس نیستند.
//    بنابراین Fundamental و News در بک‌تست خنثی هستند.
// 2) ورود برابر Close کندل سیگنال است.
// 3) Spread / Commission / Slippage مدل نشده‌اند.
// 4) عمق داده تابع محدودیت TwelveData است.

const express = require('express');
const router = express.Router();
const engine = require('../lib/engine');

function advancePointer(bars, ptr, targetTime) {
  while (ptr + 1 < bars.length && bars[ptr + 1].time <= targetTime) {
    ptr++;
  }
  return ptr;
}

function fmtR(x) {
  if (!Number.isFinite(Number(x))) return 0;
  return Number(Number(x).toFixed(3));
}

function pct(x) {
  if (!Number.isFinite(Number(x))) return 0;
  return Number(Number(x).toFixed(2));
}

function getHour(isoTime) {
  return new Date(isoTime).getUTCHours();
}

function getSession(hour) {
  if (hour < 8) return 'ASIA';
  if (hour < 13) return 'LONDON';
  if (hour < 17) return 'NEW_YORK';
  return 'NEW_YORK_LATE';
}

function summarizeTrades(trades) {
  const wins = trades.filter(t => t.r > 0);
  const losses = trades.filter(t => t.r <= 0);

  const netR = trades.reduce((a, t) => a + t.r, 0);
  const grossWinR = wins.reduce((a, t) => a + t.r, 0);
  const grossLossR = Math.abs(
    losses.reduce((a, t) => a + t.r, 0)
  );

  let peak = 0;
  let running = 0;
  let maxDD = 0;

  trades.forEach(t => {
    running += t.r;
    peak = Math.max(peak, running);
    maxDD = Math.max(maxDD, peak - running);
  });

  const durations = trades
    .map(t => Number(t.durationMinutes))
    .filter(Number.isFinite);

  const mfe = trades
    .map(t => Number(t.mfeR))
    .filter(Number.isFinite);

  const mae = trades
    .map(t => Number(t.maeR))
    .filter(Number.isFinite);

  const avg = arr =>
    arr.length
      ? arr.reduce((a, b) => a + b, 0) / arr.length
      : 0;

  return {
    trades: trades.length,

    wins: wins.length,
    losses: losses.length,

    winRate: trades.length
      ? pct((wins.length / trades.length) * 100)
      : 0,

    netR: fmtR(netR),

    profitFactor:
      grossLossR > 0
        ? fmtR(grossWinR / grossLossR)
        : null,

    avgR:
      trades.length
        ? fmtR(netR / trades.length)
        : 0,

    maxDrawdownR: fmtR(maxDD),

    avgDurationMinutes: pct(avg(durations)),
    avgDurationHours: pct(avg(durations) / 60),

    avgMFER: fmtR(avg(mfe)),
    avgMAER: fmtR(avg(mae))
  };
}

function groupPerformance(trades, keyFn) {
  const groups = {};

  for (const t of trades) {
    const key = String(keyFn(t));

    if (!groups[key]) {
      groups[key] = [];
    }

    groups[key].push(t);
  }

  const result = {};

  for (const [key, list] of Object.entries(groups)) {
    result[key] = summarizeTrades(list);
  }

  return result;
}

router.get('/', async (req, res) => {
  if (!process.env.TWELVEDATA_API_KEY) {
    return res.json({
      status: 'UNAVAILABLE',
      error: 'no-api-key-configured'
    });
  }

  /*
   * 20,000 کندل پیش‌فرض
   * حداکثر 50,000
   *
   * مثال:
   * /api/backtest?bars=20000
   * /api/backtest?bars=50000
   */
  const requestedBars = Number(req.query.bars);

  const m15Bars = Math.min(
    Math.max(
      Number.isFinite(requestedBars) && requestedBars > 0
        ? Math.floor(requestedBars)
        : 20000,
      1000
    ),
    50000
  );

  const rollingWindow = 220;

  /*
   * حداکثر زمان نگهداری معامله:
   * پیش‌فرض 3 روز
   * 15M => 96 کندل در روز
   */
  const maxHoldDays = Math.min(
    Math.max(Number(req.query.maxHoldDays) || 3, 1),
    10
  );

  const maxHoldBars = maxHoldDays * 96;

  try {
    const [m15, h1, h4, daily] = await Promise.all([
      engine.fetchTFHistory(
        '15M',
        m15Bars + rollingWindow
      ),

      engine.fetchTFHistory(
        '1H',
        Math.ceil((m15Bars + rollingWindow) / 4) +
          rollingWindow
      ),

      engine.fetchTFHistory(
        '4H',
        Math.ceil((m15Bars + rollingWindow) / 16) +
          rollingWindow
      ),

      engine.fetchTFHistory(
        'Daily',
        Math.ceil((m15Bars + rollingWindow) / 96) +
          rollingWindow
      )
    ]);

    if (!m15 || !h1 || !h4 || !daily) {
      return res.json({
        status: 'UNAVAILABLE',
        error: 'market-data-unavailable'
      });
    }

    if (m15.length < rollingWindow + 50) {
      return res.json({
        status: 'UNAVAILABLE',
        error: 'insufficient-history-for-backtest'
      });
    }

    let h1Ptr = 0;
    let h4Ptr = 0;
    let dPtr = 0;

    const trades = [];

    let position = null;

    const startIdx = Math.max(
      rollingWindow,
      100
    );

    for (
      let i = startIdx;
      i < m15.length;
      i++
    ) {
      const bar = m15[i];

      h1Ptr = advancePointer(
        h1,
        h1Ptr,
        bar.time
      );

      h4Ptr = advancePointer(
        h4,
        h4Ptr,
        bar.time
      );

      dPtr = advancePointer(
        daily,
        dPtr,
        bar.time
      );

      if (
        h1Ptr < rollingWindow - 30 ||
        h4Ptr < 30 ||
        dPtr < 20
      ) {
        continue;
      }

      /*
       * مدیریت معامله باز
       */
      if (position) {
        const riskDist = Math.abs(
          position.entry - position.sl
        );

        /*
         * MFE / MAE
         *
         * MFE:
         * بیشترین سود شناور در طول معامله
         *
         * MAE:
         * بیشترین زیان شناور در طول معامله
         */
        let favorableR;
        let adverseR;

        if (position.dir === 'BUY') {
          favorableR =
            (bar.high - position.entry) /
            riskDist;

          adverseR =
            (bar.low - position.entry) /
            riskDist;
        } else {
          favorableR =
            (position.entry - bar.low) /
            riskDist;

          adverseR =
            (position.entry - bar.high) /
            riskDist;
        }

        position.mfeR = Math.max(
          position.mfeR,
          favorableR
        );

        position.maeR = Math.min(
          position.maeR,
          adverseR
        );

        const hitSL =
          position.dir === 'BUY'
            ? bar.low <= position.sl
            : bar.high >= position.sl;

        const hitTP =
          position.dir === 'BUY'
            ? bar.high >= position.tp1
            : bar.low <= position.tp1;

        /*
         * اگر SL و TP در یک کندل هر دو لمس شوند:
         * محافظه‌کارانه SL را اول در نظر می‌گیریم.
         */
        if (hitSL) {
          const closed = {
            ...position,

            exit: position.sl,

            exitTime: bar.time,

            result: 'LOSS',

            r: -1
          };

          closed.durationMinutes =
            (
              new Date(closed.exitTime).getTime() -
              new Date(closed.openTime).getTime()
            ) / 60000;

          trades.push(closed);

          position = null;

          continue;
        }

        if (hitTP) {
          const rewardDist =
            Math.abs(
              position.tp1 -
              position.entry
            );

          const r =
            rewardDist / riskDist;

          const closed = {
            ...position,

            exit: position.tp1,

            exitTime: bar.time,

            result: 'WIN',

            r: fmtR(r)
          };

          closed.durationMinutes =
            (
              new Date(closed.exitTime).getTime() -
              new Date(closed.openTime).getTime()
            ) / 60000;

          trades.push(closed);

          position = null;

          continue;
        }

        /*
         * Timeout
         */
        if (
          i - position.openIndex >=
          maxHoldBars
        ) {
          const pl =
            position.dir === 'BUY'
              ? bar.close - position.entry
              : position.entry - bar.close;

          const r =
            pl / riskDist;

          const closed = {
            ...position,

            exit: bar.close,

            exitTime: bar.time,

            result:
              r >= 0
                ? 'TIMEOUT_WIN'
                : 'TIMEOUT_LOSS',

            r: fmtR(r)
          };

          closed.durationMinutes =
            (
              new Date(closed.exitTime).getTime() -
              new Date(closed.openTime).getTime()
            ) / 60000;

          trades.push(closed);

          position = null;

          continue;
        }

        continue;
      }

      /*
       * پنجره‌های تحلیلی
       */
      const m15Window = m15.slice(
        Math.max(
          0,
          i - rollingWindow + 1
        ),
        i + 1
      );

      const h1Window = h1.slice(
        Math.max(
          0,
          h1Ptr - rollingWindow + 1
        ),
        h1Ptr + 1
      );

      const h4Window = h4.slice(
        Math.max(
          0,
          h4Ptr - rollingWindow + 1
        ),
        h4Ptr + 1
      );

      const dWindow = daily.slice(
        Math.max(
          0,
          dPtr - rollingWindow + 1
        ),
        dPtr + 1
      );

      if (
        h1Window.length < 30 ||
        h4Window.length < 30 ||
        dWindow.length < 20
      ) {
        continue;
      }

      let data;

      try {
        data = {
          m15: engine.analyze(m15Window),
          h1: engine.analyze(h1Window),
          h4: engine.analyze(h4Window),
          daily: engine.analyze(dWindow)
        };
      } catch (e) {
        continue;
      }

      /*
       * Fundamental و News عمداً neutral هستند.
       */
      const signal = engine.decide(
        data,
        engine.neutralFundamental(),
        engine.neutralNewsRisk()
      );

      if (
        signal.decision === 'BUY' ||
        signal.decision === 'SELL'
      ) {
        const entry = bar.close;
        const sl = signal.trade.stopLoss;
        const tp1 = signal.trade.targets[0];

        const riskDist = Math.abs(
          entry - sl
        );

        const rewardDist = Math.abs(
          tp1 - entry
        );

        position = {
          dir: signal.decision,

          entry,

          sl,

          tp1,

          rr:
            riskDist > 0
              ? fmtR(
                  rewardDist /
                    riskDist
                )
              : null,

          openIndex: i,

          openTime: bar.time,

          confidence:
            signal.confidence,

          agreeCount:
            signal.consensus.agreeCount,

          totalCount:
            signal.consensus.totalCount,

          hour: getHour(bar.time),

          session:
            getSession(
              getHour(bar.time)
            ),

          /*
           * از لحظه ورود:
           * MFE = بیشترین R مثبت
           * MAE = بدترین R منفی
           */
          mfeR: 0,

          maeR: 0
        };
      }
    }

    /*
     * معامله باز در انتهای دیتاست
     */
    if (position) {
      const lastBar =
        m15[m15.length - 1];

      const riskDist =
        Math.abs(
          position.entry -
            position.sl
        );

      const pl =
        position.dir === 'BUY'
          ? lastBar.close -
            position.entry
          : position.entry -
            lastBar.close;

      const r =
        riskDist > 0
          ? pl / riskDist
          : 0;

      /*
       * آخرین MFE/MAE
       */
      if (position.dir === 'BUY') {
        position.mfeR = Math.max(
          position.mfeR,
          (lastBar.high -
            position.entry) /
            riskDist
        );

        position.maeR = Math.min(
          position.maeR,
          (lastBar.low -
            position.entry) /
            riskDist
        );
      } else {
        position.mfeR = Math.max(
          position.mfeR,
          (position.entry -
            lastBar.low) /
            riskDist
        );

        position.maeR = Math.min(
          position.maeR,
          (position.entry -
            lastBar.high) /
            riskDist
        );
      }

      const closed = {
        ...position,

        exit: lastBar.close,

        exitTime: lastBar.time,

        result:
          r >= 0
            ? 'OPEN_WIN'
            : 'OPEN_LOSS',

        r: fmtR(r)
      };

      closed.durationMinutes =
        (
          new Date(closed.exitTime).getTime() -
          new Date(closed.openTime).getTime()
        ) / 60000;

      trades.push(closed);
    }

    /*
     * =========================================================
     * FINAL STATISTICS
     * =========================================================
     */

    const total = summarizeTrades(
      trades
    );

    const buyTrades =
      trades.filter(
        t => t.dir === 'BUY'
      );

    const sellTrades =
      trades.filter(
        t => t.dir === 'SELL'
      );

    /*
     * Consensus
     */
    const consensus = groupPerformance(
      trades,
      t =>
        `${t.agreeCount}/${t.totalCount}`
    );

    /*
     * Confidence buckets
     */
    const confidence = {
      '70-79': summarizeTrades(
        trades.filter(
          t =>
            t.confidence >= 70 &&
            t.confidence < 80
        )
      ),

      '80-89': summarizeTrades(
        trades.filter(
          t =>
            t.confidence >= 80 &&
            t.confidence < 90
        )
      ),

      '90-100': summarizeTrades(
        trades.filter(
          t =>
            t.confidence >= 90 &&
            t.confidence <= 100
        )
      )
    };

    /*
     * Hour UTC
     */
    const hour = {};

    for (let h = 0; h < 24; h++) {
      hour[String(h).padStart(2, '0')] =
        summarizeTrades(
          trades.filter(
            t => t.hour === h
          )
        );
    }

    /*
     * Session
     */
    const sessions = {
      ASIA: summarizeTrades(
        trades.filter(
          t => t.session === 'ASIA'
        )
      ),

      LONDON: summarizeTrades(
        trades.filter(
          t => t.session === 'LONDON'
        )
      ),

      NEW_YORK: summarizeTrades(
        trades.filter(
          t => t.session === 'NEW_YORK'
        )
      ),

      NEW_YORK_LATE: summarizeTrades(
        trades.filter(
          t =>
            t.session ===
            'NEW_YORK_LATE'
        )
      )
    };

    /*
     * R:R buckets
     */
    const rrBuckets = {
      '<1.5': summarizeTrades(
        trades.filter(
          t => Number(t.rr) < 1.5
        )
      ),

      '1.5-1.99': summarizeTrades(
        trades.filter(
          t =>
            Number(t.rr) >= 1.5 &&
            Number(t.rr) < 2
        )
      ),

      '2-2.99': summarizeTrades(
        trades.filter(
          t =>
            Number(t.rr) >= 2 &&
            Number(t.rr) < 3
        )
      ),

      '3+': summarizeTrades(
        trades.filter(
          t => Number(t.rr) >= 3
        )
      )
    };

    /*
     * خروجی معاملات
     */
    const formattedTrades =
      trades.slice(-100).map(t => ({
        dir: t.dir,

        entry: fmtR(t.entry),

        sl: fmtR(t.sl),

        tp1: fmtR(t.tp1),

        rr: t.rr,

        exit: fmtR(t.exit),

        result: t.result,

        r: t.r,

        openTime:
          new Date(
            t.openTime
          ).toISOString(),

        exitTime:
          new Date(
            t.exitTime
          ).toISOString(),

        durationMinutes:
          pct(t.durationMinutes),

        durationHours:
          pct(
            t.durationMinutes / 60
          ),

        confidence:
          t.confidence,

        consensus:
          `${t.agreeCount}/${t.totalCount}`,

        hourUTC:
          t.hour,

        session:
          t.session,

        mfeR:
          fmtR(t.mfeR),

        maeR:
          fmtR(t.maeR)
      }));

    /*
     * پاسخ نهایی
     */
    return res.json({
      status: 'LIVE',

      disclaimer:
        'بک‌تست روی داده واقعی تاریخی اجرا شده؛ فاندامنتال/ریسک خبری در این بازه خنثی فرض شده‌اند، ورود با قیمت بسته‌شدن کندل سیگنال شبیه‌سازی شده و اسپرد/کمیسیون/Slippage مدل نشده است. بنابراین این نتایج تضمین‌کننده عملکرد آینده نیستند. داده‌های TwelveData برای بازه‌های بزرگ به‌صورت chunk شده دریافت می‌شوند.',

      config: {
        requestedBars: m15Bars,

        maxHoldDays,

        maxHoldBars,

        timeframe: '15M',

        rollingWindow
      },

      period: {
        from:
          new Date(
            m15[startIdx]?.time || 0
          ).toISOString(),

        to:
          new Date(
            m15[m15.length - 1].time
          ).toISOString(),

        barsAnalyzed:
          m15.length - startIdx
      },

      stats: total,

      direction: {
        BUY: summarizeTrades(
          buyTrades
        ),

        SELL: summarizeTrades(
          sellTrades
        )
      },

      consensus,

      confidence,

      hourUTC: hour,

      sessions,

      rrBuckets,

      trades: formattedTrades
    });
  } catch (e) {
    return res.json({
      status: 'UNAVAILABLE',

      error:
        'backtest-exception: ' +
        e.message
    });
  }
});

module.exports = router;
