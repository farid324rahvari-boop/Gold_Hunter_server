// Gold Hunter — Historical Backtest
// Independent-strategy architecture:
// - No weighted consensus is used to activate a trade.
// - Base = independent strategy trigger without the Quality layer.
// - Quality = same independent trigger + Quality layer.
// - At the moment Trend Following is the first strategy allowed to trigger;
//   the other strategies remain diagnostics until their independent engines exist.
// - Historical pagination/cache diagnostics are preserved explicitly.
// - Entry is simulated at the signal candle Close.
// - FRED/News are neutral in historical mode.
// - Spread/Commission/Slippage are not modeled.
// - MFE/MAE are measured only from candles after entry.
//
// Endpoints:
//   GET /api/backtest
//   GET /api/backtest/data-test?tf=15M&bars=220

const express = require('express');
const router = express.Router();
const engine = require('../lib/engine');

const STRATEGY_NAMES = [
  'روند چندتایم‌فریمی',
  'ساختار بازار (BOS/CHoCH)',
  'Liquidity Sweep (SMC)',
  'مومنتوم (RSI + EMA20)',
  'Fibonacci Retracement',
  'واگرایی RSI',
  'فاندامنتال (FRED)'
];

function fmtR(x) {
  return Number(Number(x).toFixed(3));
}

function advancePointer(bars, ptr, targetTime) {
  while (ptr + 1 < bars.length && bars[ptr + 1].time <= targetTime) {
    ptr++;
  }
  return ptr;
}

function historyMeta(tf, bars) {
  if (typeof engine.getHistoryMeta === 'function') {
    return engine.getHistoryMeta(tf);
  }
  return bars?.historyMeta || null;
}

function independentActive(signal, ignoreQuality) {
  if (!signal || !['BUY', 'SELL'].includes(signal.decision)) {
    return false;
  }

  return true;
}

function updateMFE(position, bar) {
  if (
    !position ||
    !bar ||
    !Number.isFinite(position.riskDist) ||
    position.riskDist <= 0
  ) {
    return;
  }

  const mfe = position.dir === 'BUY'
    ? (bar.high - position.entry) / position.riskDist
    : (position.entry - bar.low) / position.riskDist;

  const mae = position.dir === 'BUY'
    ? (bar.low - position.entry) / position.riskDist
    : (position.entry - bar.high) / position.riskDist;

  position.mfe = Math.max(position.mfe || 0, mfe);
  position.mae = Math.min(position.mae || 0, mae);
}

function simulate(
  m15,
  h1,
  h4,
  daily,
  rollingWindow,
  maxHoldBars,
  mode
) {
  let h1Ptr = 0;
  let h4Ptr = 0;
  let dPtr = 0;

  let position = null;
  const trades = [];

  const ignoreQuality = mode === 'base';
  const startIdx = Math.max(rollingWindow, 100);

  for (let i = startIdx; i < m15.length; i++) {
    const bar = m15[i];

    h1Ptr = advancePointer(h1, h1Ptr, bar.time);
    h4Ptr = advancePointer(h4, h4Ptr, bar.time);
    dPtr = advancePointer(daily, dPtr, bar.time);

    if (h1Ptr < 30 || h4Ptr < 30 || dPtr < 20) {
      continue;
    }

    // Manage already-open position.
    if (position) {
      updateMFE(position, bar);

      const age = i - position.openIndex;

      const hitSL = position.dir === 'BUY'
        ? bar.low <= position.sl
        : bar.high >= position.sl;

      const hitTP = position.dir === 'BUY'
        ? bar.high >= position.tp1
        : bar.low <= position.tp1;

      // Conservative assumption:
      // If SL and TP happen in the same candle, SL comes first.
      if (hitSL) {
        trades.push({
          ...position,
          exit: position.sl,
          exitTime: bar.time,
          result: 'LOSS',
          r: -1
        });

        position = null;
        continue;
      }

      if (hitTP) {
        const reward = Math.abs(position.tp1 - position.entry);

        const r = position.riskDist > 0
          ? reward / position.riskDist
          : 0;

        trades.push({
          ...position,
          exit: position.tp1,
          exitTime: bar.time,
          result: 'WIN',
          r: fmtR(r)
        });

        position = null;
        continue;
      }

      if (age >= maxHoldBars) {
        const pl = position.dir === 'BUY'
          ? bar.close - position.entry
          : position.entry - bar.close;

        const r = position.riskDist > 0
          ? pl / position.riskDist
          : 0;

        trades.push({
          ...position,
          exit: bar.close,
          exitTime: bar.time,
          result: r >= 0 ? 'TIMEOUT_WIN' : 'TIMEOUT_LOSS',
          r: fmtR(r)
        });

        position = null;
      }

      continue;
    }

    // Same lookback logic as live engine.
    // Never use candles after the current candle.
    const m15Window = m15.slice(
      Math.max(0, i - rollingWindow + 1),
      i + 1
    );

    const h1Window = h1.slice(
      Math.max(0, h1Ptr - rollingWindow + 1),
      h1Ptr + 1
    );

    const h4Window = h4.slice(
      Math.max(0, h4Ptr - rollingWindow + 1),
      h4Ptr + 1
    );

    const dWindow = daily.slice(
      Math.max(0, dPtr - rollingWindow + 1),
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
    } catch (_) {
      continue;
    }

    let signal;

    try {
      signal = engine.decide(
        data,
        engine.neutralFundamental(),
        engine.neutralNewsRisk(),
        { ignoreQuality }
      );
    } catch (_) {
      continue;
    }

    if (!independentActive(signal, ignoreQuality)) {
      continue;
    }

    const dir = signal.decision;

    if (!['BUY', 'SELL'].includes(dir)) {
      continue;
    }

    if (
      !signal.trade ||
      !Number.isFinite(Number(signal.trade.stopLoss)) ||
      !Array.isArray(signal.trade.targets) ||
      !signal.trade.targets.length
    ) {
      continue;
    }

    const entry = bar.close;
    const sl = Number(signal.trade.stopLoss);
    const tp1 = Number(signal.trade.targets[0]);

    const riskDist = Math.abs(entry - sl);

    if (
      !Number.isFinite(riskDist) ||
      riskDist <= 0 ||
      !Number.isFinite(tp1)
    ) {
      continue;
    }

    const votes = {};

    for (const s of signal.strategies || []) {
      if (!s?.name) continue;

      votes[s.name] =
        s.vote ||
        s.direction ||
        'NEUTRAL';
    }

    position = {
      dir,
      entry,
      sl,
      tp1,

      openIndex: i,
      openTime: bar.time,

      confidence: Number(signal.confidence || 0),

      agreeCount: Number(
        signal.consensus?.agreeCount || 0
      ),

      totalCount: Number(
        signal.consensus?.totalCount || 0
      ),

      qualityScore:
        signal.quality?.score ?? null,

      qualityGrade:
        signal.quality?.grade ?? null,

      session:
        typeof engine.getSession === 'function'
          ? engine.getSession(bar.time)
          : 'UNKNOWN',

      rr: Number(signal.trade.rr || 0),

      strategyVotes: votes,

      strategyKey:
        signal.triggerStrategy || '',

      strategyId:
        signal.triggerStrategy || null,

      mfe: 0,
      mae: 0,

      riskDist
    };
  }

  // Close an unfinished position at the last available candle.
  if (position) {
    const lastBar = m15[m15.length - 1];

    updateMFE(position, lastBar);

    const pl = position.dir === 'BUY'
      ? lastBar.close - position.entry
      : position.entry - lastBar.close;

    const r = position.riskDist > 0
      ? pl / position.riskDist
      : 0;

    trades.push({
      ...position,
      exit: lastBar.close,
      exitTime: lastBar.time,
      result: r >= 0 ? 'OPEN_WIN' : 'OPEN_LOSS',
      r: fmtR(r)
    });
  }

  return trades;
}

function median(values) {
  if (!values.length) {
    return 0;
  }

  const x = [...values].sort((a, b) => a - b);
  const m = Math.floor(x.length / 2);

  return x.length % 2
    ? x[m]
    : (x[m - 1] + x[m]) / 2;
}

function summarize(trades) {
  const total = trades.length;

  const wins = trades.filter(
    t => Number(t.r) > 0
  );

  const losses = trades.filter(
    t => Number(t.r) < 0
  );

  const breakeven = trades.filter(
    t => Number(t.r) === 0
  );

  const netR = trades.reduce(
    (a, t) => a + Number(t.r || 0),
    0
  );

  const grossProfit = wins.reduce(
    (a, t) => a + Number(t.r || 0),
    0
  );

  const grossLoss = Math.abs(
    losses.reduce(
      (a, t) => a + Number(t.r || 0),
      0
    )
  );

  let peak = 0;
  let running = 0;
  let maxDD = 0;

  for (const t of trades) {
    running += Number(t.r || 0);
    peak = Math.max(peak, running);
    maxDD = Math.max(
      maxDD,
      peak - running
    );
  }

  const durations = trades
    .filter(t => Number.isFinite(t.exitTime))
    .map(
      t =>
        (t.exitTime - t.openTime) /
        3600000
    );

  const mfes = trades.map(
    t => Number(t.mfe || 0)
  );

  const maes = trades.map(
    t => Number(t.mae || 0)
  );

  return {
    total,

    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,

    winRate: total
      ? fmtR(wins.length / total * 100)
      : 0,

    netR: fmtR(netR),

    grossProfit:
      fmtR(grossProfit),

    grossLoss:
      fmtR(grossLoss),

    profitFactor:
      grossLoss > 0
        ? fmtR(grossProfit / grossLoss)
        : null,

    avgR:
      total
        ? fmtR(netR / total)
        : 0,

    maxDD:
      fmtR(maxDD),

    avgDurationHours:
      durations.length
        ? fmtR(
            durations.reduce(
              (a, x) => a + x,
              0
            ) / durations.length
          )
        : 0,

    medianDurationHours:
      durations.length
        ? fmtR(median(durations))
        : 0,

    avgMFE:
      mfes.length
        ? fmtR(
            mfes.reduce(
              (a, x) => a + x,
              0
            ) / mfes.length
          )
        : 0,

    medianMFE:
      mfes.length
        ? fmtR(median(mfes))
        : 0,

    avgMAE:
      maes.length
        ? fmtR(
            maes.reduce(
              (a, x) => a + x,
              0
            ) / maes.length
          )
        : 0,

    medianMAE:
      maes.length
        ? fmtR(median(maes))
        : 0,

    avgRR:
      total
        ? fmtR(
            trades.reduce(
              (a, t) =>
                a + Number(t.rr || 0),
              0
            ) / total
          )
        : 0
  };
}

function groupBy(trades, fn) {
  const out = {};

  for (const t of trades) {
    const key = fn(t);

    (out[key] ||= []).push(t);
  }

  return Object.fromEntries(
    Object.entries(out).map(
      ([k, v]) => [
        k,
        summarize(v)
      ]
    )
  );
}

function strategyStats(trades) {
  const result = {};

  for (const name of STRATEGY_NAMES) {
    const buckets = {
      BUY: [],
      SELL: [],
      NEUTRAL: []
    };

    for (const t of trades) {
      const vote =
        t.strategyVotes?.[name] ||
        'NEUTRAL';

      if (buckets[vote]) {
        buckets[vote].push(t);
      }
    }

    result[name] = {
      BUY: summarize(buckets.BUY),
      SELL: summarize(buckets.SELL),
      NEUTRAL: summarize(buckets.NEUTRAL)
    };
  }

  return result;
}

function strategyCombinationStats(trades) {
  const groups = {};

  for (const t of trades) {
    const key =
      STRATEGY_NAMES
        .map(
          name =>
            t.strategyVotes?.[name] ||
            'NEUTRAL'
        )
        .join(' + ');

    (groups[key] ||= []).push(t);
  }

  return Object.fromEntries(
    Object.entries(groups).map(
      ([key, items]) => [
        key,
        {
          ...summarize(items),
          direction:
            items[0]?.dir || null,
          sample: items.length
        }
      ]
    )
  );
}

function consensusCompositionStats(trades) {
  const groups = {};

  for (const t of trades) {
    const values =
      Object.values(
        t.strategyVotes || {}
      );

    const buy =
      values.filter(
        v => v === 'BUY'
      ).length;

    const sell =
      values.filter(
        v => v === 'SELL'
      ).length;

    const neutral =
      values.filter(
        v => v === 'NEUTRAL'
      ).length;

    const key =
      `${buy} BUY / ${sell} SELL / ${neutral} NEUTRAL`;

    (groups[key] ||= []).push(t);
  }

  return Object.fromEntries(
    Object.entries(groups).map(
      ([key, items]) => [
        key,
        {
          ...summarize(items),
          sample: items.length
        }
      ]
    )
  );
}

function cleanTrades(trades) {
  return trades
    .slice(-100)
    .map(t => ({
      dir: t.dir,

      entry: fmtR(t.entry),
      sl: fmtR(t.sl),
      tp1: fmtR(t.tp1),
      exit: fmtR(t.exit),

      result: t.result,
      r: fmtR(t.r),

      mfe: fmtR(t.mfe),
      mae: fmtR(t.mae),

      confidence:
        fmtR(t.confidence),

      consensus:
        `${t.agreeCount}/${t.totalCount}`,

      qualityScore:
        t.qualityScore != null
          ? fmtR(t.qualityScore)
          : null,

      qualityGrade:
        t.qualityGrade,

      session:
        t.session,

      rr:
        fmtR(t.rr),

      strategyId:
        t.strategyId,

      strategyVotes:
        t.strategyVotes || {},

      strategyKey:
        t.strategyKey || '',

      openTime:
        new Date(
          t.openTime
        ).toISOString(),

      exitTime:
        new Date(
          t.exitTime
        ).toISOString()
    }));
}


/* =========================================================
   LIGHTWEIGHT DATA TEST
   =========================================================

   این Route فقط مسیر دریافت داده تاریخی و Cache را تست می‌کند.

   مثال:
   /api/backtest/data-test?tf=15M&bars=220

   تایم‌فریم‌های مجاز:
   15M
   1H
   4H
   Daily

   این تست وارد محاسبات استراتژی و بک‌تست کامل نمی‌شود.
   بنابراین برای بررسی سالم بودن:
   TwelveData -> Cache -> engine.fetchTFHistory()
   مناسب است.
*/

router.get('/data-test', async (req, res) => {
  const allowedTimeframes = [
    '15M',
    '1H',
    '4H',
    'Daily'
  ];

  const requestedTF =
    String(
      req.query.tf || '15M'
    ).trim();

  const tf =
    allowedTimeframes.find(
      item =>
        item.toLowerCase() ===
        requestedTF.toLowerCase()
    );

  if (!tf) {
    return res.status(400).json({
      ok: false,
      status: 'INVALID_REQUEST',
      error: 'invalid-timeframe',
      allowedTimeframes
    });
  }

  const defaultBars =
    tf === '15M'
      ? 220
      : 100;

  const requestedBars =
    Math.max(
      20,
      Math.min(
        Number(req.query.bars) ||
          defaultBars,
        5000
      )
    );

  if (!process.env.TWELVEDATA_API_KEY) {
    return res.json({
      ok: false,
      status: 'UNAVAILABLE',
      error: 'no-api-key-configured',
      timeframe: tf,
      requested: requestedBars
    });
  }

  const startedAt =
    Date.now();

  try {
    /*
     * مهم:
     * از همان تابعی استفاده می‌کنیم که بک‌تست اصلی
     * برای دریافت تاریخچه استفاده می‌کند.
     *
     * بنابراین این تست فقط یک Route جداگانه نیست؛
     * مسیر واقعی Cache/Provider را آزمایش می‌کند.
     */
    const bars =
      await engine.fetchTFHistory(
        tf,
        requestedBars
      );

    const returned =
      Array.isArray(bars)
        ? bars.length
        : 0;

    const meta =
      historyMeta(
        tf,
        bars
      );

    if (!returned) {
      return res.json({
        ok: false,
        status: 'UNAVAILABLE',

        timeframe: tf,

        requested:
          requestedBars,

        returned: 0,

        elapsedMs:
          Date.now() - startedAt,

        history: meta,

        message:
          meta?.providerLimited
            ? 'Provider limit/error prevented historical data from being returned.'
            : 'No historical bars were returned.'
      });
    }

    const first =
      bars[0];

    const last =
      bars[bars.length - 1];

    return res.json({
      ok: true,

      status: 'OK',

      timeframe: tf,

      requested:
        requestedBars,

      returned,

      complete:
        returned >= requestedBars,

      elapsedMs:
        Date.now() - startedAt,

      firstBar:
        first
          ? {
              time:
                new Date(
                  first.time
                ).toISOString(),

              open: first.open,
              high: first.high,
              low: first.low,
              close: first.close
            }
          : null,

      lastBar:
        last
          ? {
              time:
                new Date(
                  last.time
                ).toISOString(),

              open: last.open,
              high: last.high,
              low: last.low,
              close: last.close
            }
          : null,

      history: meta,

      cacheTest: {
        endpointUsesSameFetchTFHistoryPath:
          true,

        note:
          'Run the same URL twice. The second request should normally use the historical cache when the cache TTL has not expired.'
      }
    });

  } catch (e) {
    console.error(
      '[backtest/data-test]',
      e
    );

    return res.json({
      ok: false,

      status:
        'UNAVAILABLE',

      timeframe: tf,

      requested:
        requestedBars,

      returned: 0,

      elapsedMs:
        Date.now() - startedAt,

      error:
        'data-test-exception: ' +
        String(
          e.message || e
        )
    });
  }
});


/* =========================================================
   FULL BACKTEST
   ========================================================= */

router.get('/', async (req, res) => {
  if (!process.env.TWELVEDATA_API_KEY) {
    return res.json({
      status: 'UNAVAILABLE',
      error:
        'no-api-key-configured'
    });
  }

  const requestedBars =
    Math.max(
      1000,
      Math.min(
        Number(req.query.bars) ||
          10000,
        50000
      )
    );

  const months =
    Math.max(
      1,
      Math.min(
        Number(req.query.months) ||
          6,
        24
      )
    );

  const rollingWindow =
    Math.max(
      100,
      Math.min(
        Number(
          req.query.rollingWindow
        ) || 220,
        500
      )
    );

  const maxHoldDays =
    Math.max(
      1,
      Math.min(
        Number(
          req.query.maxHoldDays
        ) || 3,
        10
      )
    );

  const maxHoldBars =
    maxHoldDays * 24 * 4;

  const modeRaw =
    String(
      req.query.mode ||
        'compare'
    ).toLowerCase();

  const mode =
    [
      'base',
      'quality',
      'compare'
    ].includes(modeRaw)
      ? modeRaw
      : 'compare';

  const fetchBars =
    Math.min(
      requestedBars +
        rollingWindow,
      50000
    );

  try {
    const [
      m15,
      h1,
      h4,
      daily
    ] = await Promise.all([
      engine.fetchTFHistory(
        '15M',
        fetchBars
      ),

      engine.fetchTFHistory(
        '1H',
        Math.ceil(
          fetchBars / 4
        ) + rollingWindow
      ),

      engine.fetchTFHistory(
        '4H',
        Math.ceil(
          fetchBars / 16
        ) + rollingWindow
      ),

      engine.fetchTFHistory(
        'Daily',
        Math.ceil(
          fetchBars / 96
        ) + rollingWindow
      )
    ]);

    const history = {
      '15M':
        historyMeta(
          '15M',
          m15
        ),

      '1H':
        historyMeta(
          '1H',
          h1
        ),

      '4H':
        historyMeta(
          '4H',
          h4
        ),

      'Daily':
        historyMeta(
          'Daily',
          daily
        )
    };

    if (
      !m15 ||
      !h1 ||
      !h4 ||
      !daily
    ) {
      return res.json({
        status:
          'UNAVAILABLE',

        error:
          'market-data-unavailable',

        history
      });
    }

    if (
      m15.length <
      Math.min(
        fetchBars,
        rollingWindow + 100
      )
    ) {
      return res.json({
        status:
          'UNAVAILABLE',

        error:
          'insufficient-history-for-backtest',

        barsReceived:
          m15.length,

        requestedBars,

        requestedHistoricalBars:
          fetchBars,

        history
      });
    }

    // Requested sample = last requestedBars M15 candles.
    const testM15 =
      m15.slice(
        -requestedBars
      );

    let baseTrades = [];
    let qualityTrades = [];

    if (
      mode === 'base' ||
      mode === 'compare'
    ) {
      baseTrades =
        simulate(
          testM15,
          h1,
          h4,
          daily,
          rollingWindow,
          maxHoldBars,
          'base'
        );
    }

    if (
      mode === 'quality' ||
      mode === 'compare'
    ) {
      qualityTrades =
        simulate(
          testM15,
          h1,
          h4,
          daily,
          rollingWindow,
          maxHoldBars,
          'quality'
        );
    }

    const baseSummary =
      summarize(baseTrades);

    const qualitySummary =
      summarize(
        qualityTrades
      );

    const selectedTrades =
      mode === 'base'
        ? baseTrades
        : qualityTrades;

    const selectedStats =
      mode === 'base'
        ? baseSummary
        : qualitySummary;

    const comparison = {
      baseTrades:
        baseSummary.total,

      qualityTrades:
        qualitySummary.total,

      retention:
        baseSummary.total
          ? fmtR(
              qualitySummary.total /
              baseSummary.total *
              100
            )
          : 0,

      filtered:
        Math.max(
          0,
          baseSummary.total -
          qualitySummary.total
        ),

      netRDelta:
        fmtR(
          qualitySummary.netR -
          baseSummary.netR
        ),

      winRateDelta:
        fmtR(
          qualitySummary.winRate -
          baseSummary.winRate
        ),

      profitFactorDelta:
        qualitySummary.profitFactor != null &&
        baseSummary.profitFactor != null
          ? fmtR(
              qualitySummary.profitFactor -
              baseSummary.profitFactor
            )
          : null,

      avgRDelta:
        fmtR(
          qualitySummary.avgR -
          baseSummary.avgR
        ),

      maxDDDelta:
        fmtR(
          qualitySummary.maxDD -
          baseSummary.maxDD
        ),

      avgMFEDelta:
        fmtR(
          qualitySummary.avgMFE -
          baseSummary.avgMFE
        ),

      avgMAEDelta:
        fmtR(
          qualitySummary.avgMAE -
          baseSummary.avgMAE
        )
    };

    const firstTime =
      testM15[0]?.time ||
      null;

    const lastTime =
      testM15[
        testM15.length - 1
      ]?.time ||
      null;

    const actualMonths =
      firstTime &&
      lastTime
        ? (
            lastTime -
            firstTime
          ) /
          (
            1000 *
            60 *
            60 *
            24 *
            30.4375
          )
        : 0;

    return res.json({
      ok: true,

      status: 'LIVE',

      mode,

      architecture:
        'INDEPENDENT_STRATEGIES',

      disclaimer:
        'بک‌تست روی داده تاریخی واقعی TwelveData اجرا شده است. هر استراتژی به‌صورت مستقل بررسی می‌شود و اجماع وزنی شرط ورود نیست. در نسخه فعلی فقط Trend Following اجازه فعال‌کردن معامله را دارد و سایر استراتژی‌ها diagnostics هستند. FRED و News در تاریخ خنثی فرض شده‌اند؛ ورود روی Close کندل سیگنال انجام شده؛ Spread/Commission/Slippage مدل نشده‌اند؛ MFE/MAE فقط از کندل‌های بعد از ورود محاسبه می‌شوند.',

      period: {
        from:
          firstTime
            ? new Date(
                firstTime
              ).toISOString()
            : null,

        to:
          lastTime
            ? new Date(
                lastTime
              ).toISOString()
            : null,

        requestedBars,

        barsAnalyzed:
          testM15.length,

        monthsRequested:
          months,

        actualMonths:
          fmtR(actualMonths)
      },

      parameters: {
        rollingWindow,

        maxHoldDays,

        maxHoldBars,

        minConfidence:
          engine.MIN_CONFIDENCE,

        minRR:
          engine.MIN_RR
      },

      stats:
        selectedStats,

      baseStats:
        baseSummary,

      qualityStats:
        qualitySummary,

      comparison,

      direction:
        groupBy(
          selectedTrades,
          t => t.dir
        ),

      sessions:
        groupBy(
          selectedTrades,
          t =>
            t.session ||
            'UNKNOWN'
        ),

      confidence:
        groupBy(
          selectedTrades,
          t => {
            const c =
              Number(
                t.confidence ||
                0
              );

            if (c < 70)
              return '<70';

            if (c < 80)
              return '70-79';

            if (c < 90)
              return '80-89';

            return '90-100';
          }
        ),

      quality:
        groupBy(
          selectedTrades,
          t => {
            const q =
              Number(
                t.qualityScore ||
                0
              );

            if (q < 65)
              return '<65';

            if (q < 75)
              return '65-74';

            if (q < 85)
              return '75-84';

            return '85-100';
          }
        ),

      rr:
        groupBy(
          selectedTrades,
          t => {
            const rr =
              Number(
                t.rr ||
                0
              );

            if (rr < 1.5)
              return '<1.5';

            if (rr < 2)
              return '1.5-1.99';

            if (rr < 3)
              return '2-2.99';

            return '3+';
          }
        ),

      strategyStats:
        strategyStats(
          selectedTrades
        ),

      strategyCombinations:
        strategyCombinationStats(
          selectedTrades
        ),

      consensusComposition:
        consensusCompositionStats(
          selectedTrades
        ),

      trades:
        cleanTrades(
          selectedTrades
        ),

      diagnostics: {
        baseTradeCount:
          baseTrades.length,

        qualityTradeCount:
          qualityTrades.length,

        qualityRetention:
          comparison.retention,

        qualityFiltered:
          comparison.filtered,

        historicalBarsReturned:
          m15.length,

        requestedHistoricalBars:
          fetchBars,

        testBars:
          testM15.length,

        strategyCount:
          7,

        independentArchitecture:
          true,

        activeStrategyEngines:
          [
            'TREND_FOLLOWING'
          ],

        diagnosticOnlyStrategies:
          [
            'STRUCTURE',
            'LIQUIDITY_SWEEP',
            'MOMENTUM',
            'FIBONACCI',
            'RSI_DIVERGENCE',
            'FUNDAMENTAL'
          ],

        history
      }
    });

  } catch (e) {
    console.error(
      '[backtest]',
      e
    );

    return res.json({
      status:
        'UNAVAILABLE',

      error:
        'backtest-exception: ' +
        e.message
    });
  }
});

module.exports = router;
