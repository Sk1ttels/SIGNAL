# SIGNAL PRO — Site + Telegram Bot (one logic)

Це проєкт, де **одна й та сама логіка сигналів** використовується:
- у **Telegram-боті** (меню, кнопки, авто-скан)
- і доступна через **HTTP API** для сайту/WebApp

## 1) Запуск локально

```bash
cd SIGNAL
npm i

# Linux/macOS
export BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN"
# (optional) default chat to send startup message
export CHAT_ID="123456789"

npm start
```

За замовчуванням API піднімається на `http://localhost:3000`.

## 2) Змінні середовища

- `BOT_TOKEN` — **обовʼязково**
- `CHAT_ID` — опціонально (куди відправити стартове повідомлення)
- `PORT` — опціонально (порт HTTP API)

## 3) Команди бота

- `/start` — меню з кнопками
- `/auto` — авто-режим ON/OFF
- `/fin` — найкращий сигнал по FIN
- `/otc` — найкращий сигнал по OTC
- `/signal` — best з усіх пар
- `/tf` + `/settf 5m` — таймфрейм
- `/expiry` + `/setexpiry 5m` — експірація
- `/pair EURUSD` або `/pair EURUSD_OTC` — сигнал по конкретній парі
- `/status` — статус

## 4) API ендпоінти

- `GET /api/status`
- `GET /api/pairs?market=FIN|OTC|ALL`
- `GET /api/best?market=FIN|OTC|ALL&tf=5m&expiry=5m`
