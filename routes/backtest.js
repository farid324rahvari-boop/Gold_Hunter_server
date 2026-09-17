// /api/backtest — بک‌تست تاریخی Gold Hunter با همان engine زنده
// بهبودها: pagination diagnostics، MFE/MAE صحیح بعد از ورود، Quality A/B،
// خروج timeout، آمار جهت/جلسه/اعتماد/کیفیت، و جلوگیری از look-ahead در همان کندل ورود.
const express = require('express');
const router = express.Router();
const engine = require('../lib/engine');

const fmt = x => Number(Number(x).toFixed(3));
const sessionOf = ms => {
  const h = new Date(ms).getUTCHours();
  if (h >= 0 && h < 7) return 'ASIA';
  if (h >= 7 && h < 13) return 'LONDON';
  if (h >= 13 && h < 18) return 'NEW_YORK';
  return 'NEW_YORK_LATE';
};

function advancePointer(bars, ptr, targetTime) {
  while (ptr + 1 < bars.length && bars[ptr + 1].time <= targetTime) ptr++;
  return ptr;
}

function tradeStats(trades) {
  const closed = trades.filter(t => t.result !== 'OPEN_WIN' && t.result !== 'OPEN_LOSS');
  const wins = closed.filter(t => t.r > 0);
  const losses = closed.filter(t => t.r < 0);
  const grossWin = wins.reduce((a,t)=>a+t.r,0);
  const grossLoss = Math.abs(losses.reduce((a,t)=>a+t.r,0));
  let running=0, peak=0, maxDD=0;
  for(const t of trades){ running += t.r; peak=Math.max(peak,running); maxDD=Math.max(maxDD,peak-running); }
  const durations=trades.filter(t=>Number.isFinite(t.exitTime)).map(t=>(t.exitTime-t.openTime)/3600000).sort((a,b)=>a-b);
  const median=durations.length?durations[Math.floor(durations.length/2)]:0;
  return {
    total:trades.length, closed:closed.length, wins:wins.length, losses:losses.length,
    winRate:closed.length?fmt(wins.length/closed.length*100):0,
    netR:fmt(trades.reduce((a,t)=>a+t.r,0)), grossProfit:fmt(grossWin), grossLoss:fmt(grossLoss),
    profitFactor:grossLoss?fmt(grossWin/grossLoss):null,
    avgR:trades.length?fmt(trades.reduce((a,t)=>a+t.r,0)/trades.length):0,
    maxDD:fmt(maxDD), avgDurationHours:durations.length?fmt(durations.reduce((a,b)=>a+b,0)/durations.length):0,
    medianDurationHours:fmt(median), avgMFE:trades.length?fmt(trades.reduce((a,t)=>a+t.mfeR,0)/trades.length):0,
    avgMAE:trades.length?fmt(trades.reduce((a,t)=>a+t.maeR,0)/trades.length):0
  };
}

function groupStats(trades, keyFn) {
  const groups={};
  for(const t of trades){ const k=keyFn(t); (groups[k] ||= []).push(t); }
  return Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,tradeStats(v)]));
}

function simulate(m15,h1,h4,daily,rollingWindow,maxHoldBars,ignoreQuality=false) {
  let h1Ptr=0,h4Ptr=0,dPtr=0,position=null;
  const trades=[];
  const startIdx=Math.max(rollingWindow,100);

  for(let i=startIdx;i<m15.length;i++){
    const bar=m15[i];
    h1Ptr=advancePointer(h1,h1Ptr,bar.time); h4Ptr=advancePointer(h4,h4Ptr,bar.time); dPtr=advancePointer(daily,dPtr,bar.time);
    if(h1Ptr<rollingWindow-30||h4Ptr<30||dPtr<20) continue;

    // مدیریت معامله فقط با کندل‌های بعد از کندل ورود انجام می‌شود.
    if(position){
      const age=i-position.openIndex;
      const risk=Math.abs(position.entry-position.sl);
      // MFE/MAE include the entire post-entry candle, including the exit candle.
      // If SL and TP are both inside one OHLC candle, SL is conservatively assumed
      // to occur first because intrabar ordering is unknown.
      const mfe=position.dir==='BUY'?(bar.high-position.entry)/risk:(position.entry-bar.low)/risk;
      const mae=position.dir==='BUY'?(bar.low-position.entry)/risk:(position.entry-bar.high)/risk;
      position.mfeR=Math.max(position.mfeR,mfe);
      position.maeR=Math.min(position.maeR,mae);
      const hitSL=position.dir==='BUY'?bar.low<=position.sl:bar.high>=position.sl;
      const hitTP=position.dir==='BUY'?bar.high>=position.tp1:bar.low<=position.tp1;
      if(hitSL){
        trades.push({...position,exit:position.sl,exitTime:bar.time,result:'LOSS',r:-1,mfeR:position.mfeR,maeR:position.maeR});
        position=null;
      } else if(hitTP){
        const reward=Math.abs(position.tp1-position.entry);
        trades.push({...position,exit:position.tp1,exitTime:bar.time,result:'WIN',r:fmt(reward/risk),mfeR:position.mfeR,maeR:position.maeR});
        position=null;
      } else {
        if(age>=maxHoldBars){
          const pl=position.dir==='BUY'?bar.close-position.entry:position.entry-bar.close;
          trades.push({...position,exit:bar.close,exitTime:bar.time,result:pl>=0?'TIMEOUT_WIN':'TIMEOUT_LOSS',r:fmt(pl/risk),mfeR:position.mfeR,maeR:position.maeR});
          position=null;
        }
      }
      continue;
    }

    const m15Window=m15.slice(Math.max(0,i-rollingWindow+1),i+1);
    const h1Window=h1.slice(Math.max(0,h1Ptr-rollingWindow+1),h1Ptr+1);
    const h4Window=h4.slice(Math.max(0,h4Ptr-rollingWindow+1),h4Ptr+1);
    const dWindow=daily.slice(Math.max(0,dPtr-rollingWindow+1),dPtr+1);
    if(h1Window.length<30||h4Window.length<30||dWindow.length<20) continue;
    let data;
    try{ data={m15:engine.analyze(m15Window),h1:engine.analyze(h1Window),h4:engine.analyze(h4Window),daily:engine.analyze(dWindow)}; }catch(e){continue;}
    const signal=engine.decide(data,engine.neutralFundamental(),engine.neutralNewsRisk(),{ignoreQuality});
    if(signal.decision==='BUY'||signal.decision==='SELL'){
      position={
        dir:signal.decision, entry:bar.close, sl:signal.trade.stopLoss, tp1:signal.trade.targets[0],
        openIndex:i,openTime:bar.time,confidence:signal.confidence,quality:signal.quality?.score??null,
        agreeCount:signal.consensus.agreeCount,totalCount:signal.consensus.totalCount,
        session:sessionOf(bar.time),mfeR:0,maeR:0
      };
    }
  }
  if(position){
    const last=m15[m15.length-1], risk=Math.abs(position.entry-position.sl);
    const pl=position.dir==='BUY'?last.close-position.entry:position.entry-last.close;
    const mfe=position.dir==='BUY'?(last.high-position.entry)/risk:(position.entry-last.low)/risk;
    const mae=position.dir==='BUY'?(last.low-position.entry)/risk:(position.entry-last.high)/risk;
    trades.push({...position,exit:last.close,exitTime:last.time,result:pl>=0?'OPEN_WIN':'OPEN_LOSS',r:fmt(pl/risk),mfeR:Math.max(position.mfeR,mfe),maeR:Math.min(position.maeR,mae)});
  }
  return trades;
}

router.get('/data-test', async (req, res) => {
  if (!process.env.TWELVEDATA_API_KEY) {
    return res.json({ status: 'UNAVAILABLE', error: 'no-api-key-configured' });
  }

  const tf = String(req.query.tf || '15M').toUpperCase();
  const allowed = ['15M', '1H', '4H', 'DAILY'];
  const normalizedTf = tf === 'DAILY' ? 'Daily' : tf;
  if (!allowed.includes(tf)) {
    return res.status(400).json({ status: 'ERROR', error: 'invalid-timeframe', allowed });
  }

  const barsRequested = Math.max(220, Math.min(Number(req.query.bars) || 220, 5000));

  try {
    const bars = await engine.fetchTFHistory(normalizedTf, barsRequested);
    const meta = typeof engine.getHistoryMeta === 'function'
      ? engine.getHistoryMeta(normalizedTf)
      : bars?.historyMeta || null;

    return res.json({
      status: Array.isArray(bars) && bars.length ? 'OK' : 'UNAVAILABLE',
      symbol: engine.SYMBOL,
      timeframe: normalizedTf,
      requestedBars: barsRequested,
      returnedBars: Array.isArray(bars) ? bars.length : 0,
      history: meta,
      sample: Array.isArray(bars) ? bars.slice(-5).map(b => ({
        time: new Date(b.time).toISOString(),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume
      })) : []
    });
  } catch (e) {
    return res.json({
      status: 'ERROR',
      error: 'data-test-exception: ' + e.message,
      timeframe: normalizedTf
    });
  }
});

router.get('/',async(req,res)=>{
  if(!process.env.TWELVEDATA_API_KEY) return res.json({status:'UNAVAILABLE',error:'no-api-key-configured'});
  const months=Math.max(1,Math.min(Number(req.query.months)||6,24));
  const requestedBars=Number(req.query.bars)||Math.round(months*30.44*24*4);
  const m15Bars=Math.max(1000,Math.min(requestedBars,50000));
  const rollingWindow=220;
  const maxHoldDays=Math.max(1,Math.min(Number(req.query.maxHoldDays)||3,10));
  const maxHoldBars=maxHoldDays*96;
  const mode=String(req.query.mode||'quality').toLowerCase();
  try{
    const [m15,h1,h4,daily]=await Promise.all([
      engine.fetchTFHistory('15M',m15Bars+rollingWindow),
      engine.fetchTFHistory('1H',Math.ceil((m15Bars+rollingWindow)/4)+rollingWindow),
      engine.fetchTFHistory('4H',Math.ceil((m15Bars+rollingWindow)/16)+rollingWindow),
      engine.fetchTFHistory('Daily',Math.ceil((m15Bars+rollingWindow)/96)+rollingWindow)
    ]);
    if(!m15||!h1||!h4||!daily) return res.json({status:'UNAVAILABLE',error:'market-data-unavailable',history:{m15:engine.getHistoryMeta?.('15M')||m15?.historyMeta||null,h1:engine.getHistoryMeta?.('1H')||h1?.historyMeta||null,h4:engine.getHistoryMeta?.('4H')||h4?.historyMeta||null,daily:engine.getHistoryMeta?.('Daily')||daily?.historyMeta||null}});
    if(m15.length<rollingWindow+50) return res.json({status:'UNAVAILABLE',error:'insufficient-history-for-backtest'});

    const qualityTrades=simulate(m15,h1,h4,daily,rollingWindow,maxHoldBars,false);
    const baseTrades=mode==='compare'?simulate(m15,h1,h4,daily,rollingWindow,maxHoldBars,true):null;
    const trades=mode==='base'?simulate(m15,h1,h4,daily,rollingWindow,maxHoldBars,true):qualityTrades;
    const stats=tradeStats(trades);
    const result={status:'LIVE',mode,config:{requestedBars:m15Bars,rollingWindow,maxHoldDays,maxHoldBars,minConfidence:engine.MIN_CONFIDENCE,minRR:engine.MIN_RR,minQualityScore:Number(process.env.MIN_QUALITY_SCORE||65)},
      history:{m15:m15.historyMeta||null,h1:h1.historyMeta||null,h4:h4.historyMeta||null,daily:daily.historyMeta||null},
      period:{from:new Date(m15[Math.max(rollingWindow,100)].time).toISOString(),to:new Date(m15[m15.length-1].time).toISOString(),requestedBars:m15Bars,barsAvailable:m15.length,barsAnalyzed:m15.length-Math.max(rollingWindow,100),providerLimited:!!m15.historyMeta?.providerLimited},
      stats,
      diagnostics:{direction:groupStats(trades,t=>t.dir),session:groupStats(trades,t=>t.session),confidenceBand:groupStats(trades,t=>t.confidence<80?'70-79':t.confidence<90?'80-89':'90-96'),qualityBand:groupStats(trades,t=>t.quality==null?'NA':t.quality<65?'0-64':t.quality<75?'65-74':t.quality<85?'75-84':'85-100'),history:{m15:m15.historyMeta||null,h1:h1.historyMeta||null,h4:h4.historyMeta||null,daily:daily.historyMeta||null}},
      trades:trades.slice(-100).map(t=>({dir:t.dir,entry:fmt(t.entry),sl:fmt(t.sl),tp1:fmt(t.tp1),exit:fmt(t.exit),r:t.r,result:t.result,mfeR:fmt(t.mfeR),maeR:fmt(t.maeR),confidence:fmt(t.confidence),quality:t.quality,consensus:`${t.agreeCount}/${t.totalCount}`,session:t.session,openTime:new Date(t.openTime).toISOString(),exitTime:new Date(t.exitTime).toISOString()})),
      disclaimer:'بک‌تست روی داده تاریخی واقعی بازار اجرا شده است. فاندامنتال و خبر تاریخی لحظه‌به‌لحظه خنثی‌اند؛ ورود روی Close کندل سیگنال شبیه‌سازی شده؛ اسپرد/کمیسیون/Slippage مدل نشده؛ MFE/MAE فقط از کندل‌های بعد از ورود محاسبه می‌شوند. نتایج برای اعتبارسنجی خارج از نمونه تضمین‌کننده نیستند.'
    };
    if(baseTrades){
      const baseStats=tradeStats(baseTrades); const qKeys=new Set(qualityTrades.map(t=>`${t.openTime}|${t.dir}`));
      const retained=baseTrades.filter(t=>qKeys.has(`${t.openTime}|${t.dir}`)).length;
      result.compare={base:baseStats,quality:stats,retained,filtered:baseTrades.length-retained,retentionRate:baseTrades.length?fmt(retained/baseTrades.length*100):0,deltaNetR:fmt(stats.netR-baseStats.netR),deltaPF:(stats.profitFactor!=null&&baseStats.profitFactor!=null)?fmt(stats.profitFactor-baseStats.profitFactor):null};
    }
    res.json(result);
  }catch(e){res.json({status:'UNAVAILABLE',error:'backtest-exception: '+e.message});}
});

module.exports=router;
