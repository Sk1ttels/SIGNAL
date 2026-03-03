// bot.js — PREMIUM SIGNAL BOT (single file, server-ready, no dotenv)
// ENV required: BOT_TOKEN
// Optional ENV: CHAT_ID, PORT
// deps: node-telegram-bot-api, express

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

// ============================
// 1) ENV / CONFIG
// ============================
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Missing BOT_TOKEN env var");
  process.exit(1);
}

const DEFAULT_CHAT_ID = process.env.CHAT_ID ? String(process.env.CHAT_ID) : null;
const PORT = Number(process.env.PORT || 3000);

// Auto scan interval
const SCAN_INTERVAL_MS = 60_000;

// Pairs (replace with yours)
const PAIRS = {
  FIN: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"],
  OTC: ["AUDJPY_OTC", "EURUSD_OTC", "GBPUSD_OTC", "USDJPY_OTC"],
};

// Options
const TF_OPTIONS = ["1m", "5m", "15m", "1h", "4h"];
const EXP_OPTIONS = ["1m", "5m", "15m", "30m", "1h"];

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
app.use(express.json());

// ============================
// 2) STATE
// ============================
const state = new Map(); // chatId -> settings

function getState(chatId) {
  if (!state.has(chatId)) {
    state.set(chatId, {
      market: "OTC",
      tf: "5m",
      expiry: "5m",
      auto: false,
      lastSignalAt: 0,
      entryMode: "AUTO", // AUTO | PERCENT | ATR | LEVELS
      digits: 3, // price decimals
    });
  }
  return state.get(chatId);
}

// ============================
// 3) UI HELPERS
// ============================
function bar(pct) {
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function fmtPrice(x, digits = 3) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return "-";
  return Number(x).toFixed(digits);
}

function pctDelta(from, to) {
  if (!from || !to) return 0;
  return ((to - from) / from) * 100;
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function mainMenuKeyboard(chatId) {
  const st = getState(chatId);
  return {
    inline_keyboard: [
      [
        { text: "🔥 Best", callback_data: "menu:best" },
        { text: "📈 FIN", callback_data: "menu:fin" },
        { text: "🌙 OTC", callback_data: "menu:otc" },
      ],
      [
        { text: st.auto ? "🛑 Auto ON" : "🤖 Auto OFF", callback_data: "menu:auto" },
        { text: "⚙️ Settings", callback_data: "menu:settings" },
        { text: "📊 Status", callback_data: "menu:status" },
      ],
      [{ text: "🧾 Pairs", callback_data: "menu:pairs" }],
    ],
  };
}

function settingsKeyboard(chatId) {
  const st = getState(chatId);

  const tfRow = TF_OPTIONS.map((v) => ({
    text: (st.tf === v ? "✅ " : "") + `TF ${v}`,
    callback_data: `set:tf:${v}`,
  }));

  const expRow = EXP_OPTIONS.map((v) => ({
    text: (st.expiry === v ? "✅ " : "") + `EXP ${v}`,
    callback_data: `set:exp:${v}`,
  }));

  const modeRow = ["AUTO", "PERCENT", "ATR", "LEVELS"].map((m) => ({
    text: (st.entryMode === m ? "✅ " : "") + `ENT ${m}`,
    callback_data: `set:mode:${m}`,
  }));

  return {
    inline_keyboard: [
      tfRow.slice(0, 5),
      expRow.slice(0, 5),
      [
        { text: st.market === "FIN" ? "✅ FIN" : "FIN", callback_data: "set:market:FIN" },
        { text: st.market === "OTC" ? "✅ OTC" : "OTC", callback_data: "set:market:OTC" },
      ],
      modeRow.slice(0, 4),
      [{ text: "⬅️ Back", callback_data: "menu:home" }],
    ],
  };
}

// ============================
// 4) ENTRY CALC (PERCENT / ATR / LEVELS)
// ============================
function entriesByPercent(entry, side, stepsPct = [0.03, 0.06], digits = 3) {
  const dir = side === "SELL" ? 1 : -1;
  return stepsPct.map((p) => Number((entry * (1 + dir * (p / 100))).toFixed(digits)));
}

function entriesByATR(entry, side, atr, mults = [0.35, 0.7], digits = 3) {
  const dir = side === "SELL" ? 1 : -1;
  const safeAtr = atr && atr > 0 ? atr : entry * 0.0006; // fallback if atr missing
  return mults.map((m) => Number((entry + dir * safeAtr * m).toFixed(digits)));
}

function entriesByLevels(entry, side, levels) {
  const R = (levels?.R || []).slice().sort((a, b) => a - b);
  const S = (levels?.S || []).slice().sort((a, b) => a - b);

  if (side === "SELL") {
    return R.filter((x) => x > entry).slice(0, 2);
  } else {
    const below = S.filter((x) => x < entry);
    return below.slice(-2).reverse();
  }
}

function calcSLTP(entry, side, atr = null, levels = null) {
  const slPad = atr ? atr * 0.6 : entry * 0.0015; // ~0.15%
  const tpPad = atr ? atr * 0.8 : entry * 0.0024; // ~0.24%

  let sl = side === "SELL" ? entry + slPad : entry - slPad;
  let tp = side === "SELL" ? entry - tpPad : entry + tpPad;

  if (levels) {
    const R = (levels.R || []).slice().sort((a, b) => a - b);
    const S = (levels.S || []).slice().sort((a, b) => a - b);

    if (side === "SELL") {
      const nextR = R.find((x) => x > entry);
      if (nextR) sl = Math.max(sl, nextR);
      const nearS = S.filter((x) => x < entry).slice(-1)[0];
      if (nearS) tp = Math.min(tp, nearS);
    } else {
      const prevS = S.filter((x) => x < entry).slice(-1)[0];
      if (prevS) sl = Math.min(sl, prevS);
      const nextR = R.find((x) => x > entry);
      if (nextR) tp = Math.max(tp, nextR);
    }
  }

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk > 0 ? `1 : ${(reward / risk).toFixed(2)}` : "-";

  return { sl, tp, rr };
}

// ============================
// 5) PREMIUM MESSAGE
// ============================
function formatPremiumSignal(s, digits = 3) {
  const sideEmoji = s.side === "SELL" ? "📉" : "📈";
  const actionEmoji = s.side === "SELL" ? "🔴" : "🟢";
  const actionText = s.side === "SELL" ? "ПРОДАТИ" : "КУПИТИ";

  const addsLines = (s.adds || [])
    .map((p, i) => {
      const d = pctDelta(s.entry, p);
      const sign = d >= 0 ? "+" : "";
      const n = ["①", "②", "③"][i] || "•";
      return `${n} ${fmtPrice(p, digits)}  (${sign}${d.toFixed(3)}%)`;
    })
    .join("\n");

  const indLines = (s.indicators || []).map((x) => `• ${x}`).join("\n");

  const sLevels = (s.levels?.S || []).map((v) => fmtPrice(v, digits)).join(" / ");
  const rLevels = (s.levels?.R || []).map((v) => fmtPrice(v, digits)).join(" / ");

  const marketLabel = s.market === "OTC" ? "🌙 OTC" : "📈 FIN";

  return (
    `${sideEmoji} ${s.side} | ${marketLabel}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💱 Пара: ${s.pair}\n` +
    `⏱ TF: ${s.tf}   ⌛ EXP: ${s.expiry}\n` +
    `🕒 Час: ${s.timeStr}\n\n` +
    `🎯 ОСНОВНИЙ ВХІД:\n` +
    `➡️ ${fmtPrice(s.entry, digits)}\n\n` +
    (addsLines ? `📍 ДОДАТКОВІ ВХОДИ:\n${addsLines}\n\n` : "") +
    `🛡 Орієнтири ризику:\n` +
    `🟥 SL (invalidate): ${s.sl != null ? fmtPrice(s.sl, digits) : "-"}\n` +
    `🟩 TP (target):     ${s.tp != null ? fmtPrice(s.tp, digits) : "-"}\n` +
    `⚖️ R/R: ${s.rr || "-"}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⚡ Впевненість: ${s.confidence}%  ${bar(s.confidence)}\n` +
    `✅ Підтверджень: ${s.confirms}/5\n\n` +
    `📊 Індикатори:\n` +
    `${indLines || "• -"}\n` +
    (s.pattern ? `\n📌 Патерн: ${s.pattern}\n` : "\n") +
    ((sLevels || rLevels)
      ? `\n📌 Рівні:\n• S: ${sLevels || "-"}\n• R: ${rLevels || "-"}\n`
      : "") +
    `\n${actionEmoji} ДІЯ: ${actionText}`
  );
}

// ============================
// 6) DATA SOURCE (stub) — replace with your real site data
// ============================
function buildSignal(chatId, override = {}) {
  const st = getState(chatId);

  // Choose pair
  const market = override.market || st.market;
  const pairList = PAIRS[market] || [];
  const pair = override.pair || randomChoice(pairList.length ? pairList : ["AUDJPY_OTC"]);

  // Side
  const side = override.side || (Math.random() > 0.5 ? "SELL" : "BUY");

  // PRICE: тут має бути твоя точна ціна з котировок
  // Поки — заглушка:
  const entry = override.entry ?? Number((110 + Math.random()).toFixed(st.digits));

  // ATR / Levels / Indicators — підставиш свої з сайту
  const atr = override.atr ?? 0.06; // заглушка
  const levels =
    override.levels ??
    (side === "SELL"
      ? { S: [entry - 0.105, entry - 0.145], R: [entry + 0.065, entry + 0.155] }
      : { S: [entry - 0.155, entry - 0.065], R: [entry + 0.145, entry + 0.105] });

  const indicators =
    override.indicators ??
    [
      "MACD ↓ перетин сигнальної",
      "EMA 9 < EMA 21, ціна нижче EMA50",
      "Stoch RSI — зона продажу",
      "RSI/ADX підтверджують імпульс",
    ];

  const pattern = override.pattern ?? (side === "SELL" ? "Зірка падіння ⭐" : "Молот 🔨");

  const confidence = override.confidence ?? Math.floor(80 + Math.random() * 15); // 80-95
  const confirms = override.confirms ?? Math.min(5, Math.max(2, Math.round(confidence / 22))); // 2-5

  // ENTRY MODE
  let adds = [];
  const mode = override.entryMode || st.entryMode;

  if (mode === "LEVELS") adds = entriesByLevels(entry, side, levels) || [];
  if (mode === "ATR") adds = entriesByATR(entry, side, atr, [0.35, 0.7], st.digits);
  if (mode === "PERCENT") adds = entriesByPercent(entry, side, [0.03, 0.06], st.digits);

  if (mode === "AUTO") {
    // priority: levels -> atr -> percent
    adds = entriesByLevels(entry, side, levels) || [];
    if (!adds.length) adds = entriesByATR(entry, side, atr, [0.35, 0.7], st.digits);
    if (!adds.length) adds = entriesByPercent(entry, side, [0.03, 0.06], st.digits);
  }

  const { sl, tp, rr } = calcSLTP(entry, side, atr, levels);

  return {
    side,
    market,
    pair,
    tf: override.tf || st.tf,
    expiry: override.expiry || st.expiry,
    timeStr: new Date().toLocaleString("uk-UA"),
    entry,
    adds,
    sl,
    tp,
    rr,
    confidence,
    confirms,
    indicators,
    pattern,
    levels,
  };
}

// ============================
// 7) COMMANDS
// ============================
bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  getState(chatId);

  await bot.sendMessage(
    chatId,
    "👋 Привіт! Це Signal Bot.\n\nВибери дію в меню 👇",
    { reply_markup: mainMenuKeyboard(chatId) }
  );
});

bot.onText(/\/stop/, async (msg) => {
  const chatId = String(msg.chat.id);
  const st = getState(chatId);
  st.auto = false;
  await bot.sendMessage(chatId, "🛑 Auto режим вимкнено.", { reply_markup: mainMenuKeyboard(chatId) });
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const input = (match?.[1] || "").trim();
  if (!input) return;

  const st = getState(chatId);
  const market = input.includes("_OTC") ? "OTC" : st.market;

  const sig = buildSignal(chatId, { pair: input, market });
  const text = formatPremiumSignal(sig, st.digits);

  await bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔁 Next", callback_data: "menu:best" },
          { text: "⚙️ Settings", callback_data: "menu:settings" },
        ],
        [{ text: "⬅️ Menu", callback_data: "menu:home" }],
      ],
    },
  });
});

// ============================
// 8) BUTTONS
// ============================
bot.on("callback_query", async (q) => {
  const chatId = String(q.message.chat.id);
  const data = String(q.data || "");
  const st = getState(chatId);

  try {
    // Home
    if (data === "menu:home") {
      await bot.editMessageText("🏠 Меню", {
        chat_id: chatId,
        message_id: q.message.message_id,
        reply_markup: mainMenuKeyboard(chatId),
      });
      return bot.answerCallbackQuery(q.id);
    }

    // Market
    if (data === "menu:fin") {
      st.market = "FIN";
      return bot.answerCallbackQuery(q.id, { text: "Market: FIN" });
    }
    if (data === "menu:otc") {
      st.market = "OTC";
      return bot.answerCallbackQuery(q.id, { text: "Market: OTC" });
    }

    // Settings
    if (data === "menu:settings") {
      await bot.editMessageText("⚙️ Settings\nОбери параметри:", {
        chat_id: chatId,
        message_id: q.message.message_id,
        reply_markup: settingsKeyboard(chatId),
      });
      return bot.answerCallbackQuery(q.id);
    }

    // Status
    if (data === "menu:status") {
      const text =
        `📊 Status\n` +
        `• Market: ${st.market}\n` +
        `• TF: ${st.tf}\n` +
        `• EXP: ${st.expiry}\n` +
        `• Entry Mode: ${st.entryMode}\n` +
        `• Auto: ${st.auto ? "ON" : "OFF"}`;
      await bot.sendMessage(chatId, text, { reply_markup: mainMenuKeyboard(chatId) });
      return bot.answerCallbackQuery(q.id);
    }

    // Pairs
    if (data === "menu:pairs") {
      const fin = (PAIRS.FIN || []).join(", ");
      const otc = (PAIRS.OTC || []).join(", ");
      const text =
        `🧾 Pairs\n\n` +
        `📈 FIN:\n${fin || "-"}\n\n` +
        `🌙 OTC:\n${otc || "-"}\n\n` +
        `👉 Запит: /pair EURUSD або /pair AUDJPY_OTC`;
      await bot.sendMessage(chatId, text, { reply_markup: mainMenuKeyboard(chatId) });
      return bot.answerCallbackQuery(q.id);
    }

    // Auto toggle
    if (data === "menu:auto") {
      st.auto = !st.auto;
      await bot.sendMessage(chatId, st.auto ? "🤖 Auto увімкнено." : "🛑 Auto вимкнено.", {
        reply_markup: mainMenuKeyboard(chatId),
      });
      return bot.answerCallbackQuery(q.id);
    }

    // Best signal
    if (data === "menu:best") {
      const sig = buildSignal(chatId);
      const text = formatPremiumSignal(sig, st.digits);
      await bot.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔁 Next", callback_data: "menu:best" },
              { text: st.auto ? "🛑 Auto" : "🤖 Auto", callback_data: "menu:auto" },
            ],
            [{ text: "⚙️ Settings", callback_data: "menu:settings" }],
          ],
        },
      });
      return bot.answerCallbackQuery(q.id);
    }

    // Setters
    if (data.startsWith("set:")) {
      const [, key, value] = data.split(":");

      if (key === "tf" && TF_OPTIONS.includes(value)) st.tf = value;
      if (key === "exp" && EXP_OPTIONS.includes(value)) st.expiry = value;
      if (key === "market" && (value === "FIN" || value === "OTC")) st.market = value;
      if (key === "mode" && ["AUTO", "PERCENT", "ATR", "LEVELS"].includes(value)) st.entryMode = value;

      await bot.answerCallbackQuery(q.id, { text: "✅ Saved" });

      await bot.editMessageText("⚙️ Settings\nОбери параметри:", {
        chat_id: chatId,
        message_id: q.message.message_id,
        reply_markup: settingsKeyboard(chatId),
      });
      return;
    }

    return bot.answerCallbackQuery(q.id);
  } catch (e) {
    console.error("callback error:", e);
    try {
      await bot.answerCallbackQuery(q.id, { text: "Error 😕" });
    } catch {}
  }
});

// ============================
// 9) AUTO LOOP
// ============================
setInterval(async () => {
  for (const [chatId, st] of state.entries()) {
    if (!st.auto) continue;

    const now = Date.now();
    if (now - st.lastSignalAt < SCAN_INTERVAL_MS - 500) continue;
    st.lastSignalAt = now;

    const sig = buildSignal(chatId);
    const text = formatPremiumSignal(sig, st.digits);

    try {
      await bot.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔁 Next", callback_data: "menu:best" },
              { text: "🛑 Auto", callback_data: "menu:auto" },
            ],
            [{ text: "⚙️ Settings", callback_data: "menu:settings" }],
          ],
        },
      });
    } catch (e) {
      console.error("auto send error:", e.message);
    }
  }
}, SCAN_INTERVAL_MS);

// ============================
// 10) HTTP API (optional for your site)
// ============================
app.get("/api/status", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get("/api/best", (req, res) => {
  const market = String(req.query.market || "OTC").toUpperCase();
  const tf = String(req.query.tf || "5m");
  const expiry = String(req.query.expiry || "5m");
  const side = String(req.query.side || "").toUpperCase();

  const fakeChat = "api";
  const st = getState(fakeChat);
  st.market = market === "FIN" ? "FIN" : "OTC";
  st.tf = TF_OPTIONS.includes(tf) ? tf : "5m";
  st.expiry = EXP_OPTIONS.includes(expiry) ? expiry : "5m";

  const sig = buildSignal(fakeChat, {
    market: st.market,
    tf: st.tf,
    expiry: st.expiry,
    side: side === "SELL" || side === "BUY" ? side : undefined,
  });

  res.json({ ok: true, signal: sig });
});

app.listen(PORT, async () => {
  console.log(`✅ HTTP API running on :${PORT}`);
  console.log("✅ Bot polling started");

  if (DEFAULT_CHAT_ID) {
    try {
      await bot.sendMessage(DEFAULT_CHAT_ID, "✅ Bot запущено.", {
        reply_markup: mainMenuKeyboard(DEFAULT_CHAT_ID),
      });
    } catch (e) {
      console.log("startup msg skipped:", e.message);
    }
  }
});
