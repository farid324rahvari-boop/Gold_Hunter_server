// Gold Hunter — Historical Backtest
// XAU/USD 15M
//
// Features:
// - Real historical OHLC from TwelveData
// - Multi-timeframe analysis
// - Base Engine vs Quality Engine comparison
// - Correct hard max-hold handling
// - Correct MFE / MAE
// - R-multiple statistics
// - Direction / session / confidence / quality breakdown
//
// IMPORTANT:
// Fundamental + News are neutral in historical backtest unless
// historical provider data is explicitly implemented.

const express = require('express');

const router = express.Router();

const engine = require('../lib/engine');


// ============================================================
// HELPERS
// ============================================================

function num(v, fallback) {
  const x = Number(v);
  return Number.isFinite(x)
    ? x
    : fallback;
}


function clamp(v, min, max) {
  return Math.max(
    min,
    Math.min(max, v)
  );
}


function fmt(v, digits = 3) {
  return Number(
    Number(v || 0).toFixed(digits)
  );
}


function hoursBetween(a, b) {
  return Math.max(
    0,
    (b - a) / 3600000
  );
}


function sessionFromTime(time) {
  if (
    typeof engine.getSession ===
    'function'
  ) {
    return engine.getSession(time);
  }

  const hour =
    new Date(time).getUTCHours();

  if (hour < 8) return 'ASIA';
  if (hour < 13) return 'LONDON';
  if (hour < 17) return 'NEW_YORK';

  return 'NEW_YORK_LATE';
}


function percentile(values, p) {

  const x =
    values
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

  if (!x.length) return 0;

  const index =
    (x.length - 1) * p;

  const lower =
    Math.floor(index);

  const upper =
    Math.ceil(index);

  if (lower === upper) {
    return x[lower];
  }

  return (
    x[lower] +
    (x[upper] - x[lower]) *
      (index - lower)
  );
}


// ============================================================
// BUILD HIGHER-TF WINDOWS
// ============================================================

function advancePointer(
  bars,
  pointer,
  time
) {

  let p = pointer;

  while (
    p + 1 < bars.length &&
    bars[p + 1].time <= time
  ) {
    p++;
  }

  return p;
}


function sliceUntil(
  bars,
  pointer,
  rollingWindow
) {

  const end =
    pointer + 1;

  const start =
    Math.max(
      0,
      end - rollingWindow
    );

  return bars.slice(
    start,
    end
  );
}


// ============================================================
// MFE / MAE
// ============================================================

function calculateExcursion(
  position
) {

  const risk =
    Number(
      position.riskDistance
    );

  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {

    return {
      mfe: 0,
      mae: 0
    };
  }


  if (
    position.dir === 'BUY'
  ) {

    const mfe =
      (
        position.maxHigh -
        position.entry
      ) / risk;

    const mae =
      (
        position.minLow -
        position.entry
      ) / risk;

    return {
      mfe,
      mae
    };
  }


  const mfe =
    (
      position.entry -
      position.minLow
    ) / risk;

  const mae =
    (
      position.entry -
      position.maxHigh
    ) / risk;

  return {
    mfe,
    mae
  };
}


// ============================================================
// CLOSE POSITION
// ============================================================

function closePosition(
  position,
  bar,
  exitReason,
  exitIndex
) {

  const exit =
    Number(bar.close);

  let r = 0;

  if (
    position.dir === 'BUY'
  ) {

    r =
      (
        exit -
        position.entry
      ) /
      position.riskDistance;

  } else {

    r =
      (
        position.entry -
        exit
      ) /
      position.riskDistance;
  }


  const excursion =
    calculateExcursion(
      position
    );


  return {

    id:
      position.id,

    dir:
      position.dir,

    entry:
      fmt(position.entry, 5),

    sl:
      fmt(position.sl, 5),

    tp1:
      fmt(position.tp1, 5),

    exit:
      fmt(exit, 5),

    result:
      r > 0
        ? 'WIN'
        : r < 0
          ? 'LOSS'
          : 'BREAKEVEN',

    r:
      fmt(r, 4),

    openTime:
      new Date(
        position.openTime
      ).toISOString(),

    exitTime:
      new Date(
        bar.time
      ).toISOString(),

    durationHours:
      fmt(
        hoursBetween(
          position.openTime,
          bar.time
        ),
        2
      ),

    exitReason,

    confidence:
      fmt(
        position.confidence,
        2
      ),

    consensus:
      position.consensus,

    qualityScore:
      fmt(
        position.qualityScore,
        0
      ),

    qualityGrade:
      position.qualityGrade,

    session:
      position.session,

    rr:
      fmt(
        position.rr,
        3
      ),

    mfe:
      fmt(
        excursion.mfe,
        3
      ),

    mae:
      fmt(
        excursion.mae,
        3
      ),

    openIndex:
      position.openIndex,

    exitIndex
  };
}


// ============================================================
// POSITION UPDATE
// ============================================================

function updateExcursion(
  position,
  bar
) {

  position.maxHigh =
    Math.max(
      position.maxHigh,
      Number(bar.high)
    );

  position.minLow =
    Math.min(
      position.minLow,
      Number(bar.low)
    );
}


// ============================================================
// TRY CLOSE
// ============================================================
//
// Returns:
//   null       => position remains open
//   trade      => position closed
//
// IMPORTANT:
// The entry occurs at the CLOSE of the signal candle.
// Therefore the signal candle itself is NOT used to trigger
// SL/TP after entry.
//
// maxHoldBars is a hard time limit.
// Once age reaches maxHoldBars, only that bar is allowed
// to hit SL/TP. If neither is hit, position closes at close.
//

function tryClosePosition(
  position,
  bar,
  index,
  maxHoldBars
) {

  updateExcursion(
    position,
    bar
  );


  const age =
    index -
    position.openIndex;


  const reachedMaxHold =
    age >= maxHoldBars;


  const hitSL =
    position.dir === 'BUY'

      ? Number(bar.low) <=
        position.sl

      : Number(bar.high) >=
        position.sl;


  const hitTP =
    position.dir === 'BUY'

      ? Number(bar.high) >=
        position.tp1

      : Number(bar.low) <=
        position.tp1;


  // ----------------------------------------------------------
  // SL/TP have priority on the final allowed bar.
  // Conservative rule: if both hit in the same candle,
  // assume SL was hit first.
  // ----------------------------------------------------------

  if (hitSL) {

    return closePosition(
      position,
      {
        ...bar,
        close:
          position.sl
      },
      'SL',
      index
    );
  }


  if (hitTP) {

    return closePosition(
      position,
      {
        ...bar,
        close:
          position.tp1
      },
      'TP1',
      index
    );
  }


  // ----------------------------------------------------------
  // HARD TIMEOUT
  // ----------------------------------------------------------

  if (reachedMaxHold) {

    return closePosition(
      position,
      bar,
      'TIMEOUT',
      index
    );
  }


  return null;
}


// ============================================================
// OPEN POSITION
// ============================================================

function openPosition(
  decision,
  bar,
  index,
  id
) {

  const dir =
    decision.direction;

  if (
    dir !== 'BUY' &&
    dir !== 'SELL'
  ) {
    return null;
  }


  const trade =
    decision.trade;

  if (!trade) {
    return null;
  }


  const entry =
    Number(bar.close);


  const sl =
    Number(trade.stopLoss);


  const tp1 =
    Number(
      trade.targets?.[0]
    );


  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(sl) ||
    !Number.isFinite(tp1)
  ) {
    return null;
  }


  const riskDistance =
    Math.abs(
      entry - sl
    );


  if (
    !Number.isFinite(
      riskDistance
    ) ||
    riskDistance <= 0
  ) {
    return null;
  }


  return {

    id,

    dir,

    entry,

    sl,

    tp1,

    riskDistance,

    openIndex:
      index,

    openTime:
      bar.time,

    maxHigh:
      entry,

    minLow:
      entry,

    confidence:
      Number(
        decision.confidence || 0
      ),

    consensus:
      `${decision.consensus?.agreeCount || 0}/${decision.consensus?.totalCount || 0}`,

    qualityScore:
      Number(
        decision.quality?.score || 0
      ),

    qualityGrade:
      decision.quality?.grade ||
      'UNKNOWN',

    session:
      decision.quality?.session ||
      sessionFromTime(
        bar.time
      ),

    rr:
      Number(
        trade.rr || 0
      )
  };
}


// ============================================================
// BASE DECISION EXTRACTION
// ============================================================
//
// engine.decide() now returns combined blockers:
//
//   original blockers
//   +
//   quality blockers
//
// To compare the old/base engine against Quality Engine,
// remove only blockers that came from quality.blockers.
//

function getBaseActive(
  decision
) {

  const qualityBlockers =
    new Set(
      decision.quality?.blockers ||
      []
    );


  const baseBlockers =
    (
      decision.blockers ||
      []
    ).filter(
      x => !qualityBlockers.has(x)
    );


  const direction =
    decision.direction;


  const confidence =
    Number(
      decision.confidence || 0
    );


  const total =
    Number(
      decision.consensus?.totalCount ||
      0
    );


  const agree =
    Number(
      decision.consensus?.agreeCount ||
      0
    );


  const sufficientConsensus =
    agree >=
    Math.ceil(
      total / 2
    );


  return {

    active:
      direction !== 'WAIT' &&

      confidence >=
        engine.MIN_CONFIDENCE &&

      sufficientConsensus &&

      baseBlockers.length === 0,

    baseBlockers,

    direction
  };
}


// ============================================================
// SIMULATION
// ============================================================

async function simulate(
  m15,
  h1,
  h4,
  daily,
  rollingWindow,
  maxHoldBars,
  mode
) {

  let p1 = 0;
  let p4 = 0;
  let pd = 0;


  let position = null;

  let tradeId = 0;

  const trades = [];


  for (
    let i = rollingWindow;
    i < m15.length;
    i++
  ) {

    const bar =
      m15[i];


    // --------------------------------------------------------
    // UPDATE HIGHER TIMEFRAME POINTERS
    // --------------------------------------------------------

    p1 =
      advancePointer(
        h1,
        p1,
        bar.time
      );

    p4 =
      advancePointer(
        h4,
        p4,
        bar.time
      );

    pd =
      advancePointer(
        daily,
        pd,
        bar.time
      );


    if (
      p1 < 0 ||
      p4 < 0 ||
      pd < 0
    ) {
      continue;
    }


    // --------------------------------------------------------
    // MANAGE EXISTING POSITION
    // --------------------------------------------------------

    if (position) {

      const closed =
        tryClosePosition(
          position,
          bar,
          i,
          maxHoldBars
        );


      if (closed) {

        trades.push(
          closed
        );

        position = null;
      }


      // ------------------------------------------------------
      // If position was open, do not open another one
      // on the same candle.
      // ------------------------------------------------------

      if (position) {
        continue;
      }
    }


    // --------------------------------------------------------
    // BUILD WINDOWS
    // --------------------------------------------------------

    const m15Window =
      m15.slice(
        Math.max(
          0,
          i - rollingWindow + 1
        ),
        i + 1
      );


    const h1Window =
      sliceUntil(
        h1,
        p1,
        rollingWindow
      );


    const h4Window =
      sliceUntil(
        h4,
        p4,
        rollingWindow
      );


    const dailyWindow =
      sliceUntil(
        daily,
        pd,
        rollingWindow
      );


    if (
      m15Window.length < 100 ||
      h1Window.length < 60 ||
      h4Window.length < 60 ||
      dailyWindow.length < 60
    ) {
      continue;
    }


    // --------------------------------------------------------
    // ANALYZE
    // --------------------------------------------------------

    const d = {

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
          dailyWindow
        )
    };


    const fund =
      engine.neutralFundamental();


    const news =
      engine.neutralNewsRisk();


    let decision;

    try {

      decision =
        engine.decide(
          d,
          fund,
          news
        );

    } catch (e) {

      continue;
    }


    // --------------------------------------------------------
    // DETERMINE MODE
    // --------------------------------------------------------

    let shouldOpen =
      false;


    if (
      mode === 'base'
    ) {

      const base =
        getBaseActive(
          decision
        );

      shouldOpen =
        base.active;

    }

    else {

      // Quality mode
      shouldOpen =
        decision.decision ===
        decision.direction &&
        decision.direction !==
          'WAIT';
    }


    if (!shouldOpen) {
      continue;
    }


    // --------------------------------------------------------
    // OPEN
    // --------------------------------------------------------

    tradeId++;


    position =
      openPosition(
        decision,
        bar,
        i,
        tradeId
      );


    if (!position) {
      continue;
    }
  }


  // ==========================================================
  // FORCE CLOSE LAST OPEN POSITION
  // ==========================================================

  if (
    position &&
    m15.length
  ) {

    const lastBar =
      m15[m15.length - 1];


    updateExcursion(
      position,
      lastBar
    );


    trades.push(
      closePosition(
        position,
        lastBar,
        'END_OF_DATA',
        m15.length - 1
      )
    );
  }


  return trades;
}


// ============================================================
// STATISTICS
// ============================================================

function summarize(
  trades
) {

  const total =
    trades.length;


  const wins =
    trades.filter(
      t => Number(t.r) > 0
    );


  const losses =
    trades.filter(
      t => Number(t.r) < 0
    );


  const breakeven =
    trades.filter(
      t => Number(t.r) === 0
    );


  const netR =
    trades.reduce(
      (sum, t) =>
        sum + Number(t.r || 0),
      0
    );


  const grossProfit =
    wins.reduce(
      (sum, t) =>
        sum + Number(t.r || 0),
      0
    );


  const grossLoss =
    Math.abs(
      losses.reduce(
        (sum, t) =>
          sum + Number(t.r || 0),
        0
      )
    );


  const pf =
    grossLoss > 0
      ? grossProfit /
        grossLoss
      : grossProfit > 0
        ? Infinity
        : 0;


  const winRate =
    total > 0
      ? (
          wins.length /
          total
        ) * 100
      : 0;


  const avgR =
    total > 0
      ? netR / total
      : 0;


  // ----------------------------------------------------------
  // EQUITY / MAX DRAWDOWN
  // ----------------------------------------------------------

  let equity = 0;
  let peak = 0;
  let maxDD = 0;


  for (
    const t of trades
  ) {

    equity +=
      Number(t.r || 0);

    peak =
      Math.max(
        peak,
        equity
      );

    maxDD =
      Math.max(
        maxDD,
        peak - equity
      );
  }


  const durations =
    trades.map(
      t =>
        Number(
          t.durationHours || 0
        )
    );


  const mfes =
    trades.map(
      t =>
        Number(t.mfe || 0)
    );


  const maes =
    trades.map(
      t =>
        Number(t.mae || 0)
    );


  const rrValues =
    trades.map(
      t =>
        Number(t.rr || 0)
    );


  return {

    total,

    wins:
      wins.length,

    losses:
      losses.length,

    breakeven:
      breakeven.length,

    winRate:
      fmt(winRate, 2),

    netR:
      fmt(netR, 4),

    grossProfit:
      fmt(grossProfit, 4),

    grossLoss:
      fmt(grossLoss, 4),

    profitFactor:
      pf === Infinity
        ? 'INF'
        : fmt(pf, 3),

    avgR:
      fmt(avgR, 4),

    maxDD:
      fmt(maxDD, 4),

    avgDurationHours:
      durations.length
        ? fmt(
            durations.reduce(
              (a, b) =>
                a + b,
              0
            ) /
            durations.length,
            2
          )
        : 0,

    medianDurationHours:
      durations.length
        ? fmt(
            percentile(
              durations,
              0.5
            ),
            2
          )
        : 0,

    avgMFE:
      mfes.length
        ? fmt(
            mfes.reduce(
              (a, b) =>
                a + b,
              0
            ) /
            mfes.length,
            3
          )
        : 0,

    avgMAE:
      maes.length
        ? fmt(
            maes.reduce(
              (a, b) =>
                a + b,
              0
            ) /
            maes.length,
            3
          )
        : 0,

    medianMFE:
      mfes.length
        ? fmt(
            percentile(
              mfes,
              0.5
            ),
            3
          )
        : 0,

    medianMAE:
      maes.length
        ? fmt(
            percentile(
              maes,
              0.5
            ),
            3
          )
        : 0,

    avgRR:
      rrValues.length
        ? fmt(
            rrValues.reduce(
              (a, b) =>
                a + b,
              0
            ) /
            rrValues.length,
            3
          )
        : 0
  };
}


// ============================================================
// GROUP BY
// ============================================================

function groupStats(
  trades,
  getter
) {

  const groups = {};


  for (
    const t of trades
  ) {

    const key =
      getter(t);


    if (
      !groups[key]
    ) {

      groups[key] = [];
    }


    groups[key].push(t);
  }


  const out = {};


  for (
    const [
      key,
      arr
    ] of Object.entries(groups)
  ) {

    out[key] =
      summarize(arr);
  }


  return out;
}


// ============================================================
// COMPARISON
// ============================================================

function compareStats(
  base,
  quality
) {

  return {

    tradesDelta:
      quality.total -
      base.total,

    winRateDelta:
      fmt(
        quality.winRate -
        base.winRate,
        2
      ),

    netRDelta:
      fmt(
        quality.netR -
        base.netR,
        4
      ),

    profitFactorDelta:
      (
        quality.profitFactor === 'INF'
          ? null
          : base.profitFactor === 'INF'
            ? null
            : fmt(
                Number(
                  quality.profitFactor
                ) -
                Number(
                  base.profitFactor
                ),
                3
              )
      ),

    avgRDelta:
      fmt(
        quality.avgR -
        base.avgR,
        4
      ),

    maxDDDelta:
      fmt(
        quality.maxDD -
        base.maxDD,
        4
      ),

    avgMFEDelta:
      fmt(
        quality.avgMFE -
        base.avgMFE,
        3
      ),

    avgMAEDelta:
      fmt(
        quality.avgMAE -
        base.avgMAE,
        3
      )
  };
}


// ============================================================
// QUALITY BUCKETS
// ============================================================

function qualityBuckets(
  trades
) {

  const buckets = {

    '0-59': [],
    '60-69': [],
    '70-74': [],
    '75-79': [],
    '80-84': [],
    '85-89': [],
    '90-100': []
  };


  for (
    const t of trades
  ) {

    const q =
      Number(
        t.qualityScore || 0
      );


    if (q < 60)
      buckets['0-59'].push(t);

    else if (q < 70)
      buckets['60-69'].push(t);

    else if (q < 75)
      buckets['70-74'].push(t);

    else if (q < 80)
      buckets['75-79'].push(t);

    else if (q < 85)
      buckets['80-84'].push(t);

    else if (q < 90)
      buckets['85-89'].push(t);

    else
      buckets['90-100'].push(t);
  }


  return Object.fromEntries(
    Object.entries(buckets)
      .map(
        ([key, arr]) => [
          key,
          summarize(arr)
        ]
      )
  );
}


// ============================================================
// CONFIDENCE BUCKETS
// ============================================================

function confidenceBuckets(
  trades
) {

  const buckets = {

    '70-79': [],
    '80-89': [],
    '90-100': []
  };


  for (
    const t of trades
  ) {

    const c =
      Number(
        t.confidence || 0
      );


    if (
      c < 80
    ) {
      buckets['70-79'].push(t);

    } else if (
      c < 90
    ) {
      buckets['80-89'].push(t);

    } else {

      buckets['90-100'].push(t);
    }
  }


  return Object.fromEntries(
    Object.entries(buckets)
      .map(
        ([key, arr]) => [
          key,
          summarize(arr)
        ]
      )
  );
}


// ============================================================
// RR BUCKETS
// ============================================================

function rrBuckets(
  trades
) {

  const buckets = {

    '1.0-1.49': [],
    '1.5-1.99': [],
    '2.0-2.49': [],
    '2.5-2.99': [],
    '3.0+': []
  };


  for (
    const t of trades
  ) {

    const rr =
      Number(
        t.rr || 0
      );


    if (rr < 1.5)
      buckets['1.0-1.49'].push(t);

    else if (rr < 2)
      buckets['1.5-1.99'].push(t);

    else if (rr < 2.5)
      buckets['2.0-2.49'].push(t);

    else if (rr < 3)
      buckets['2.5-2.99'].push(t);

    else
      buckets['3.0+'].push(t);
  }


  return Object.fromEntries(
    Object.entries(buckets)
      .map(
        ([key, arr]) => [
          key,
          summarize(arr)
        ]
      )
  );
}


// ============================================================
// ROUTE
// ============================================================

router.get(
  '/api/backtest',
  async (req, res) => {

    const startedAt =
      Date.now();


    try {

      const requestedBars =
        clamp(
          num(
            req.query.bars,
            10000
          ),
          1000,
          50000
        );


      const months =
        clamp(
          num(
            req.query.months,
            12
          ),
          1,
          12
        );


      const maxHoldDays =
        clamp(
          num(
            req.query.maxHoldDays,
            3
          ),
          1,
          10
        );


      const rollingWindow =
        clamp(
          num(
            req.query.rollingWindow,
            220
          ),
          100,
          500
        );


      const maxHoldBars =
        Math.round(
          maxHoldDays *
          24 *
          4
        );


      const mode =
        (
          req.query.mode ||
          'compare'
        ).toLowerCase();


      // --------------------------------------------------------
      // FETCH DATA
      // --------------------------------------------------------

      const [
        m15,
        h1,
        h4,
        daily
      ] =
        await Promise.all([

          engine.fetchTFHistory(
            '15M',
            requestedBars
          ),

          engine.fetchTFHistory(
            '1H',
            Math.ceil(
              requestedBars / 4
            ) + rollingWindow
          ),

          engine.fetchTFHistory(
            '4H',
            Math.ceil(
              requestedBars / 16
            ) + rollingWindow
          ),

          engine.fetchTFHistory(
            'Daily',
            Math.ceil(
              requestedBars / 96
            ) + rollingWindow
          )
        ]);


      if (
        !m15 ||
        !h1 ||
        !h4 ||
        !daily
      ) {

        return res.status(503).json({

          ok: false,

          error:
            'Historical data unavailable',

          detail:
            'TwelveData returned incomplete historical data.'
        });
      }


      if (
        m15.length <
        rollingWindow + 100
      ) {

        return res.status(400).json({

          ok: false,

          error:
            'Not enough M15 bars',

          bars:
            m15.length,

          required:
            rollingWindow + 100
        });
      }


      // --------------------------------------------------------
      // RUN SIMULATIONS
      // --------------------------------------------------------

      let baseTrades = [];
      let qualityTrades = [];


      if (
        mode === 'base'
      ) {

        baseTrades =
          await simulate(
            m15,
            h1,
            h4,
            daily,
            rollingWindow,
            maxHoldBars,
            'base'
          );
      }


      else if (
        mode === 'quality'
      ) {

        qualityTrades =
          await simulate(
            m15,
            h1,
            h4,
            daily,
            rollingWindow,
            maxHoldBars,
            'quality'
          );
      }


      else {

        // compare mode
        //
        // Both simulations run independently over exactly
        // the same historical candles.

        [
          baseTrades,
          qualityTrades
        ] =
          await Promise.all([

            simulate(
              m15,
              h1,
              h4,
              daily,
              rollingWindow,
              maxHoldBars,
              'base'
            ),

            simulate(
              m15,
              h1,
              h4,
              daily,
              rollingWindow,
              maxHoldBars,
              'quality'
            )
          ]);
      }


      // --------------------------------------------------------
      // SELECT PRIMARY RESULT
      // --------------------------------------------------------

      const selectedTrades =
        mode === 'base'
          ? baseTrades
          : mode === 'quality'
            ? qualityTrades
            : qualityTrades;


      const stats =
        summarize(
          selectedTrades
        );


      const baseStats =
        summarize(
          baseTrades
        );


      const qualityStats =
        summarize(
          qualityTrades
        );


      // --------------------------------------------------------
      // PERIOD
      // --------------------------------------------------------

      const firstBar =
        m15[0];

      const lastBar =
        m15[m15.length - 1];


      // --------------------------------------------------------
      // OUTPUT TRADES
      // --------------------------------------------------------

      const recentTrades =
        selectedTrades
          .slice(-50)
          .map(
            t => ({

              dir:
                t.dir,

              entry:
                t.entry,

              sl:
                t.sl,

              tp1:
                t.tp1,

              exit:
                t.exit,

              result:
                t.result,

              r:
                t.r,

              openTime:
                t.openTime,

              exitTime:
                t.exitTime,

              durationHours:
                t.durationHours,

              exitReason:
                t.exitReason,

              confidence:
                t.confidence,

              consensus:
                t.consensus,

              qualityScore:
                t.qualityScore,

              qualityGrade:
                t.qualityGrade,

              session:
                t.session,

              rr:
                t.rr,

              mfe:
                t.mfe,

              mae:
                t.mae
            })
          );


      // --------------------------------------------------------
      // DETAILED BREAKDOWNS
      // --------------------------------------------------------

      const direction =
        groupStats(
          selectedTrades,
          t => t.dir
        );


      const sessions =
        groupStats(
          selectedTrades,
          t => t.session
        );


      const confidence =
        confidenceBuckets(
          selectedTrades
        );


      const quality =
        qualityBuckets(
          selectedTrades
        );


      const rr =
        rrBuckets(
          selectedTrades
        );


      // --------------------------------------------------------
      // COMPARISON
      // --------------------------------------------------------

      const comparison =
        compareStats(
          baseStats,
          qualityStats
        );


      // --------------------------------------------------------
      // QUALITY FILTER INFO
      // --------------------------------------------------------

      const qualityThreshold =
        Number(
          engine.MIN_QUALITY_SCORE ||
          process.env.MIN_QUALITY_SCORE ||
          70
        );


      // --------------------------------------------------------
      // RESPONSE
      // --------------------------------------------------------

      return res.json({

        ok: true,

        status:
          'LIVE',

        mode,

        symbol:
          engine.SYMBOL,

        timeframe:
          '15M',

        requestedBars,

        barsAnalyzed:
          m15.length,

        rollingWindow,

        maxHoldDays,

        maxHoldBars,

        minConfidence:
          engine.MIN_CONFIDENCE,

        minRR:
          engine.MIN_RR,

        minQualityScore:
          qualityThreshold,

        period: {

          from:
            new Date(
              firstBar.time
            ).toISOString(),

          to:
            new Date(
              lastBar.time
            ).toISOString()
        },


        // ------------------------------------------------------
        // PRIMARY STATS
        // ------------------------------------------------------

        stats,

        trades:
          recentTrades,


        // ------------------------------------------------------
        // BASE / QUALITY
        // ------------------------------------------------------

        baseStats,

        qualityStats,

        comparison,


        // ------------------------------------------------------
        // BREAKDOWNS
        // ------------------------------------------------------

        direction,

        sessions,

        confidence,

        quality,

        rr,


        // ------------------------------------------------------
        // DIAGNOSTICS
        // ------------------------------------------------------

        diagnostics: {

          baseTradeCount:
            baseTrades.length,

          qualityTradeCount:
            qualityTrades.length,

          tradesFilteredByQuality:
            Math.max(
              0,
              baseTrades.length -
              qualityTrades.length
            ),

          qualityRetentionRate:
            baseTrades.length > 0
              ? fmt(
                  (
                    qualityTrades.length /
                    baseTrades.length
                  ) * 100,
                  2
                )
              : 0,

          qualityThreshold,

          maxHoldHours:
            maxHoldDays * 24,

          executionModel:
            'Entry at signal candle CLOSE',

          sameCandleRule:
            'SL/TP are not checked on entry candle',

          sameCandleSlTpRule:
            'If SL and TP both touch the same candle, SL is assumed first',

          timeoutRule:
            `Hard timeout at ${maxHoldBars} bars (${maxHoldDays} days)`,

          excursionRule:
            'MFE/MAE calculated from entry through exit candle',

          costs:
            'Spread, commission and slippage are not included'
        },


        // ------------------------------------------------------
        // DATA DISCLAIMER
        // ------------------------------------------------------

        disclaimer:
          'بک‌تست روی داده تاریخی واقعی اجرا شده است. فاندامنتال و ریسک خبری در این تست خنثی فرض شده‌اند. ورود دقیقاً روی قیمت بسته‌شدن کندل سیگنال شبیه‌سازی شده است و اسپرد، کمیسیون و اسلیپیج لحاظ نشده‌اند.',


        executionMs:
          Date.now() -
          startedAt
      });

    } catch (e) {

      console.error(
        'BACKTEST ERROR:',
        e
      );


      return res.status(500).json({

        ok: false,

        error:
          e.message ||
          'Backtest failed',

        stack:
          process.env.NODE_ENV ===
          'development'
            ? e.stack
            : undefined
      });
    }
  }
);


module.exports = router;
