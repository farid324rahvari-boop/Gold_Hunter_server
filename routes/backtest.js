// Gold Hunter — Historical Backtest
//
// Base = موتور اصلی با شروط پایه
// Quality = موتور اصلی + Quality Engine
//
// نکات:
// - ورود روی Close کندل سیگنال
// - FRED و News در بک‌تست خنثی
// - Spread / Commission / Slippage مدل نشده
// - MFE / MAE از بعد ورود تا خروج
// - Strategy diagnostics فعال
// - Base و Quality به صورت جداگانه اجرا می‌شوند

const express = require('express');

const router =
  express.Router();

const engine =
  require('../lib/engine');

function fmtR(x) {
  return Number(
    Number(x).toFixed(3)
  );
}

function advancePointer(
  bars,
  ptr,
  targetTime
) {
  while (
    ptr + 1 < bars.length &&
    bars[ptr + 1].time <=
      targetTime
  ) {
    ptr++;
  }

  return ptr;
}

function getBaseActive(
  signal
) {
  if (
    !signal ||
    !['BUY', 'SELL']
      .includes(
        signal.direction
      )
  ) {
    return false;
  }

  if (
    Number(
      signal.confidence || 0
    ) <
    Number(
      engine.MIN_CONFIDENCE
    )
  ) {
    return false;
  }

  if (
    Number(
      signal.consensus
        ?.agreeCount || 0
    ) <
    Math.ceil(
      Number(
        signal.consensus
          ?.totalCount || 7
      ) / 2
    )
  ) {
    return false;
  }

  if (
    Array.isArray(
      signal.blockers
    ) &&
    signal.blockers.length > 0
  ) {
    return false;
  }

  return true;
}

function getQualityActive(
  signal
) {
  return (
    signal &&
    (
      signal.decision ===
        'BUY' ||
      signal.decision ===
        'SELL'
    )
  );
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

  const trades = [];

  let position = null;

  const startIdx =
    Math.max(
      rollingWindow,
      100
    );

  for (
    let i = startIdx;
    i < m15.length;
    i++
  ) {
    const bar =
      m15[i];

    h1Ptr =
      advancePointer(
        h1,
        h1Ptr,
        bar.time
      );

    h4Ptr =
      advancePointer(
        h4,
        h4Ptr,
        bar.time
      );

    dPtr =
      advancePointer(
        daily,
        dPtr,
        bar.time
      );

    if (
      h1Ptr <
      rollingWindow - 30
    ) {
      continue;
    }

    if (
      h4Ptr < 30
    ) {
      continue;
    }

    if (
      dPtr < 20
    ) {
      continue;
    }

    /*
     * مدیریت معامله باز
     */
    if (position) {

      const age =
        i -
        position.openIndex;

      const hitSL =
        position.dir === 'BUY'
          ? bar.low <=
            position.sl
          : bar.high >=
            position.sl;

      const hitTP =
        position.dir === 'BUY'
          ? bar.high >=
            position.tp1
          : bar.low <=
            position.tp1;

      /*
       * اگر هر دو در یک کندل رخ داده باشند،
       * محافظه‌کارانه SL را اول در نظر می‌گیریم.
       */
      if (hitSL) {

        const exit =
          position.sl;

        const r = -1;

        updateMFE(
          position,
          bar
        );

        trades.push({
          ...position,

          exit,

          exitTime:
            bar.time,

          result:
            'LOSS',

          r
        });

        position = null;

        continue;
      }

      if (hitTP) {

        const exit =
          position.tp1;

        const riskDist =
          Math.abs(
            position.entry -
            position.sl
          );

        const rewardDist =
          Math.abs(
            position.tp1 -
            position.entry
          );

        const r =
          riskDist > 0
            ? rewardDist /
              riskDist
            : 0;

        updateMFE(
          position,
          bar
        );

        trades.push({
          ...position,

          exit,

          exitTime:
            bar.time,

          result:
            'WIN',

          r:
            fmtR(r)
        });

        position = null;

        continue;
      }

      if (
        age >=
        maxHoldBars
      ) {

        updateMFE(
          position,
          bar
        );

        const pl =
          position.dir === 'BUY'
            ? bar.close -
              position.entry
            : position.entry -
              bar.close;

        const riskDist =
          Math.abs(
            position.entry -
            position.sl
          );

        const r =
          riskDist > 0
            ? pl /
              riskDist
            : 0;

        trades.push({
          ...position,

          exit:
            bar.close,

          exitTime:
            bar.time,

          result:
            r >= 0
              ? 'TIMEOUT_WIN'
              : 'TIMEOUT_LOSS',

          r:
            fmtR(r)
        });

        position = null;

        continue;
      }

      updateMFE(
        position,
        bar
      );

      continue;
    }

    /*
     * Windows
     */
    const m15Window =
      m15.slice(
        Math.max(
          0,
          i -
            rollingWindow +
            1
        ),
        i + 1
      );

    const h1Window =
      h1.slice(
        Math.max(
          0,
          h1Ptr -
            rollingWindow +
            1
        ),
        h1Ptr + 1
      );

    const h4Window =
      h4.slice(
        Math.max(
          0,
          h4Ptr -
            rollingWindow +
            1
        ),
        h4Ptr + 1
      );

    const dWindow =
      daily.slice(
        Math.max(
          0,
          dPtr -
            rollingWindow +
            1
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
        m15:
          engine.analyze(
            m15Window
          ),

        h1:
          engine.analyze(
            h1Window
          ),

        h4:
          engine.analyze(
            h4Window
          ),

        daily:
          engine.analyze(
            dWindow
          )
      };

    } catch (e) {
      continue;
    }

    const signal =
      engine.decide(
        data,
        engine.neutralFundamental(),
        engine.neutralNewsRisk()
      );

    const active =
      mode === 'quality'
        ? getQualityActive(
            signal
          )
        : getBaseActive(
            signal
          );

    if (!active) {
      continue;
    }

    const dir =
      mode === 'quality'
        ? signal.decision
        : signal.direction;

    if (
      !['BUY', 'SELL']
        .includes(dir)
    ) {
      continue;
    }

    /*
     * ورود دقیقاً روی Close
     */
    const entry =
      bar.close;

    if (
      !signal.trade ||
      !Number.isFinite(
        Number(
          signal.trade.stopLoss
        )
      ) ||
      !Array.isArray(
        signal.trade.targets
      ) ||
      !signal.trade.targets.length
    ) {
      continue;
    }

    const sl =
      Number(
        signal.trade.stopLoss
      );

    const tp1 =
      Number(
        signal.trade.targets[0]
      );

    const riskDist =
      Math.abs(
        entry - sl
      );

    if (
      !Number.isFinite(
        riskDist
      ) ||
      riskDist <= 0 ||
      !Number.isFinite(
        tp1
      )
    ) {
      continue;
    }

    position = {
      dir,

      entry,

      sl,

      tp1,

      openIndex:
        i,

      openTime:
        bar.time,

      confidence:
        Number(
          signal.confidence || 0
        ),

      agreeCount:
        Number(
          signal.consensus
            ?.agreeCount || 0
        ),

      totalCount:
        Number(
          signal.consensus
            ?.totalCount || 0
        ),

      qualityScore:
        signal.quality?.score ??
        null,

      qualityGrade:
        signal.quality?.grade ??
        null,

      session:
        signal.quality?.session ??
        engine.getSession(
          bar.time
        ),

      rr:
        Number(
          signal.trade.rr || 0
        ),

      strategyVotes:
        signal.strategyVotes ||
        {},

      strategyKey:
        signal.strategyKey ||
        '',

      mfe: 0,

      mae: 0,

      riskDist
    };
  }

  /*
   * معامله باز در انتهای داده
   */
  if (position) {

    const lastBar =
      m15[
        m15.length - 1
      ];

    updateMFE(
      position,
      lastBar
    );

    const pl =
      position.dir === 'BUY'
        ? lastBar.close -
          position.entry
        : position.entry -
          lastBar.close;

    const riskDist =
      Math.abs(
        position.entry -
        position.sl
      );

    const r =
      riskDist > 0
        ? pl /
          riskDist
        : 0;

    trades.push({
      ...position,

      exit:
        lastBar.close,

      exitTime:
        lastBar.time,

      result:
        r >= 0
          ? 'OPEN_WIN'
          : 'OPEN_LOSS',

      r:
        fmtR(r)
    });
  }

  return trades;
}

function updateMFE(
  position,
  bar
) {
  if (
    !position ||
    !bar ||
    !position.riskDist ||
    position.riskDist <= 0
  ) {
    return;
  }

  if (
    position.dir === 'BUY'
  ) {

    const mfe =
      (
        bar.high -
        position.entry
      ) /
      position.riskDist;

    const mae =
      (
        bar.low -
        position.entry
      ) /
      position.riskDist;

    position.mfe =
      Math.max(
        position.mfe || 0,
        mfe
      );

    position.mae =
      Math.min(
        position.mae || 0,
        mae
      );

  } else {

    const mfe =
      (
        position.entry -
        bar.low
      ) /
      position.riskDist;

    const mae =
      (
        position.entry -
        bar.high
      ) /
      position.riskDist;

    position.mfe =
      Math.max(
        position.mfe || 0,
        mfe
      );

    position.mae =
      Math.min(
        position.mae || 0,
        mae
      );
  }
}

function median(
  values
) {
  if (
    !values.length
  ) {
    return 0;
  }

  const x =
    [...values]
      .sort(
        (a, b) =>
          a - b
      );

  const mid =
    Math.floor(
      x.length / 2
    );

  return x.length % 2
    ? x[mid]
    : (
        x[mid - 1] +
        x[mid]
      ) / 2;
}

function summarize(
  trades
) {
  const total =
    trades.length;

  const wins =
    trades.filter(
      t =>
        Number(t.r) > 0
    );

  const losses =
    trades.filter(
      t =>
        Number(t.r) <= 0
    );

  const netR =
    trades.reduce(
      (a, t) =>
        a +
        Number(
          t.r || 0
        ),
      0
    );

  const grossProfit =
    wins.reduce(
      (a, t) =>
        a +
        Number(
          t.r || 0
        ),
      0
    );

  const grossLoss =
    Math.abs(
      losses.reduce(
        (a, t) =>
          a +
          Number(
            t.r || 0
          ),
        0
      )
    );

  let peak = 0;
  let running = 0;
  let maxDD = 0;

  trades.forEach(t => {

    running +=
      Number(
        t.r || 0
      );

    peak =
      Math.max(
        peak,
        running
      );

    maxDD =
      Math.max(
        maxDD,
        peak -
          running
      );
  });

  const durations =
    trades.map(
      t =>
        (
          t.exitTime -
          t.openTime
        ) /
        3600000
    );

  const mfes =
    trades.map(
      t =>
        Number(
          t.mfe || 0
        )
    );

  const maes =
    trades.map(
      t =>
        Number(
          t.mae || 0
        )
    );

  return {
    total,

    wins:
      wins.length,

    losses:
      losses.length,

    breakeven:
      trades.filter(
        t =>
          Number(t.r) === 0
      ).length,

    winRate:
      total
        ? fmtR(
            wins.length /
            total *
            100
          )
        : 0,

    netR:
      fmtR(netR),

    grossProfit:
      fmtR(grossProfit),

    grossLoss:
      fmtR(grossLoss),

    profitFactor:
      grossLoss > 0
        ? fmtR(
            grossProfit /
            grossLoss
          )
        : null,

    avgR:
      total
        ? fmtR(
            netR /
            total
          )
        : 0,

    maxDD:
      fmtR(maxDD),

    avgDurationHours:
      durations.length
        ? fmtR(
            durations.reduce(
              (a, x) =>
                a + x,
              0
            ) /
            durations.length
          )
        : 0,

    medianDurationHours:
      durations.length
        ? fmtR(
            median(
              durations
            )
          )
        : 0,

    avgMFE:
      mfes.length
        ? fmtR(
            mfes.reduce(
              (a, x) =>
                a + x,
              0
            ) /
            mfes.length
          )
        : 0,

    medianMFE:
      mfes.length
        ? fmtR(
            median(mfes)
          )
        : 0,

    avgMAE:
      maes.length
        ? fmtR(
            maes.reduce(
              (a, x) =>
                a + x,
              0
            ) /
            maes.length
          )
        : 0,

    medianMAE:
      maes.length
        ? fmtR(
            median(maes)
          )
        : 0,

    avgRR:
      total
        ? fmtR(
            trades.reduce(
              (a, t) =>
                a +
                Number(
                  t.rr || 0
                ),
              0
            ) /
            total
          )
        : 0
  };
}

function groupBy(
  trades,
  fn
) {
  const out = {};

  for (
    const t of trades
  ) {
    const key =
      fn(t);

    if (
      !out[key]
    ) {
      out[key] = [];
    }

    out[key].push(t);
  }

  const result = {};

  for (
    const [
      key,
      items
    ] of Object.entries(out)
  ) {
    result[key] =
      summarize(items);
  }

  return result;
}

function directionStats(
  trades
) {
  return groupBy(
    trades,
    t => t.dir
  );
}

function sessionStats(
  trades
) {
  return groupBy(
    trades,
    t =>
      t.session ||
      engine.getSession(
        t.openTime
      )
  );
}

function confidenceStats(
  trades
) {
  return groupBy(
    trades,
    t => {

      const c =
        Number(
          t.confidence || 0
        );

      if (
        c < 70
      ) return '<70';

      if (
        c < 80
      ) return '70-79';

      if (
        c < 90
      ) return '80-89';

      return '90-100';
    }
  );
}

function qualityBucketStats(
  trades
) {
  return groupBy(
    trades,
    t => {

      const q =
        Number(
          t.qualityScore || 0
        );

      if (
        q < 65
      ) return '<65';

      if (
        q < 75
      ) return '65-74';

      if (
        q < 85
      ) return '75-84';

      return '85-100';
    }
  );
}

function rrStats(
  trades
) {
  return groupBy(
    trades,
    t => {

      const rr =
        Number(
          t.rr || 0
        );

      if (
        rr < 1.5
      ) return '<1.5';

      if (
        rr < 2
      ) return '1.5-1.99';

      if (
        rr < 3
      ) return '2-2.99';

      return '3+';
    }
  );
}

function strategyStats(
  trades
) {
  const names = [
    'روند چندتایم‌فریمی',
    'ساختار بازار (BOS/CHoCH)',
    'Liquidity Sweep (SMC)',
    'مومنتوم (RSI + EMA20)',
    'Fibonacci Retracement',
    'واگرایی RSI',
    'فاندامنتال (FRED)'
  ];

  const result = {};

  for (
    const name of names
  ) {

    const buckets = {
      BUY: [],
      SELL: [],
      NEUTRAL: []
    };

    for (
      const t of trades
    ) {
      const vote =
        t.strategyVotes?.[name] ||
        'NEUTRAL';

      if (
        buckets[vote]
      ) {
        buckets[vote].push(t);
      }
    }

    result[name] = {
      BUY:
        summarize(
          buckets.BUY
        ),

      SELL:
        summarize(
          buckets.SELL
        ),

      NEUTRAL:
        summarize(
          buckets.NEUTRAL
        )
    };
  }

  return result;
}

function strategyCombinationStats(
  trades
) {
  const groups = {};

  for (
    const t of trades
  ) {
    const v =
      t.strategyVotes ||
      {};

    const key = [
      v['روند چندتایم‌فریمی'] ||
        'NEUTRAL',

      v['ساختار بازار (BOS/CHoCH)'] ||
        'NEUTRAL',

      v['Liquidity Sweep (SMC)'] ||
        'NEUTRAL',

      v['مومنتوم (RSI + EMA20)'] ||
        'NEUTRAL',

      v['Fibonacci Retracement'] ||
        'NEUTRAL',

      v['واگرایی RSI'] ||
        'NEUTRAL',

      v['فاندامنتال (FRED)'] ||
        'NEUTRAL'

    ].join(' + ');

    if (
      !groups[key]
    ) {
      groups[key] = [];
    }

    groups[key].push(t);
  }

  const result = {};

  for (
    const [
      key,
      items
    ] of Object.entries(groups)
  ) {
    result[key] = {
      ...summarize(items),

      direction:
        items[0]?.dir ||
        null,

      sample:
        items.length
    };
  }

  return result;
}

function consensusCompositionStats(
  trades
) {
  const groups = {};

  for (
    const t of trades
  ) {
    const values =
      Object.values(
        t.strategyVotes ||
        {}
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

    if (
      !groups[key]
    ) {
      groups[key] = [];
    }

    groups[key].push(t);
  }

  const result = {};

  for (
    const [
      key,
      items
    ] of Object.entries(groups)
  ) {
    result[key] = {
      ...summarize(items),

      sample:
        items.length
    };
  }

  return result;
}

function cleanTrades(
  trades
) {
  return trades
    .slice(-50)
    .map(t => ({
      dir:
        t.dir,

      entry:
        fmtR(t.entry),

      sl:
        fmtR(t.sl),

      tp1:
        fmtR(t.tp1),

      exit:
        fmtR(t.exit),

      result:
        t.result,

      r:
        fmtR(t.r),

      mfe:
        fmtR(t.mfe),

      mae:
        fmtR(t.mae),

      confidence:
        fmtR(
          t.confidence
        ),

      consensus:
        `${t.agreeCount}/${t.totalCount}`,

      qualityScore:
        t.qualityScore != null
          ? fmtR(
              t.qualityScore
            )
          : null,

      qualityGrade:
        t.qualityGrade,

      session:
        t.session,

      rr:
        fmtR(t.rr),

      strategyVotes:
        t.strategyVotes ||
        {},

      strategyKey:
        t.strategyKey ||
        '',

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

router.get(
  '/',
  async (req, res) => {

    if (
      !process.env.TWELVEDATA_API_KEY
    ) {
      return res.json({
        status:
          'UNAVAILABLE',

        error:
          'no-api-key-configured'
      });
    }

    const requestedBars =
      Math.max(
        1000,

        Math.min(
          Number(
            req.query.bars
          ) || 10000,

          50000
        )
      );

    const months =
      Math.max(
        1,

        Math.min(
          Number(
            req.query.months
          ) || 6,

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
      maxHoldDays *
      24 *
      4;

    const mode =
      [
        'base',
        'quality',
        'compare'
      ].includes(
        String(
          req.query.mode ||
          'compare'
        )
      )
        ? String(
            req.query.mode ||
            'compare'
          )
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
      ] =
        await Promise.all([
          engine.fetchTFHistory(
            '15M',
            fetchBars
          ),

          engine.fetchTFHistory(
            '1H',
            Math.ceil(
              fetchBars / 4
            ) +
              rollingWindow
          ),

          engine.fetchTFHistory(
            '4H',
            Math.ceil(
              fetchBars / 16
            ) +
              rollingWindow
          ),

          engine.fetchTFHistory(
            'Daily',
            Math.ceil(
              fetchBars / 96
            ) +
              rollingWindow
          )
        ]);

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
            'market-data-unavailable'
        });
      }

      if (
        m15.length <
        rollingWindow + 100
      ) {
        return res.json({
          status:
            'UNAVAILABLE',

          error:
            'insufficient-history-for-backtest',

          barsReceived:
            m15.length
        });
      }

      const startCut =
        Math.max(
          0,

          m15.length -
            requestedBars
        );

      const testM15 =
        m15.slice(
          startCut
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
        summarize(
          baseTrades
        );

      const qualitySummary =
        summarize(
          qualityTrades
        );

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
          (
            qualitySummary.profitFactor != null &&
            baseSummary.profitFactor != null
          )
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

      const selectedTrades =
        mode === 'base'
          ? baseTrades
          : qualityTrades;

      const selectedStats =
        mode === 'base'
          ? baseSummary
          : qualitySummary;

      const period = {
        from:
          new Date(
            testM15[0]?.time ||
            0
          ).toISOString(),

        to:
          new Date(
            testM15[
              testM15.length - 1
            ].time
          ).toISOString(),

        requestedBars,

        barsAnalyzed:
          testM15.length,

        monthsRequested:
          months
      };

      return res.json({

        ok: true,

        status:
          'LIVE',

        mode,

        disclaimer:
          'بک‌تست روی داده تاریخی واقعی TwelveData اجرا شده است. FRED و News در تاریخ خنثی فرض شده‌اند؛ ورود روی Close کندل سیگنال انجام شده؛ Spread/Commission/Slippage مدل نشده‌اند؛ MFE/MAE از بعد ورود تا خروج محاسبه شده‌اند. اگر TwelveData کمتر از تعداد درخواستی داده بدهد، barsAnalyzed تعداد واقعی داده دریافتی است.',

        period,

        parameters: {
          rollingWindow,

          maxHoldDays,

          maxHoldBars,

          minConfidence:
            engine.MIN_CONFIDENCE,

          minRR:
            engine.MIN_RR,

          minQualityScore:
            engine.MIN_QUALITY_SCORE
        },

        stats:
          selectedStats,

        baseStats:
          baseSummary,

        qualityStats:
          qualitySummary,

        comparison,

        direction:
          directionStats(
            selectedTrades
          ),

        sessions:
          sessionStats(
            selectedTrades
          ),

        confidence:
          confidenceStats(
            selectedTrades
          ),

        quality:
          qualityBucketStats(
            selectedTrades
          ),

        rr:
          rrStats(
            selectedTrades
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

          strategyCount:
            7,

          diagnosticEnabled:
            true
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
  }
);

module.exports = router;
