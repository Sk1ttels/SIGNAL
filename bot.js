const https = require('https');
const express = require('express');

// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════
// IMPORTANT: set BOT_TOKEN in environment variables. Do NOT hardcode tokens.
const TOKEN   = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || null; // optional default chat for startup message
const PORT    = Number(process.env.PORT || 3000);
const SCAN_INTERVAL_MS = 60_000; // scan every 60 seconds

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
let autoMode    = false;
let scanTimer   = null;
let lastSigTime = {};     // sym+tf -> timestamp
let prices      = {};     // sym -> { price, base, vol }
let candles     = {};     // sym -> tf -> [{o,h,l,c,t}]
let offset      = 0;      // Telegram polling offset
let currentExpiry = '5m';
let currentTF     = '5m';
let sentSignalCount = 0;

if (!TOKEN) {
  console.error('❌ Missing BOT_TOKEN env. Set BOT_TOKEN before запуск.');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════
// FOREX & OTC PAIRS
// ═══════════════════════════════════════════════════════
const FIN_PAIRS = [
  {sym:'GBPJPY',name:'GBP/JPY',base:191.50,vol:0.00025},
  {sym:'EURJPY',name:'EUR/JPY',base:163.20,vol:0.00022},
  {sym:'AUDCAD',name:'AUD/CAD',base:0.9020, vol:0.00018},
  {sym:'AUDCHF',name:'AUD/CHF',base:0.5780, vol:0.00018},
  {sym:'AUDJPY',name:'AUD/JPY',base:99.50,  vol:0.00022},
  {sym:'AUDUSD',name:'AUD/USD',base:0.6520, vol:0.00015},
  {sym:'CADCHF',name:'CAD/CHF',base:0.6590, vol:0.00018},
  {sym:'CADJPY',name:'CAD/JPY',base:111.20, vol:0.00022},
  {sym:'CHFJPY',name:'CHF/JPY',base:168.40, vol:0.00022},
  {sym:'EURCAD',name:'EUR/CAD',base:1.4720, vol:0.00020},
  {sym:'EURCHF',name:'EUR/CHF',base:0.9620, vol:0.00015},
  {sym:'EURUSD',name:'EUR/USD',base:1.0855, vol:0.00012},
  {sym:'GBPAUD',name:'GBP/AUD',base:1.9720, vol:0.00025},
  {sym:'GBPCAD',name:'GBP/CAD',base:1.7220, vol:0.00022},
  {sym:'GBPCHF',name:'GBP/CHF',base:1.1340, vol:0.00020},
  {sym:'GBPUSD',name:'GBP/USD',base:1.2690, vol:0.00015},
  {sym:'USDCAD',name:'USD/CAD',base:1.3620, vol:0.00012},
  {sym:'USDCHF',name:'USD/CHF',base:0.8850, vol:0.00012},
  {sym:'USDJPY',name:'USD/JPY',base:151.50, vol:0.00015},
  {sym:'EURAUD',name:'EUR/AUD',base:1.6540, vol:0.00022},
  {sym:'EURGBP',name:'EUR/GBP',base:0.8560, vol:0.00012},
];

const OTC_PAIRS = [
  {sym:'AUDCAD_OTC',name:'AUD/CAD',base:0.9020, vol:0.00022},
  {sym:'AUDCHF_OTC',name:'AUD/CHF',base:0.5780, vol:0.00022},
  {sym:'AUDJPY_OTC',name:'AUD/JPY',base:99.50,  vol:0.00025},
  {sym:'AUDUSD_OTC',name:'AUD/USD',base:0.6520, vol:0.00018},
  {sym:'CADJPY_OTC',name:'CAD/JPY',base:111.20, vol:0.00025},
  {sym:'CADCHF_OTC',name:'CAD/CHF',base:0.6590, vol:0.00022},
  {sym:'CHFJPY_OTC',name:'CHF/JPY',base:168.40, vol:0.00025},
  {sym:'EURJPY_OTC',name:'EUR/JPY',base:163.20, vol:0.00025},
  {sym:'EURUSD_OTC',name:'EUR/USD',base:1.0855, vol:0.00015},
  {sym:'EURGBP_OTC',name:'EUR/GBP',base:0.8560, vol:0.00015},
  {sym:'EURCHF_OTC',name:'EUR/CHF',base:0.9620, vol:0.00018},
  {sym:'EURAUD_OTC',name:'EUR/AUD',base:1.6540, vol:0.00025},
  {sym:'GBPJPY_OTC',name:'GBP/JPY',base:191.50, vol:0.00030},
  {sym:'GBPUSD_OTC',name:'GBP/USD',base:1.2690, vol:0.00018},
  {sym:'GBPAUD_OTC',name:'GBP/AUD',base:1.9720, vol:0.00030},
  {sym:'NZDJPY_OTC',name:'NZD/JPY',base:91.20,  vol:0.00025},
  {sym:'NZDUSD_OTC',name:'NZD/USD',base:0.6020, vol:0.00018},
  {sym:'USDCAD_OTC',name:'USD/CAD',base:1.3620, vol:0.00015},
  {sym:'USDCHF_OTC',name:'USD/CHF',base:0.8850, vol:0.00015},
  {sym:'USDJPY_OTC',name:'USD/JPY',base:151.50, vol:0.00018},
  {sym:'USDMXN_OTC',name:'USD/MXN',base:17.20,  vol:0.00040},
  {sym:'USDINR_OTC',name:'USD/INR',base:83.20,  vol:0.00020},
  {sym:'USDMYR_OTC',name:'USD/MYR',base:4.720,  vol:0.00025},
  {sym:'USDSGD_OTC',name:'USD/SGD',base:1.3420, vol:0.00015},
  {sym:'USDTHB_OTC',name:'USD/THB',base:35.20,  vol:0.00025},
  {sym:'USDBRL_OTC',name:'USD/BRL',base:5.020,  vol:0.00040},
  {sym:'USDPHP_OTC',name:'USD/PHP',base:56.20,  vol:0.00030},
  {sym:'USDCNH_OTC',name:'USD/CNH',base:7.240,  vol:0.00015},
  {sym:'UAHUSD_OTC',name:'UAH/USD',base:0.0267, vol:0.00040},
  {sym:'EURNZD_OTC',name:'EUR/NZD',base:1.7820, vol:0.00025},
  {sym:'EURTRY_OTC',name:'EUR/TRY',base:35.20,  vol:0.00060},
];

const ALL_PAIRS = [...FIN_PAIRS, ...OTC_PAIRS];

// ═══════════════════════════════════════════════════════
// PRICE SIMULATION (realistic forex micro-movement)
// ═══════════════════════════════════════════════════════
function tfMs(tf) {
  return {'1m':60e3,'5m':300e3,'15m':900e3,'1h':3600e3,'4h':14400e3}[tf] || 300e3;
}

function initPrices() {
  ALL_PAIRS.forEach(p => {
    if (prices[p.sym]) return;
    prices[p.sym] = { price: p.base, base: p.base, vol: p.vol };
    candles[p.sym] = {};
    ['1m','5m','15m','1h','4h'].forEach(tf => {
      candles[p.sym][tf] = [];
      let price = p.base * (0.985 + Math.random() * 0.03);
      for (let i = 0; i < 200; i++) {
        const v = p.vol * (0.4 + Math.random() * 2.5);
        const bias = (Math.random() - 0.495) * 0.2;
        const o = price;
        const c = o * (1 + (Math.random() - 0.5) * v * 2 + bias * v);
        const h = Math.max(o, c) * (1 + Math.random() * v * 0.6);
        const l = Math.min(o, c) * (1 - Math.random() * v * 0.6);
        candles[p.sym][tf].push({ o, h, l, c, t: Date.now() - (200 - i) * tfMs(tf) });
        price = c;
      }
      prices[p.sym].price = price;
    });
  });
  console.log(`✅ Initialized ${ALL_PAIRS.length} pairs`);
}

function tickPrices() {
  ALL_PAIRS.forEach(p => {
    const st = prices[p.sym];
    const tick = (Math.random() - 0.499) * st.vol * st.price * 0.5;
    st.price += tick;
    const now = Date.now();
    ['1m','5m','15m','1h','4h'].forEach(tf => {
      const arr = candles[p.sym][tf];
      if (!arr || !arr.length) return;
      const last = arr[arr.length - 1];
      if (now - last.t >= tfMs(tf)) {
        arr.push({ o: last.c, h: st.price, l: st.price, c: st.price, t: now });
        if (arr.length > 300) arr.shift();
      } else {
        last.c = st.price;
        last.h = Math.max(last.h, st.price);
        last.l = Math.min(last.l, st.price);
      }
    });
  });
}

// ═══════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const res = new Array(data.length).fill(null);
  let ema = null;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) continue;
    if (ema === null) ema = data.slice(0, period).reduce((a, b) => a + b) / period;
    else ema = data[i] * k + ema * (1 - k);
    res[i] = ema;
  }
  return res;
}

function calcRSI(data, period = 14) {
  if (data.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = data[i] - data[i - 1];
    d > 0 ? g += d : l -= d;
  }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < data.length; i++) {
    const d = data[i] - data[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return al === 0 ? 100 : 100 - (100 / (1 + ag / al));
}

function calcMACD(data) {
  const e12 = calcEMA(data, 12), e26 = calcEMA(data, 26);
  const line = data.map((_, i) => e12[i] !== null && e26[i] !== null ? e12[i] - e26[i] : null);
  const valid = line.filter(x => x !== null);
  if (valid.length < 9) return { crossUp: false, crossDown: false, hist: 0, macd: null };
  const sig = calcEMA(valid, 9);
  const n = valid.length - 1;
  return {
    macd: valid[n], signal: sig[n], hist: valid[n] - sig[n],
    crossUp:   valid[n-1] < sig[n-1] && valid[n] > sig[n],
    crossDown: valid[n-1] > sig[n-1] && valid[n] < sig[n]
  };
}

function calcBB(data, period = 20, mult = 2) {
  if (data.length < period) return { valid: false };
  const n = data.length - 1;
  const sl = data.slice(n - period + 1, n + 1);
  const m = sl.reduce((a, b) => a + b) / period;
  const std = Math.sqrt(sl.map(x => (x - m) ** 2).reduce((a, b) => a + b) / period);
  const lastU = m + mult * std, lastL = m - mult * std;
  return { lastU, lastL, lastM: m, valid: lastU > lastL && (lastU - lastL) / m > 0.0001 };
}

function calcStochRSI(data, period = 14) {
  const rsis = [];
  for (let i = period; i <= data.length; i++)
    rsis.push(calcRSI(data.slice(i - period, i), period - 1) || 50);
  if (rsis.length < period) return { k: 50 };
  const sl = rsis.slice(-period);
  const hi = Math.max(...sl), lo = Math.min(...sl);
  const k = hi === lo ? 50 : ((rsis[rsis.length - 1] - lo) / (hi - lo)) * 100;
  return { k };
}

function calcATR(arr, period = 14) {
  if (arr.length < period + 1) return null;
  const trs = arr.slice(1).map((c, i) =>
    Math.max(c.h - c.l, Math.abs(c.h - arr[i].c), Math.abs(c.l - arr[i].c))
  );
  let atr = trs.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

function calcADX(arr, period = 14) {
  if (arr.length < period * 3) return { adx: 0, pdi: 0, mdi: 0 };
  const data = arr.slice(-150);
  const pDM = [], mDM = [], tr = [];
  for (let i = 1; i < data.length; i++) {
    const up = data[i].h - data[i-1].h, dn = data[i-1].l - data[i].l;
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(data[i].h - data[i].l, Math.abs(data[i].h - data[i-1].c), Math.abs(data[i].l - data[i-1].c)));
  }
  const ws = (arr, p) => {
    if (arr.length < p) return [];
    let v = arr.slice(0, p).reduce((a, b) => a + b);
    const r = [v];
    for (let i = p; i < arr.length; i++) { v = v - v / p + arr[i]; r.push(v); }
    return r;
  };
  const sTR = ws(tr, period), sPDM = ws(pDM, period), sMDM = ws(mDM, period);
  if (!sTR.length) return { adx: 0, pdi: 0, mdi: 0 };
  const pdi = sPDM.map((v, i) => sTR[i] > 0 ? Math.min(v / sTR[i] * 100, 100) : 0);
  const mdi = sMDM.map((v, i) => sTR[i] > 0 ? Math.min(v / sTR[i] * 100, 100) : 0);
  const dx  = pdi.map((v, i) => (v + mdi[i]) > 0 ? Math.abs(v - mdi[i]) / (v + mdi[i]) * 100 : 0);
  const adxArr = ws(dx, period);
  const n = adxArr.length - 1;
  return { adx: Math.min(adxArr[n] / period, 100), pdi: pdi.at(-1), mdi: mdi.at(-1) };
}

// ═══════════════════════════════════════════════════════
// CANDLE PATTERNS
// ═══════════════════════════════════════════════════════
function candlePattern(arr, dir) {
  if (arr.length < 4) return { ok: false, name: '' };
  const c = arr.at(-1), p1 = arr.at(-2), p2 = arr.at(-3);
  const body = x => Math.abs(x.c - x.o);
  const bull = x => x.c > x.o, bear = x => x.c < x.o;
  const atr10 = arr.slice(-10).reduce((s, x) => s + (x.h - x.l), 0) / 10;

  if (dir === 'BUY') {
    if (bear(p1) && bull(c) && c.c > p1.o && c.o < p1.c && body(c) > body(p1) * 0.9)
      return { ok: true, name: 'Бичаче поглинання' };
    const lw = Math.min(c.o, c.c) - c.l, uw = c.h - Math.max(c.o, c.c);
    if (lw > body(c) * 2 && uw < body(c) * 0.6 && lw > atr10 * 0.3)
      return { ok: true, name: 'Молот 🔨' };
    if (bull(c) && bull(p1) && bull(p2) && c.c > p1.c && p1.c > p2.c)
      return { ok: true, name: 'Три бики ✅' };
    if (lw > body(c) * 3 && c.c > (c.h + c.l) / 2)
      return { ok: true, name: 'Пін-бар (підтримка)' };
    if (bull(c) && body(c) > atr10 * 0.6)
      return { ok: true, name: 'Сильна бичача свічка' };
  }
  if (dir === 'SELL') {
    if (bull(p1) && bear(c) && c.c < p1.o && c.o > p1.c && body(c) > body(p1) * 0.9)
      return { ok: true, name: 'Ведмеже поглинання' };
    const uw2 = c.h - Math.max(c.o, c.c), lw2 = Math.min(c.o, c.c) - c.l;
    if (uw2 > body(c) * 2 && lw2 < body(c) * 0.6 && uw2 > atr10 * 0.3)
      return { ok: true, name: 'Зірка падіння 💫' };
    if (bear(c) && bear(p1) && bear(p2) && c.c < p1.c && p1.c < p2.c)
      return { ok: true, name: 'Три ведмеді ✅' };
    if (uw2 > body(c) * 3 && c.c < (c.h + c.l) / 2)
      return { ok: true, name: 'Пін-бар (спротив)' };
    if (bear(c) && body(c) > atr10 * 0.6)
      return { ok: true, name: 'Сильна ведмежа свічка' };
  }
  return { ok: false, name: '' };
}

// ═══════════════════════════════════════════════════════
// SIGNAL SCORE ENGINE
// ═══════════════════════════════════════════════════════
function getScore(sym, tf) {
  const arr = (candles[sym] || {})[tf] || [];
  if (arr.length < 80) return null;
  const closes = arr.map(c => c.c);
  const rsi    = calcRSI(closes);
  const macd   = calcMACD(closes);
  const bb     = calcBB(closes);
  const stoch  = calcStochRSI(closes);
  const e9     = calcEMA(closes, 9).at(-1);
  const e21    = calcEMA(closes, 21).at(-1);
  const e50    = calcEMA(closes, 50).at(-1);
  const atr    = calcATR(arr);
  const adx    = calcADX(arr);
  const last   = closes.at(-1), prev = closes.at(-2);

  let bV = 0, sV = 0;
  const bR = [], sR = [];

  // 1. RSI
  if (rsi !== null) {
    if (rsi <= 33) { bV++; bR.push(`RSI ${rsi.toFixed(0)} — перепродано`); }
    else if (rsi >= 67) { sV++; sR.push(`RSI ${rsi.toFixed(0)} — перекуплено`); }
  }
  // 2. MACD cross
  if (macd.crossUp)   { bV++; bR.push('MACD ↑ перетин'); }
  if (macd.crossDown) { sV++; sR.push('MACD ↓ перетин'); }
  if (!macd.crossUp   && macd.hist > 0 && macd.macd < 0) { bV++; bR.push('MACD імпульс ↑'); }
  if (!macd.crossDown && macd.hist < 0 && macd.macd > 0) { sV++; sR.push('MACD імпульс ↓'); }
  // 3. BB
  if (bb.valid) {
    const pos  = Math.max(0, Math.min(1, (last - bb.lastL) / (bb.lastU - bb.lastL)));
    const pp   = Math.max(0, Math.min(1, (prev - bb.lastL) / (bb.lastU - bb.lastL)));
    if (pos <= 0.12 && pos >= pp - 0.02) { bV++; bR.push(`BB нижня зона (${(pos*100).toFixed(0)}%)`); }
    if (pos >= 0.88 && pos <= pp + 0.02) { sV++; sR.push(`BB верхня зона (${(pos*100).toFixed(0)}%)`); }
  }
  // 4. EMA
  if (e9 && e21 && e50) {
    if (e9 > e21 && last > e50) { bV++; bR.push('EMA: 9>21, ціна вище 50'); }
    if (e9 < e21 && last < e50) { sV++; sR.push('EMA: 9<21, ціна нижче 50'); }
  }
  // 5. Stoch
  if (stoch.k <= 25) { bV++; bR.push(`Stoch RSI ${stoch.k.toFixed(0)} — зона покупок`); }
  else if (stoch.k >= 75) { sV++; sR.push(`Stoch RSI ${stoch.k.toFixed(0)} — зона продаж`); }

  const maxV = Math.max(bV, sV);
  if (maxV < 3) return null;
  const dir = bV >= 3 ? 'BUY' : 'SELL';
  const reasons = dir === 'BUY' ? [...bR] : [...sR];

  // Filters
  if (maxV === 3 && !reasons.some(r => r.includes('MACD'))) return null;
  if (adx.adx < 15) return null;
  if (dir === 'BUY'  && adx.pdi < adx.mdi - 5) return null;
  if (dir === 'SELL' && adx.mdi < adx.pdi - 5) return null;
  if (!atr) return null;
  const atrPct = atr / last * 100;
  if (atrPct < 0.01 || atrPct > 12) return null;

  const pat = candlePattern(arr, dir);
  if (!pat.ok) return null;
  reasons.push(`📊 ${pat.name}`);

  let conf = maxV === 5 ? 88 : maxV === 4 ? 83 : 77;
  if (adx.adx > 30) conf += 4;
  if (atrPct > 0.02 && atrPct < 3) conf += 3;
  const opp = dir === 'BUY' ? sV : bV;
  if (opp === 0) conf += 4;
  conf = Math.min(conf, 97);

  return { dir, conf, reasons, pattern: pat.name, votes: maxV };
}

// ═══════════════════════════════════════════════════════
// SCAN ALL PAIRS → best signal
// ═══════════════════════════════════════════════════════
function scanAllPairs(tf = currentTF) {
  let best = null, bestConf = 0;
  ALL_PAIRS.forEach(p => {
    const now  = Date.now();
    const key  = p.sym + tf;
    const last = lastSigTime[key] || 0;
    if (now - last < tfMs(tf) * 4) return; // cooldown
    const score = getScore(p.sym, tf);
    if (!score) return;
    if (score.conf > bestConf) {
      bestConf = score.conf;
      best = { pair: p, score, price: prices[p.sym]?.price || p.base };
    }
  });
  return best;
}

// ═══════════════════════════════════════════════════════
// TIME HELPERS
// ═══════════════════════════════════════════════════════
function addMins(d, m) {
  const r = new Date(d.getTime() + m * 60000);
  return r.getHours().toString().padStart(2,'0') + ':' + r.getMinutes().toString().padStart(2,'0');
}

function entryTimeStr() {
  const n = new Date();
  n.setMinutes(n.getMinutes() + 1);
  return n.getHours().toString().padStart(2,'0') + ':' + n.getMinutes().toString().padStart(2,'0');
}

function reentryTimes() {
  const n = new Date();
  const mins = { '1m':1,'5m':5,'10m':10,'15m':15,'30m':30,'1h':60 }[currentExpiry] || 5;
  return [ addMins(n, mins + 1), addMins(n, mins * 2 + 1) ];
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// ═══════════════════════════════════════════════════════
// BUILD TELEGRAM MESSAGE
// ═══════════════════════════════════════════════════════
function buildMsg(pair, score, price) {
  const isBuy   = score.dir === 'BUY';
  const entry   = entryTimeStr();
  const [re1, re2] = reentryTimes();
  const typeFlag = pair.sym.includes('OTC') ? '🔄 OTC' : '📈 FIN';
  const arrow    = isBuy ? '🚀' : '📉';
  const circle   = isBuy ? '🟢' : '🔴';
  const dirText  = isBuy ? '▲ КУПИТИ' : '▼ ПРОДАТИ';
  const confBar  = '█'.repeat(Math.round(score.conf / 10)) + '░'.repeat(10 - Math.round(score.conf / 10));

  const reasons = (score.reasons || []).slice(0, 6).map(r => `• ${escapeHtml(r)}`).join('<br>');

  return `${arrow} <b>${escapeHtml(score.dir)}</b> · <b>${typeFlag}</b>
━━━━━━━━━━━━━━━━━━
🏦 <b>${escapeHtml(pair.name)}</b>
⏱ Експірація: <b>${escapeHtml(currentExpiry.toUpperCase())}</b>
🎯 Точка входу: <b><code>${escapeHtml(entry)}</code></b>
${circle} <b>${escapeHtml(dirText)}</b>

▲ <b>Додатковий вхід (мартингейл):</b>
1️⃣ Рівень о <code>${escapeHtml(re1)}</code>
2️⃣ Рівень о <code>${escapeHtml(re2)}</code>
━━━━━━━━━━━━━━━━━━
⚡ Впевненість: <b>${score.conf}%</b>
<code>${confBar}</code>
✅ Підтверджень: <b>${score.votes}/5</b>
📊 Патерн: <i>${escapeHtml(score.pattern || '—')}</i>

<b>Підстави:</b><br>${reasons || '—'}`;
}

// ═══════════════════════════════════════════════════════
// TELEGRAM API HELPERS
// ═══════════════════════════════════════════════════════
function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function sendMsg(text, chatId = CHAT_ID, extra = {}) {
  try {
    await tgRequest('sendMessage', {
      chat_id: chatId,
      text,
      ...extra,
      parse_mode: extra.parse_mode || 'HTML'
    });
  } catch (e) { console.error('TG send error:', e.message); }
}

async function getUpdates() {
  try {
    const res = await tgRequest('getUpdates', { offset, timeout: 30, limit: 10 });
    return res.result || [];
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════
// BOT COMMANDS
// ═══════════════════════════════════════════════════════
const MENU = `
*SIGNAL PRO — Команди:*

/auto — 🤖 Увімкнути/вимкнути авторежим
/signal — 📡 Найкращий сигнал зараз
/fin — 📈 Сканувати FIN пари
/otc — 🔄 Сканувати OTC пари
/expiry — ⏱ Встановити експірацію
/tf — 🕐 Встановити таймфрейм
/pairs — 📋 Список пар
/status — ℹ️ Статус бота
/stop — ⏹ Зупинити авторежим
`;

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔥 Best', callback_data: 'best:ALL' },
        { text: '📈 FIN', callback_data: 'best:FIN' },
        { text: '🔄 OTC', callback_data: 'best:OTC' },
      ],
      [
        { text: '🤖 Auto ON/OFF', callback_data: 'auto:toggle' },
        { text: '⚙️ Налаштування', callback_data: 'settings:open' },
      ],
      [
        { text: '📋 Пари', callback_data: 'pairs:list' },
        { text: 'ℹ️ Статус', callback_data: 'status:show' },
      ]
    ]
  };
}

function settingsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⏱ Exp 1m', callback_data: 'setexp:1m' },
        { text: '⏱ Exp 5m', callback_data: 'setexp:5m' },
        { text: '⏱ Exp 15m', callback_data: 'setexp:15m' },
        { text: '⏱ Exp 30m', callback_data: 'setexp:30m' },
        { text: '⏱ Exp 1h', callback_data: 'setexp:1h' },
      ],
      [
        { text: '🕐 TF 1m', callback_data: 'settf:1m' },
        { text: '🕐 TF 5m', callback_data: 'settf:5m' },
        { text: '🕐 TF 15m', callback_data: 'settf:15m' },
        { text: '🕐 TF 1h', callback_data: 'settf:1h' },
        { text: '🕐 TF 4h', callback_data: 'settf:4h' },
      ],
      [
        { text: '⬅️ Назад', callback_data: 'menu:open' }
      ]
    ]
  };
}

async function sendMenu(chatId) {
  await sendMsg(
    `🤖 <b>SIGNAL PRO</b>
<i>Сигнали Forex & OTC</i>

<b>Поточні налаштування</b>
⏱ Exp: <code>${currentExpiry.toUpperCase()}</code>
🕐 TF: <code>${currentTF.toUpperCase()}</code>
🤖 Auto: <b>${autoMode ? 'ON' : 'OFF'}</b>`,
    chatId,
    { reply_markup: mainKeyboard(), parse_mode: 'HTML' }
  );
}

async function handleCommand(msg) {
  const text    = msg.text || '';
  const chatId  = msg.chat.id.toString();
  const cmd     = text.split(' ')[0].toLowerCase().replace('@signalprobot','');

  console.log(`[CMD] ${chatId}: ${text}`);

  if (cmd === '/start' || cmd === '/help') {
    await sendMenu(chatId);

  } else if (cmd === '/auto') {
    autoMode = !autoMode;
    if (autoMode) {
      await sendMsg('🤖 <b>АВТО РЕЖИМ УВІМКНЕНО</b>\n\nБот сканує всі пари і надсилає сигнали автоматично.\n\nЩоб зупинити: /stop', chatId);
      startAutoScan(chatId);
    } else {
      stopAutoScan();
      await sendMsg('⏹ Авторежим вимкнено.', chatId);
    }

  } else if (cmd === '/stop') {
    autoMode = false;
    stopAutoScan();
    await sendMsg('⏹ <b>Авторежим зупинено.</b>', chatId);

  } else if (cmd === '/signal' || cmd === '/fin') {
    await sendMsg('🔍 Сканую FIN пари...', chatId);
    const best = scanBestFrom(FIN_PAIRS);
    if (best) {
      lastSigTime[best.pair.sym + currentTF] = Date.now();
      sentSignalCount++;
      await sendMsg(buildMsg(best.pair, best.score, best.price), chatId, { reply_markup: mainKeyboard() });
    } else {
      await sendMsg('⊘ Немає чітких сигналів зараз.\n\nСпробуй змінити таймфрейм (/tf) або пізніше.', chatId, { reply_markup: mainKeyboard() });
    }

  } else if (cmd === '/otc') {
    await sendMsg('🔍 Сканую OTC пари...', chatId);
    const best = scanBestFrom(OTC_PAIRS);
    if (best) {
      lastSigTime[best.pair.sym + currentTF] = Date.now();
      sentSignalCount++;
      await sendMsg(buildMsg(best.pair, best.score, best.price), chatId, { reply_markup: mainKeyboard() });
    } else {
      await sendMsg('⊘ Немає чітких OTC сигналів зараз.', chatId, { reply_markup: mainKeyboard() });
    }

  } else if (cmd === '/expiry') {
    const opts = ['1m','5m','10m','15m','30m','1h'];
    await sendMsg(
      `⏱ <b>Поточна експірація:</b> <code>${currentExpiry.toUpperCase()}</code>\n\nНатисни кнопку або відправ: <code>/setexpiry 5m</code>`,
      chatId,
      { reply_markup: settingsKeyboard() }
    );

  } else if (cmd === '/setexpiry') {
    const val = text.split(' ')[1];
    if (['1m','5m','10m','15m','30m','1h'].includes(val)) {
      currentExpiry = val;
      await sendMsg(`✅ Експірація встановлена: <b>${val.toUpperCase()}</b>`, chatId, { reply_markup: mainKeyboard() });
    } else {
      await sendMsg('❌ Невірне значення. Приклад: <code>/setexpiry 5m</code>', chatId, { reply_markup: mainKeyboard() });
    }

  } else if (cmd === '/tf') {
    const opts = ['1m','5m','15m','1h','4h'];
    await sendMsg(
      `🕐 <b>Поточний таймфрейм:</b> <code>${currentTF.toUpperCase()}</code>\n\nНатисни кнопку або відправ: <code>/settf 5m</code>`,
      chatId,
      { reply_markup: settingsKeyboard() }
    );

  } else if (cmd === '/settf') {
    const val = text.split(' ')[1];
    if (['1m','5m','15m','1h','4h'].includes(val)) {
      currentTF = val;
      await sendMsg(`✅ Таймфрейм: <b>${val.toUpperCase()}</b>`, chatId, { reply_markup: mainKeyboard() });
    } else {
      await sendMsg('❌ Невірне значення. Приклад: <code>/settf 15m</code>', chatId, { reply_markup: mainKeyboard() });
    }

  } else if (cmd === '/pair') {
    const sym = (text.split(' ')[1] || '').toUpperCase();
    const pair = ALL_PAIRS.find(p => p.sym === sym || p.name.replace('/','') === sym || p.name.replace('/','') + '_OTC' === sym);
    if (!pair) {
      return sendMsg('Не знайшов пару. Приклад: <code>/pair EURUSD</code> або <code>/pair EURUSD_OTC</code>', chatId, { reply_markup: mainKeyboard() });
    }
    tickPrices();
    const best = scanBestFrom([pair]);
    if (!best) return sendMsg('⊘ По цій парі зараз немає чіткого сигналу. Спробуй інший TF.', chatId, { reply_markup: mainKeyboard() });
    lastSigTime[pair.sym + currentTF] = Date.now();
    sentSignalCount++;
    return sendMsg(buildMsg(best.pair, best.score, best.price), chatId, { reply_markup: mainKeyboard() });

  } else if (cmd === '/pairs') {
    await sendMsg(
      `📋 <b>Пари</b>\n\n📈 FIN: <b>${FIN_PAIRS.length}</b>\n🔄 OTC: <b>${OTC_PAIRS.length}</b>\n\nХочеш сигнал по конкретній парі — напиши: <code>/pair EURUSD</code>`,
      chatId,
      { reply_markup: mainKeyboard() }
    );

  } else if (cmd === '/status') {
    await sendMsg(
      `ℹ️ <b>SIGNAL PRO статус</b>\n\n` +
      `🤖 Auto: <b>${autoMode ? 'ON' : 'OFF'}</b>\n` +
      `⏱ Exp: <code>${currentExpiry.toUpperCase()}</code>\n` +
      `🕐 TF: <code>${currentTF.toUpperCase()}</code>\n` +
      `📨 Сигналів надіслано: <b>${sentSignalCount}</b>\n` +
      `📊 Пар: <b>${ALL_PAIRS.length}</b>\n` +
      `⏰ Uptime: <b>${Math.round(process.uptime() / 60)}</b> хв`,
      chatId,
      { reply_markup: mainKeyboard() }
    );

  } else {
    await sendMsg(`Невідома команда. Натисни /start`, chatId, { reply_markup: mainKeyboard() });
  }
}

async function answerCb(cbId, text) {
  try {
    await tgRequest('answerCallbackQuery', { callback_query_id: cbId, text, show_alert: false });
  } catch {}
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id?.toString();
  const data = cb.data || '';
  await answerCb(cb.id, '✅');
  if (!chatId) return;

  if (data === 'menu:open') {
    return sendMenu(chatId);
  }

  if (data === 'auto:toggle') {
    autoMode = !autoMode;
    if (autoMode) startAutoScan(chatId); else stopAutoScan();
    return sendMenu(chatId);
  }

  if (data === 'settings:open') {
    return sendMsg(
      `⚙️ <b>Налаштування</b>\n\n⏱ Exp: <code>${currentExpiry.toUpperCase()}</code>\n🕐 TF: <code>${currentTF.toUpperCase()}</code>`,
      chatId,
      { reply_markup: settingsKeyboard() }
    );
  }

  if (data.startsWith('setexp:')) {
    const val = data.split(':')[1];
    if (['1m','5m','10m','15m','30m','1h'].includes(val)) currentExpiry = val;
    return sendMenu(chatId);
  }

  if (data.startsWith('settf:')) {
    const val = data.split(':')[1];
    if (['1m','5m','15m','1h','4h'].includes(val)) currentTF = val;
    return sendMenu(chatId);
  }

  if (data === 'status:show') {
    const totalPairs = ALL_PAIRS.length;
    return sendMsg(
      `ℹ️ <b>Статус</b>\n\n📊 Пари: <b>${totalPairs}</b>\n⏱ Exp: <code>${currentExpiry.toUpperCase()}</code>\n🕐 TF: <code>${currentTF.toUpperCase()}</code>\n🤖 Auto: <b>${autoMode ? 'ON' : 'OFF'}</b>\n📨 Сигналів надіслано: <b>${sentSignalCount}</b>`,
      chatId,
      { reply_markup: mainKeyboard() }
    );
  }

  if (data === 'pairs:list') {
    const finCount = FIN_PAIRS.length;
    const otcCount = OTC_PAIRS.length;
    return sendMsg(
      `📋 <b>Список пар</b>\n\n📈 FIN: <b>${finCount}</b>\n🔄 OTC: <b>${otcCount}</b>\n\nХочеш конкретну — напиши, наприклад: <code>/pair EURUSD</code>`,
      chatId,
      { reply_markup: mainKeyboard() }
    );
  }

  if (data.startsWith('best:')) {
    const mode = data.split(':')[1];
    tickPrices();
    const pool = mode === 'FIN' ? FIN_PAIRS : mode === 'OTC' ? OTC_PAIRS : ALL_PAIRS;
    const best = scanBestFrom(pool);
    if (!best) return sendMsg('⊘ Немає чітких сигналів зараз.', chatId, { reply_markup: mainKeyboard() });
    lastSigTime[best.pair.sym + currentTF] = Date.now();
    sentSignalCount++;
    return sendMsg(buildMsg(best.pair, best.score, best.price), chatId, { reply_markup: mainKeyboard() });
  }
}

// ═══════════════════════════════════════════════════════
// AUTO SCAN LOOP
// ═══════════════════════════════════════════════════════
function scanBestFrom(pairs) {
  let best = null, bestConf = 0;
  pairs.forEach(p => {
    const key  = p.sym + currentTF;
    const last = lastSigTime[key] || 0;
    if (Date.now() - last < tfMs(currentTF) * 4) return;
    const score = getScore(p.sym, currentTF);
    if (!score) return;
    if (score.conf > bestConf) {
      bestConf = score.conf;
      best = { pair: p, score, price: prices[p.sym]?.price || p.base };
    }
  });
  return best;
}

let autoScanChatId = CHAT_ID;

function startAutoScan(chatId) {
  autoScanChatId = chatId || CHAT_ID;
  clearInterval(scanTimer);
  scanTimer = setInterval(async () => {
    if (!autoMode) { clearInterval(scanTimer); return; }
    tickPrices(); // update simulation
    // Scan all pairs, send best
    const best = scanBestFrom(ALL_PAIRS);
    if (best) {
      lastSigTime[best.pair.sym + currentTF] = Date.now();
      sentSignalCount++;
      console.log(`[SIGNAL] ${best.score.dir} ${best.pair.name} ${best.score.conf}%`);
      await sendMsg(buildMsg(best.pair, best.score, best.price), autoScanChatId);
    } else {
      console.log('[SCAN] No signals this round');
    }
  }, SCAN_INTERVAL_MS);
  console.log(`[AUTO] Started scanning every ${SCAN_INTERVAL_MS/1000}s`);
}

function stopAutoScan() {
  clearInterval(scanTimer);
  scanTimer = null;
  console.log('[AUTO] Stopped');
}

// ═══════════════════════════════════════════════════════
// PRICE TICK LOOP (every 5s)
// ═══════════════════════════════════════════════════════
setInterval(tickPrices, 5000);

// ═══════════════════════════════════════════════════════
// POLLING LOOP
// ═══════════════════════════════════════════════════════
async function poll() {
  const updates = await getUpdates();
  for (const upd of updates) {
    offset = upd.update_id + 1;
    if (upd.message?.text) {
      await handleCommand(upd.message);
    } else if (upd.callback_query) {
      await handleCallback(upd.callback_query);
    }
  }
  setTimeout(poll, 500);
}

// ═══════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════
console.log('🚀 SIGNAL PRO Bot starting...');
initPrices();

// ═══════════════════════════════════════════════════════
// HTTP API (for site/WebApp) — same logic as bot
// ═══════════════════════════════════════════════════════
const app = express();
app.use(express.json());

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    autoMode,
    expiry: currentExpiry,
    tf: currentTF,
    pairs: { fin: FIN_PAIRS.length, otc: OTC_PAIRS.length, all: ALL_PAIRS.length },
    sentSignalCount,
    uptimeSec: Math.round(process.uptime())
  });
});

app.get('/api/pairs', (req, res) => {
  const market = String(req.query.market || 'ALL').toUpperCase();
  const list = market === 'FIN' ? FIN_PAIRS : market === 'OTC' ? OTC_PAIRS : ALL_PAIRS;
  res.json({ ok: true, market, pairs: list.map(p => ({ sym: p.sym, name: p.name })) });
});

app.get('/api/best', (req, res) => {
  const market = String(req.query.market || 'ALL').toUpperCase();
  const tf = String(req.query.tf || currentTF);
  const exp = String(req.query.expiry || currentExpiry);
  if (['1m','5m','15m','1h','4h'].includes(tf)) currentTF = tf;
  if (['1m','5m','10m','15m','30m','1h'].includes(exp)) currentExpiry = exp;
  tickPrices();
  const pool = market === 'FIN' ? FIN_PAIRS : market === 'OTC' ? OTC_PAIRS : ALL_PAIRS;
  const best = scanBestFrom(pool);
  if (!best) return res.json({ ok: true, signal: null });
  res.json({
    ok: true,
    signal: {
      sym: best.pair.sym,
      pair: best.pair.name,
      market: best.pair.sym.includes('OTC') ? 'OTC' : 'FIN',
      dir: best.score.dir,
      conf: best.score.conf,
      votes: best.score.votes,
      pattern: best.score.pattern,
      reasons: best.score.reasons,
      expiry: currentExpiry,
      tf: currentTF,
      entry: entryTimeStr(),
      price: best.price
    }
  });
});

app.listen(PORT, () => console.log(`🌐 API listening on :${PORT}`));

if (CHAT_ID) {
  sendMsg(
    `🟢 <b>SIGNAL PRO Bot запущено!</b>\n\n` +
    `📊 Завантажено <b>${ALL_PAIRS.length}</b> пар\n` +
    `⏱ Exp: <code>${currentExpiry.toUpperCase()}</code>\n\n` +
    `Натисни /start щоб відкрити меню`,
    CHAT_ID,
    { reply_markup: mainKeyboard() }
  ).catch(e => console.error('Startup message error:', e.message));
}

poll();
