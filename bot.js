/**
 * Telegram Signals Bot (single file)
 * - Safe: no hardcoded token required (uses ENV)
 * - Nice UI: structured messages + inline buttons
 * - Works even if you later plug real quotes/signals source
 *
 * ENV:
 *   BOT_TOKEN=...
 *   CHAT_ID=... (optional)
 *   PORT=3000 (optional)
 */

require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

// ============================
// 1) CONFIG (edit only this)
// ============================

// ✅ MUST: put token in .env (BOT_TOKEN=xxxx)
const TOKEN = process.env.BOT_TOKEN;

// optional default chat for startup message
const DEFAULT_CHAT_ID = process.env.CHAT_ID ? String(process.env.CHAT_ID) : null;

const PORT = Number(process.env.PORT || 3000);

// scan interval (ms) for auto mode (you can change)
const SCAN_INTERVAL_MS = 60_000;

// Markets & pairs (replace with your data)
const PAIRS = {
  FIN: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"],
  OTC: ["EURUSD_OTC", "GBPUSD_OTC", "USDJPY_OTC"],
};

// Allowed TF/Expiry
const TF_OPTIONS = ["1m", "5m", "15m", "1h", "4h"];
const EXP_OPTIONS = ["1m", "5m", "15m", "30m", "1h"];

// =====================================
// 2) BASIC CHECKS (don’t touch)
// =====================================
if (!TOKEN) {
  console.error("❌ BOT_TOKEN is missing. Put it into .env as BOT_TOKEN=...");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
app.use(express.json());

// =====================================
// 3) USER STATE (simple in-memory)
// =====================================
const state = new Map(); // chatId -> { market, tf, expiry, auto, lastSignalAt }

function getState(chatId) {
  if (!state.has(chatId)) {
    state.set(chatId, {
      market: "FIN",
      tf: "5m",
      expiry: "5m",
      auto: false,
      lastSignalAt: 0,
    });
  }
  return state.get(chatId);
}

// =====================================
// 4) HELPERS (UI)
// =====================================
function htmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔥 Best", callback_data: "menu:best" },
        { text: "📈 FIN", callback_data: "menu:fin" },
        { text: "🌙 OTC", callback_data: "menu:otc" },
      ],
      [
        { text: "🤖 Auto", callback_data: "menu:auto" },
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

  return {
    inline_keyboard: [
      tfRow.slice(0, 5),
      expRow.slice(0, 5),
      [
        { text: st.market === "FIN" ? "✅ FIN" : "FIN", callback_data: "set:market:FIN" },
        { text: st.market === "OTC" ? "✅ OTC" : "OTC", callback_data: "set:market:OTC" },
      ],
      [{ text: "⬅️ Back", callback_data: "menu:home" }],
    ],
  };
}

function formatSignalMessage({ market, pair, tf, expiry, direction, confidence, reason, timeStr }) {
  const dirEmoji = direction === "CALL" ? "🟢" : "🔴";
  const dirText = direction === "CALL" ? "BUY (CALL)" : "SELL (PUT)";

  return (
    `${dirEmoji} <b>SIGNAL</b>\n` +
    `• <b>Pair:</b> <code>${htmlEscape(pair)}</code>\n` +
    `• <b>Market:</b> <b>${htmlEscape(market)}</b>\n` +
    `• <b>TF:</b> <code>${htmlEscape(tf)}</code>   <b>EXP:</b> <code>${htmlEscape(expiry)}</code>\n` +
    `• <b>Direction:</b> <b>${htmlEscape(dirText)}</b>\n` +
    `• <b>Confidence:</b> <b>${confidence}%</b>\n` +
    `• <b>Time:</b> ${htmlEscape(timeStr)}\n\n` +
    `🧠 <b>Reason:</b> ${htmlEscape(reason)}`
  );
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// =====================================
// 5) SIGNAL ENGINE (stub)
// Replace this with your real logic / site data
// =====================================
function generateSignal(chatId, marketOverride = null) {
  const st = getState(chatId);
  const market = marketOverride || st.market;
  const list = PAIRS[market] || [];
  const pair = randomChoice(list.length ? list : ["EURUSD"]);

  const direction = Math.random() > 0.5 ? "CALL" : "PUT";
  const confidence = Math.floor(70 + Math.random() * 25); // 70-95
  const reason =
    direction === "CALL"
      ? "Trend + momentum підтверджені, є відскок від рівня."
      : "Є ознаки розвороту, імпульс слабшає біля опору.";

  const now = new Date();
  const timeStr = now.toLocaleString("uk-UA");

  return {
    market,
    pair,
    tf: st.tf,
    expiry: st.expiry,
    direction,
    confidence,
    reason,
    timeStr,
  };
}

// =====================================
// 6) COMMANDS
// =====================================
bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  getState(chatId);

  await bot.sendMessage(
    chatId,
    `👋 <b>Привіт!</b>\nЯ бот сигналів.\n\nОбери дію в меню нижче.`,
    { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
  );
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const input = (match?.[1] || "").trim();
  if (!input) return;

  const st = getState(chatId);
  const market = input.includes("_OTC") ? "OTC" : st.market;
  const pair = input;

  const sig = generateSignal(chatId, market);
  sig.pair = pair;

  await bot.sendMessage(chatId, formatSignalMessage(sig), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔁 Next", callback_data: "action:best" },
          { text: "⚙️ Settings", callback_data: "menu:settings" },
        ],
        [{ text: "⬅️ Menu", callback_data: "menu:home" }],
      ],
    },
  });
});

// =====================================
// 7) BUTTON HANDLER
// =====================================
bot.on("callback_query", async (q) => {
  const chatId = String(q.message.chat.id);
  const data = String(q.data || "");
  const st = getState(chatId);

  try {
    // MENU
    if (data === "menu:home") {
      await bot.editMessageText("🏠 <b>Меню</b>", {
        chat_id: chatId,
        message_id: q.message.message_id,
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboard(),
      });
      return bot.answerCallbackQuery(q.id);
    }

    if (data === "menu:fin") {
      st.market = "FIN";
      await bot.answerCallbackQuery(q.id, { text: "Market: FIN" });
      return;
    }

    if (data === "menu:otc") {
      st.market = "OTC";
      await bot.answerCallbackQuery(q.id, { text: "Market: OTC" });
      return;
    }

    if (data === "menu:settings") {
      await bot.editMessageText("⚙️ <b>Settings</b>\nОбери TF / EXP / Market:", {
        chat_id: chatId,
        message_id: q.message.message_id,
        parse_mode: "HTML",
        reply_markup: settingsKeyboard(chatId),
      });
      return bot.answerCallbackQuery(q.id);
    }

    if (data === "menu:status") {
      const text =
        `📊 <b>Status</b>\n` +
        `• Market: <b>${st.market}</b>\n` +
        `• TF: <code>${st.tf}</code>\n` +
        `• EXP: <code>${st.expiry}</code>\n` +
        `• Auto: <b>${st.auto ? "ON" : "OFF"}</b>\n`;
      await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: mainMenuKeyboard() });
      return bot.answerCallbackQuery(q.id);
    }

    if (data === "menu:pairs") {
      const fin = (PAIRS.FIN || []).slice(0, 30).join(", ");
      const otc = (PAIRS.OTC || []).slice(0, 30).join(", ");
      const text =
        `🧾 <b>Pairs</b>\n\n` +
        `📈 <b>FIN:</b>\n<code>${htmlEscape(fin || "-")}</code>\n\n` +
        `🌙 <b>OTC:</b>\n<code>${htmlEscape(otc || "-")}</code>\n\n` +
        `👉 Запит по парі: <code>/pair EURUSD</code> або <code>/pair EURUSD_OTC</code>`;
      await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: mainMenuKeyboard() });
      return bot.answerCallbackQuery(q.id);
    }

    if (data === "menu:auto") {
      st.auto = !st.auto;
      await bot.answerCallbackQuery(q.id, { text: st.auto ? "Auto: ON" : "Auto: OFF" });
      if (st.auto) {
        await bot.sendMessage(chatId, "🤖 Auto режим увімкнено. Я буду надсилати сигнали регулярно.", {
          reply_markup: mainMenuKeyboard(),
        });
      } else {
        await bot.sendMessage(chatId, "🛑 Auto режим вимкнено.", { reply_markup: mainMenuKeyboard() });
      }
      return;
    }

    if (data === "menu:best" || data === "action:best") {
      const sig = generateSignal(chatId);
      await bot.sendMessage(chatId, formatSignalMessage(sig), {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔁 Next", callback_data: "action:best" },
              { text: "⚙️ Settings", callback_data: "menu:settings" },
            ],
            [{ text: "⬅️ Menu", callback_data: "menu:home" }],
          ],
        },
      });
      return bot.answerCallbackQuery(q.id);
    }

    // SETTINGS
    if (data.startsWith("set:")) {
      const [, key, value] = data.split(":");
      if (key === "tf" && TF_OPTIONS.includes(value)) st.tf = value;
      if (key === "exp" && EXP_OPTIONS.includes(value)) st.expiry = value;
      if (key === "market" && (value === "FIN" || value === "OTC")) st.market = value;

      await bot.answerCallbackQuery(q.id, { text: "✅ Saved" });

      // refresh settings screen
      await bot.editMessageText("⚙️ <b>Settings</b>\nОбери TF / EXP / Market:", {
        chat_id: chatId,
        message_id: q.message.message_id,
        parse_mode: "HTML",
        reply_markup: settingsKeyboard(chatId),
      });
      return;
    }

    return bot.answerCallbackQuery(q.id);
  } catch (e) {
    console.error("callback error:", e);
    try {
      await bot.answerCallbackQuery(q.id, { text: "Error 😕", show_alert: false });
    } catch {}
  }
});

// =====================================
// 8) AUTO LOOP
// =====================================
setInterval(async () => {
  for (const [chatId, st] of state.entries()) {
    if (!st.auto) continue;

    const now = Date.now();
    // avoid spam: at most 1 signal per interval
    if (now - st.lastSignalAt < SCAN_INTERVAL_MS - 500) continue;
    st.lastSignalAt = now;

    const sig = generateSignal(chatId);
    try {
      await bot.sendMessage(chatId, formatSignalMessage(sig), {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔁 Next", callback_data: "action:best" },
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

// =====================================
// 9) HTTP API (optional for website/webapp)
// =====================================
app.get("/api/status", (req, res) => {
  res.json({ ok: true, bot: "signals", uptime: process.uptime() });
});

app.get("/api/pairs", (req, res) => {
  const market = String(req.query.market || "ALL").toUpperCase();
  if (market === "FIN") return res.json({ market: "FIN", pairs: PAIRS.FIN || [] });
  if (market === "OTC") return res.json({ market: "OTC", pairs: PAIRS.OTC || [] });
  return res.json({ market: "ALL", pairs: { FIN: PAIRS.FIN || [], OTC: PAIRS.OTC || [] } });
});

app.get("/api/best", (req, res) => {
  // This endpoint returns the same "signal" format as bot (replace later with real data)
  const market = String(req.query.market || "FIN").toUpperCase();
  const tf = String(req.query.tf || "5m");
  const expiry = String(req.query.expiry || "5m");

  // make temp state for api call
  const fakeChat = "api";
  const st = getState(fakeChat);
  st.market = market === "OTC" ? "OTC" : "FIN";
  st.tf = TF_OPTIONS.includes(tf) ? tf : "5m";
  st.expiry = EXP_OPTIONS.includes(expiry) ? expiry : "5m";

  const sig = generateSignal(fakeChat, st.market);
  res.json({ ok: true, signal: sig });
});

app.listen(PORT, async () => {
  console.log(`✅ HTTP API running on :${PORT}`);
  console.log("✅ Bot polling started");

  if (DEFAULT_CHAT_ID) {
    try {
      await bot.sendMessage(DEFAULT_CHAT_ID, "✅ Bot запущено.", { reply_markup: mainMenuKeyboard() });
    } catch (e) {
      console.log("startup message skipped:", e.message);
    }
  }
});
