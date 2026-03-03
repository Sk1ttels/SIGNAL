const https = require('https');

// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════
const TOKEN      = process.env.BOT_TOKEN   || '8724717803:AAF3ab0NpEKCCdXN6RsetQuAxB8r5SgpUTk';
const CHAT_ID    = process.env.CHAT_ID     || '5554286686';
const TD_KEY     = process.env.TD_KEY      || 'bdc80edc66f04dfa93602228f2a6a88d';
const SCAN_EVERY = 90_000; // 90 секунд між сканами

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
let autoMode      = false;
let scanTimer     = null;
let offset        = 0;
let currentExpiry = '5m';
let currentTF     = '5m';
let sentCount     = 0;
let lastSigTime   = {};
let candleCache   = {};   // sym -> tf -> candles[]
let lastFetch     = {};   // sym+tf -> timestamp

// ═══════════════════════════════════════════════════════
// PAIRS — реальні Forex символи для Twelve Data
// ═══════════════════════════════════════════════════════
const FIN_PAIRS = [
  {sym:'GBP/JPY', name:'GBP/JPY', td:'GBP/JPY'},
  {sym:'EUR/JPY', name:'EUR/JPY', td:'EUR/JPY'},
  {sym:'AUD/CAD', name:'AUD/CAD', td:'AUD/CAD'},
  {sym:'AUD/CHF', name:'AUD/CHF', td:'AUD/CHF'},
  {sym:'AUD/JPY', name:'AUD/JPY', td:'AUD/JPY'},
  {sym:'AUD/USD', name:'AUD/USD', td:'AUD/USD'},
  {sym:'CAD/CHF', name:'CAD/CHF', td:'CAD/CHF'},
  {sym:'CAD/JPY', name:'CAD/JPY', td:'CAD/JPY'},
  {sym:'CHF/JPY', name:'CHF/JPY', td:'CHF/JPY'},
  {sym:'EUR/CAD', name:'EUR/CAD', td:'EUR/CAD'},
  {sym:'EUR/CHF', name:'EUR/CHF', td:'EUR/CHF'},
  {sym:'EUR/USD', name:'EUR/USD', td:'EUR/USD'},
  {sym:'GBP/AUD', name:'GBP/AUD', td:'GBP/AUD'},
  {sym:'GBP/CAD', name:'GBP/CAD', td:'GBP/CAD'},
  {sym:'GBP/CHF', name:'GBP/CHF', td:'GBP/CHF'},
  {sym:'GBP/USD', name:'GBP/USD', td:'GBP/USD'},
  {sym:'USD/CAD', name:'USD/CAD', td:'USD/CAD'},
  {sym:'USD/CHF', name:'USD/CHF', td:'USD/CHF'},
  {sym:'USD/JPY', name:'USD/JPY', td:'USD/JPY'},
  {sym:'EUR/AUD', name:'EUR/AUD', td:'EUR/AUD'},
  {sym:'EUR/GBP', name:'EUR/GBP', td:'EUR/GBP'},
];

// OTC — симуляція на базі реальних FIN цін (OTC не торгується на відкритих біржах)
const OTC_PAIRS = [
  {sym:'GBP/JPY_OTC', name:'GBP/JPY', base:'GBP/JPY', otc:true},
  {sym:'EUR/JPY_OTC', name:'EUR/JPY', base:'EUR/JPY', otc:true},
  {sym:'EUR/USD_OTC', name:'EUR/USD', base:'EUR/USD', otc:true},
  {sym:'GBP/USD_OTC', name:'GBP/USD', base:'GBP/USD', otc:true},
  {sym:'USD/JPY_OTC', name:'USD/JPY', base:'USD/JPY', otc:true},
  {sym:'AUD/USD_OTC', name:'AUD/USD', base:'AUD/USD', otc:true},
  {sym:'USD/CAD_OTC', name:'USD/CAD', base:'USD/CAD', otc:true},
  {sym:'USD/CHF_OTC', name:'USD/CHF', base:'USD/CHF', otc:true},
  {sym:'CAD/JPY_OTC', name:'CAD/JPY', base:'CAD/JPY', otc:true},
  {sym:'CHF/JPY_OTC', name:'CHF/JPY', base:'CHF/JPY', otc:true},
];

// ═══════════════════════════════════════════════════════
// TWELVE DATA — реальні свічки
// ═══════════════════════════════════════════════════════
function tdInterval(tf) {
  return {'1m':'1min','5m':'5min','15m':'15min','1h':'1h','4h':'4h'}[tf] || '5min';
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

async function fetchCandles(tdSym, tf, outputSize = 100) {
  const interval = tdInterval(tf);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSym)}&interval=${interval}&outputsize=${outputSize}&apikey=${TD_KEY}&format=JSON`;
  try {
    const data = await httpsGet(url);
    if (data.status === 'error' || !data.values) {
      console.warn(`[TD] Error for ${tdSym}: ${data.message || 'no values'}`);
      return null;
    }
    // Twelve Data повертає від нових до старих — перевертаємо
    const candles = data.values.reverse().map(v => ({
      o: parseFloat(v.open),
      h: parseFloat(v.high),
      l: parseFloat(v.low),
      c: parseFloat(v.close),
      t: new Date(v.datetime).getTime()
    }));
    return candles;
  } catch (e) {
    console.warn(`[TD] Fetch error ${tdSym}:`, e.message);
    return null;
  }
}

// Кешуємо свічки — не більше 1 запиту на пару кожні 5 хвилин
async function getCandles(pair, tf) {
  const sym = pair.otc ? pair.base : pair.sym;
  const key = sym + tf;
  const now = Date.now();
  const ttl = {'1m':60e3,'5m':300e3,'15m':900e3,'1h':3600e3,'4h':14400e3}[tf] || 300e3;

  if (candleCache[key] && (now - (lastFetch[key]||0)) < ttl) {
    return candleCache[key];
  }

  // Для OTC — беремо базову FIN пару і додаємо мікро-шум
  const tdSym = pair.otc ? pair.base : pair.td || pair.sym;
  console.log(`[TD] Fetching ${tdSym} ${tf}...`);
  const candles = await fetchCandles(tdSym, tf);
  if (!candles || candles.length < 30) return candleCache[key] || null;

  // OTC: додаємо мінімальний шум щоб імітувати OTC спред
  if (pair.otc) {
    const noise = 0.0001;
    candles.forEach(c => {
      const n = (Math.random() - 0.5) * noise;
      c.o += n; c.h += n; c.l += n; c.c += n;
    });
  }

  candleCache[key] = candles;
  lastFetch[key] = now;
  return candles;
}

// ═══════════════════════════════════════════════════════
// ТЕХНІЧНІ ІНДИКАТОРИ
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
    crossUp:   valid[n-1] < sig[n-1] && valid[n] >= sig[n],
    crossDown: valid[n-1] > sig[n-1] && valid[n] <= sig[n]
  };
}

function calcBB(data, period = 20, mult = 2) {
  if (data.length < period) return { valid: false };
  const n = data.length - 1;
  const sl = data.slice(n - period + 1, n + 1);
  const m = sl.reduce((a, b) => a + b) / period;
  const std = Math.sqrt(sl.map(x => (x - m) ** 2).reduce((a, b) => a + b) / period);
  const lastU = m + mult * std, lastL = m - mult * std;
  return { lastU, lastL, lastM: m, valid: lastU > lastL && std > 0 };
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
  const data = arr.slice(-120);
  const pDM = [], mDM = [], tr = [];
  for (let i = 1; i < data.length; i++) {
    const up = data[i].h - data[i-1].h, dn = data[i-1].l - data[i].l;
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(data[i].h-data[i].l, Math.abs(data[i].h-data[i-1].c), Math.abs(data[i].l-data[i-1].c)));
  }
  const ws = (arr, p) => {
    if (arr.length < p) return [];
    let v = arr.slice(0, p).reduce((a, b) => a + b);
    const r = [v];
    for (let i = p; i < arr.length; i++) { v = v - v/p + arr[i]; r.push(v); }
    return r;
  };
  const sTR = ws(tr, period), sPDM = ws(pDM, period), sMDM = ws(mDM, period);
  if (!sTR.length) return { adx: 0, pdi: 0, mdi: 0 };
  const pdi = sPDM.map((v, i) => sTR[i] > 0 ? Math.min(v/sTR[i]*100, 100) : 0);
  const mdi = sMDM.map((v, i) => sTR[i] > 0 ? Math.min(v/sTR[i]*100, 100) : 0);
  const dx  = pdi.map((v, i) => (v+mdi[i]) > 0 ? Math.abs(v-mdi[i])/(v+mdi[i])*100 : 0);
  const adxArr = ws(dx, period);
  const n = adxArr.length - 1;
  return { adx: Math.min(adxArr[n]/period, 100), pdi: pdi.at(-1), mdi: mdi.at(-1) };
}

// ═══════════════════════════════════════════════════════
// СВІЧКОВІ ПАТЕРНИ
// ═══════════════════════════════════════════════════════
function candlePattern(arr, dir) {
  if (arr.length < 4) return { ok: false, name: '' };
  const c = arr.at(-1), p1 = arr.at(-2), p2 = arr.at(-3);
  const body = x => Math.abs(x.c - x.o);
  const bull = x => x.c > x.o, bear = x => x.c < x.o;
  const atr10 = arr.slice(-10).reduce((s, x) => s + (x.h - x.l), 0) / 10;

  if (dir === 'BUY') {
    if (bear(p1) && bull(c) && c.c > p1.o && c.o < p1.c && body(c) > body(p1) * 0.85)
      return { ok: true, name: 'Бичаче поглинання' };
    const lw = Math.min(c.o,c.c)-c.l, uw = c.h-Math.max(c.o,c.c);
    if (lw > body(c)*2 && uw < body(c)*0.6 && lw > atr10*0.3)
      return { ok: true, name: 'Молот 🔨' };
    if (bull(c) && bull(p1) && bull(p2) && c.c > p1.c && p1.c > p2.c)
      return { ok: true, name: 'Три бики ✅' };
    if (lw > body(c)*3 && c.c > (c.h+c.l)/2)
      return { ok: true, name: 'Пін-бар (підтримка)' };
    if (bull(c) && body(c) > atr10*0.55)
      return { ok: true, name: 'Сильна бичача свічка' };
  }
  if (dir === 'SELL') {
    if (bull(p1) && bear(c) && c.c < p1.o && c.o > p1.c && body(c) > body(p1) * 0.85)
      return { ok: true, name: 'Ведмеже поглинання' };
    const uw2 = c.h-Math.max(c.o,c.c), lw2 = Math.min(c.o,c.c)-c.l;
    if (uw2 > body(c)*2 && lw2 < body(c)*0.6 && uw2 > atr10*0.3)
      return { ok: true, name: 'Зірка падіння 💫' };
    if (bear(c) && bear(p1) && bear(p2) && c.c < p1.c && p1.c < p2.c)
      return { ok: true, name: 'Три ведмеді ✅' };
    if (uw2 > body(c)*3 && c.c < (c.h+c.l)/2)
      return { ok: true, name: 'Пін-бар (спротив)' };
    if (bear(c) && body(c) > atr10*0.55)
      return { ok: true, name: 'Сильна ведмежа свічка' };
  }
  return { ok: false, name: '' };
}

// ═══════════════════════════════════════════════════════
// СИГНАЛЬНИЙ ДВИЖОК — реальні дані
// ═══════════════════════════════════════════════════════
async function getScore(pair, tf) {
  const arr = await getCandles(pair, tf);
  if (!arr || arr.length < 50) return null;

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
  const last   = closes.at(-1);
  const prev   = closes.at(-2);

  let bV = 0, sV = 0;
  const bR = [], sR = [];

  // 1. RSI
  if (rsi !== null) {
    if (rsi <= 32)      { bV++; bR.push(`RSI ${rsi.toFixed(1)} — перепродано`); }
    else if (rsi >= 68) { sV++; sR.push(`RSI ${rsi.toFixed(1)} — перекуплено`); }
  }
  // 2. MACD
  if (macd.crossUp)   { bV++; bR.push('MACD ↑ перетин сигнальної'); }
  if (macd.crossDown) { sV++; sR.push('MACD ↓ перетин сигнальної'); }
  if (!macd.crossUp   && macd.hist > 0 && macd.macd !== null && macd.macd < 0) { bV++; bR.push('MACD: імпульс вгору від нуля'); }
  if (!macd.crossDown && macd.hist < 0 && macd.macd !== null && macd.macd > 0) { sV++; sR.push('MACD: імпульс вниз від нуля'); }

  // 3. Bollinger Bands
  if (bb.valid) {
    const range = bb.lastU - bb.lastL;
    const pos  = Math.max(0, Math.min(1, (last - bb.lastL) / range));
    const pp   = Math.max(0, Math.min(1, (prev - bb.lastL) / range));
    if (pos <= 0.12 && pos >= pp - 0.03) { bV++; bR.push(`BB нижня зона (${(pos*100).toFixed(0)}%)`); }
    if (pos >= 0.88 && pos <= pp + 0.03) { sV++; sR.push(`BB верхня зона (${(pos*100).toFixed(0)}%)`); }
  }

  // 4. EMA
  if (e9 && e21 && e50) {
    if (e9 > e21 && last > e50) { bV++; bR.push('EMA: 9>21, ціна вище EMA50'); }
    if (e9 < e21 && last < e50) { sV++; sR.push('EMA: 9<21, ціна нижче EMA50'); }
  }

  // 5. Stoch RSI
  if (stoch.k <= 22)      { bV++; bR.push(`Stoch RSI ${stoch.k.toFixed(0)} — зона покупок`); }
  else if (stoch.k >= 78) { sV++; sR.push(`Stoch RSI ${stoch.k.toFixed(0)} — зона продаж`); }

  const maxV = Math.max(bV, sV);
  if (maxV < 3) return null;
  const dir = bV >= 3 ? 'BUY' : 'SELL';
  const reasons = dir === 'BUY' ? [...bR] : [...sR];

  // Фільтр: 3 голоси — потрібен MACD
  if (maxV === 3 && !reasons.some(r => r.includes('MACD'))) return null;

  // ADX фільтр
  if (adx.adx < 15) return null;
  if (dir === 'BUY'  && adx.pdi < adx.mdi - 5) return null;
  if (dir === 'SELL' && adx.mdi < adx.pdi - 5) return null;

  // ATR фільтр
  if (!atr) return null;
  const atrPct = atr / last * 100;
  if (atrPct < 0.005 || atrPct > 5) return null;

  // Свічковий патерн
  const pat = candlePattern(arr, dir);
  if (!pat.ok) return null;
  reasons.push(`📊 ${pat.name}`);

  // Впевненість
  let conf = maxV === 5 ? 89 : maxV === 4 ? 84 : 78;
  if (adx.adx > 28) conf += 4;
  if (atrPct > 0.01 && atrPct < 1.5) conf += 3;
  const opp = dir === 'BUY' ? sV : bV;
  if (opp === 0) conf += 4;
  conf = Math.min(conf, 97);

  return {
    dir, conf, reasons,
    pattern: pat.name,
    votes: maxV,
    price: last,
    rsi: rsi?.toFixed(1),
    adx: adx.adx.toFixed(0)
  };
}

// ═══════════════════════════════════════════════════════
// СКАН ПАРИ
// ═══════════════════════════════════════════════════════
async function scanPairs(pairs, tf) {
  let best = null, bestConf = 0;
  // Обмежуємо до 8 пар за раз щоб не перевищити API ліміт
  const toScan = pairs.slice(0, 8);
  for (const p of toScan) {
    const key = p.sym + tf;
    const now = Date.now();
    const cooldownMs = {'1m':4*60e3,'5m':20*60e3,'15m':60*60e3,'1h':4*3600e3}[tf] || 20*60e3;
    if ((now - (lastSigTime[key]||0)) < cooldownMs) continue;
    try {
      const score = await getScore(p, tf);
      if (!score) continue;
      if (score.conf > bestConf) {
        bestConf = score.conf;
        best = { pair: p, score, price: score.price };
      }
    } catch(e) {
      console.warn(`[SCAN] Error ${p.sym}:`, e.message);
    }
    // Пауза між запитами щоб не флудити API
    await new Promise(r => setTimeout(r, 500));
  }
  return best;
}

// ═══════════════════════════════════════════════════════
// ФОРМАТУВАННЯ ЧАСУ
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
  const mins = {'1m':1,'5m':5,'10m':10,'15m':15,'30m':30,'1h':60}[currentExpiry] || 5;
  return [addMins(n, mins+1), addMins(n, mins*2+1)];
}

function fmtPrice(price, sym) {
  if (!price) return '—';
  if (sym.includes('JPY')) return price.toFixed(3);
  return price.toFixed(5);
}

// ═══════════════════════════════════════════════════════
// TELEGRAM ПОВІДОМЛЕННЯ
// ═══════════════════════════════════════════════════════
function buildMsg(pair, score) {
  const isBuy   = score.dir === 'BUY';
  const entry   = entryTimeStr();
  const [re1, re2] = reentryTimes();
  const isOTC   = pair.otc ? '🔄 OTC' : '📈 FIN';
  const arrow   = isBuy ? '🚀' : '📉';
  const circle  = isBuy ? '🟢' : '🔴';
  const dirText = isBuy ? '▲ КУПИТИ' : '▼ ПРОДАТИ';
  const filled  = Math.round(score.conf / 10);
  const bar     = '█'.repeat(filled) + '░'.repeat(10 - filled);

  return `${arrow} *${score.dir}* · ${isOTC}
━━━━━━━━━━━━━━━━━━
🏦 *${pair.name}*
⏱ Експірація: *${currentExpiry.toUpperCase()}*
🎯 Точка входу: *${entry}*
${circle} *${dirText}*

▲ *Додатковий вхід:*
1️⃣ Рівень о ${re1}
2️⃣ Рівень о ${re2}
━━━━━━━━━━━━━━━━━━
⚡ Впевненість: *${score.conf}%*
${bar}
✅ Підтверджень: *${score.votes}/5*
💰 Ціна: \`${fmtPrice(score.price, pair.sym)}\`
📊 Патерн: _${score.pattern}_
📈 RSI: ${score.rsi} | ADX: ${score.adx}

_Підстави:_
${score.reasons.map(r => `• ${r}`).join('\n')}`;
}

// ═══════════════════════════════════════════════════════
// TELEGRAM API
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
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function sendMsg(text, chatId = CHAT_ID) {
  try {
    await tgRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
  } catch(e) { console.error('[TG] Send error:', e.message); }
}

async function getUpdates() {
  try {
    const res = await tgRequest('getUpdates', { offset, timeout: 25, limit: 10 });
    return res.result || [];
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════
// КОМАНДИ
// ═══════════════════════════════════════════════════════
const HELP = `
🤖 *SIGNAL PRO — Команди:*

/auto — увімкнути\\вимкнути авторежим
/signal — 📡 кращий FIN сигнал зараз
/otc — 🔄 кращий OTC сигнал зараз
/setexpiry 5m — ⏱ змінити експірацію
/settf 5m — 🕐 змінити таймфрейм
/status — ℹ️ статус бота
/stop — зупинити авторежим
`;

async function handleCommand(msg) {
  const text   = (msg.text || '').trim();
  const chatId = msg.chat.id.toString();
  const cmd    = text.split(' ')[0].toLowerCase();
  console.log(`[CMD] ${chatId}: ${text}`);

  if (cmd === '/start' || cmd === '/help') {
    await sendMsg(`🟢 *SIGNAL PRO Bot активний!*\n\n📡 Реальні дані: *Twelve Data*\n📊 Пар: ${FIN_PAIRS.length} FIN + ${OTC_PAIRS.length} OTC\n${HELP}`, chatId);

  } else if (cmd === '/auto') {
    autoMode = !autoMode;
    if (autoMode) {
      await sendMsg('🤖 *АВТОРЕЖИМ УВІМКНЕНО*\n\nСканую реальний ринок. Сигнали надходитимуть автоматично.\n\n/stop — зупинити', chatId);
      startAutoScan(chatId);
    } else {
      stopAutoScan();
      await sendMsg('⏹ Авторежим вимкнено.', chatId);
    }

  } else if (cmd === '/stop') {
    autoMode = false; stopAutoScan();
    await sendMsg('⏹ *Авторежим зупинено.*', chatId);

  } else if (cmd === '/signal' || cmd === '/fin') {
    await sendMsg('🔍 Сканую FIN ринок (реальні дані)...', chatId);
    const best = await scanPairs(FIN_PAIRS, currentTF);
    if (best) {
      lastSigTime[best.pair.sym + currentTF] = Date.now();
      sentCount++;
      await sendMsg(buildMsg(best.pair, best.score), chatId);
    } else {
      await sendMsg('⊘ *Немає чітких сигналів зараз.*\n\nРинок у флеті або недостатньо підтверджень.\nСпробуйте /settf 15m або пізніше.', chatId);
    }

  } else if (cmd === '/otc') {
    await sendMsg('🔍 Сканую OTC пари...', chatId);
    const best = await scanPairs(OTC_PAIRS, currentTF);
    if (best) {
      lastSigTime[best.pair.sym + currentTF] = Date.now();
      sentCount++;
      await sendMsg(buildMsg(best.pair, best.score), chatId);
    } else {
      await sendMsg('⊘ *Немає OTC сигналів зараз.*', chatId);
    }

  } else if (cmd === '/setexpiry') {
    const val = text.split(' ')[1];
    if (['1m','5m','10m','15m','30m','1h'].includes(val)) {
      currentExpiry = val;
      await sendMsg(`✅ Експірація: *${val.toUpperCase()}*`, chatId);
    } else {
      await sendMsg('Приклад: `/setexpiry 5m`\nДоступно: 1m, 5m, 10m, 15m, 30m, 1h', chatId);
    }

  } else if (cmd === '/settf') {
    const val = text.split(' ')[1];
    if (['1m','5m','15m','1h','4h'].includes(val)) {
      currentTF = val;
      // Очищаємо кеш при зміні TF
      candleCache = {};
      await sendMsg(`✅ Таймфрейм: *${val.toUpperCase()}*`, chatId);
    } else {
      await sendMsg('Приклад: `/settf 15m`\nДоступно: 1m, 5m, 15m, 1h, 4h', chatId);
    }

  } else if (cmd === '/status') {
    const cacheSize = Object.keys(candleCache).length;
    await sendMsg(
      `ℹ️ *SIGNAL PRO статус:*\n\n` +
      `🤖 Авторежим: ${autoMode ? '✅ активний' : '❌ вимкнено'}\n` +
      `📡 Джерело: Twelve Data (реальний ринок)\n` +
      `⏱ Експірація: *${currentExpiry.toUpperCase()}*\n` +
      `🕐 Таймфрейм: *${currentTF.toUpperCase()}*\n` +
      `📨 Надіслано сигналів: ${sentCount}\n` +
      `💾 Кеш свічок: ${cacheSize} пар\n` +
      `⏰ Uptime: ${Math.round(process.uptime()/60)} хв`,
      chatId
    );

  } else {
    await sendMsg('Невідома команда. /help', chatId);
  }
}

// ═══════════════════════════════════════════════════════
// АВТОРЕЖИМ
// ═══════════════════════════════════════════════════════
let autoScanChat = CHAT_ID;

function startAutoScan(chatId) {
  autoScanChat = chatId || CHAT_ID;
  clearInterval(scanTimer);
  scanTimer = setInterval(async () => {
    if (!autoMode) { clearInterval(scanTimer); return; }
    console.log('[AUTO] Scanning...');
    // Чергуємо FIN і OTC
    const allPairs = [...FIN_PAIRS, ...OTC_PAIRS];
    const best = await scanPairs(allPairs, currentTF);
    if (best) {
      lastSigTime[best.pair.sym + currentTF] = Date.now();
      sentCount++;
      console.log(`[SIGNAL] ${best.score.dir} ${best.pair.name} ${best.score.conf}%`);
      await sendMsg(buildMsg(best.pair, best.score), autoScanChat);
    } else {
      console.log('[AUTO] No signals this round');
    }
  }, SCAN_EVERY);
}

function stopAutoScan() {
  clearInterval(scanTimer);
  scanTimer = null;
}

// ═══════════════════════════════════════════════════════
// POLLING
// ═══════════════════════════════════════════════════════
async function poll() {
  const updates = await getUpdates();
  for (const upd of updates) {
    offset = upd.update_id + 1;
    if (upd.message?.text) await handleCommand(upd.message);
  }
  setTimeout(poll, 800);
}

// ═══════════════════════════════════════════════════════
// СТАРТ
// ═══════════════════════════════════════════════════════
console.log('🚀 SIGNAL PRO Bot starting (Twelve Data LIVE)...');
sendMsg(
  `🟢 *SIGNAL PRO Bot запущено!*\n\n` +
  `📡 Джерело котировок: *Twelve Data* (реальний ринок)\n` +
  `📊 FIN пар: ${FIN_PAIRS.length} | OTC пар: ${OTC_PAIRS.length}\n` +
  `⏱ Експірація: ${currentExpiry.toUpperCase()} | TF: ${currentTF.toUpperCase()}\n\n` +
  `Команди: /help\nАвтосигнали: /auto`
).then(() => { console.log('✅ Ready'); poll(); })
 .catch(e  => { console.error('❌', e.message); poll(); });
