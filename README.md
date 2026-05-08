# Temple Roc

A simple Telegram HTML5 game in the spirit of the official Lumberjack bot,
but as a pseudo-3D Temple-Run-style endless runner with three lanes,
jumps, slides, and coins.

## Layout

```
.
├── bot.py          # Telegram bot + aiohttp web server (game host + score endpoint)
├── requirements.txt
├── .env.example
└── game/           # Static HTML5 game (Canvas)
    ├── index.html
    ├── style.css
    └── game.js
```

## How it works

Same flow as the Lumberjack bot:

1. `/start` -> `sendGame(GAME_SHORT_NAME)`.
2. User taps the game button -> Telegram fires a `callback_query` with
   `game_short_name` set.
3. The bot responds with `answerCallbackQuery(url=<signed game URL>)`,
   passing `uid`, `cid`, `mid` (or `imid`) and an HMAC signature.
4. The HTML5 game runs in Telegram's webview, plays out a run, and on
   game over `POST`s the final score to `/submit_score`.
5. The server verifies the HMAC and calls `setGameScore(...)`, so
   Telegram's built-in leaderboard updates.

## Setup

### 1. Create the bot and game

In a chat with [@BotFather](https://t.me/BotFather):

```
/newbot                 # create the bot, save the token
/newgame                # create a game on that bot
                        #   - title, description, photo
                        #   - short_name: templeroc  (must match GAME_SHORT_NAME)
/setinline              # optional, lets users share the game inline
```

When BotFather asks for the game URL, point it at `https://<your-host>/game/`.

### 2. Configure

```bash
cp .env.example .env
# fill in BOT_TOKEN, PUBLIC_URL, GAME_SHORT_NAME
```

`PUBLIC_URL` must be **HTTPS** (Telegram requires it).
For local development, expose port 8080 via [ngrok](https://ngrok.com/) or
[cloudflared](https://github.com/cloudflare/cloudflared) and use the
generated HTTPS URL.

### 3. Install and run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python bot.py
```

`bot.py` does both: it polls Telegram for updates *and* serves the game +
score endpoint on `PORT` (default 8080).

### 4. Play

Open the bot in Telegram, send `/start`, and tap the game.

## Controls

| Action       | Keyboard          | Touch        |
|--------------|-------------------|--------------|
| Switch lanes | ← / →             | Swipe ←/→    |
| Jump         | ↑ / Space         | Tap or swipe up |
| Slide        | ↓                 | Swipe down   |

Obstacle types:

- **Low blocks** — jump over.
- **Overhead beams** — slide under.
- **Pillars** — switch lane.
- **Pillar pairs** — only one lane is safe.

## Notes

- `setGameScore` with `force=False` only stores higher scores — Telegram
  silently keeps the user's previous best otherwise. The bot logs that as
  an info message, not an error.
- The HMAC over `uid|chat_id|message_id|inline_message_id` prevents random
  POSTs to `/submit_score`. The signing key is derived from `BOT_TOKEN`.
- The game also stores a local `best` in `localStorage` for offline play.
