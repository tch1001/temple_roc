"""Temple Roc — a tiny Telegram HTML5 runner game.

Mirrors the structure of Telegram's classic Lumberjack bot:
  - /start -> sendGame
  - callback_query with game_short_name -> answerCallbackQuery(url=...)
  - HTML5 game posts the final score back to /submit_score
  - server verifies the HMAC signature and calls setGameScore
"""

from __future__ import annotations

import asyncio
import hmac
import hashlib
import logging
import os
from pathlib import Path
from urllib.parse import urlencode

from aiohttp import web
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
)
from telegram.request import HTTPXRequest

load_dotenv()

BOT_TOKEN = os.environ["BOT_TOKEN"]
GAME_SHORT_NAME = os.environ.get("GAME_SHORT_NAME", "templeroc")
PUBLIC_URL = os.environ["PUBLIC_URL"].rstrip("/")
PORT = int(os.environ.get("PORT", "8080"))

GAME_DIR = Path(__file__).parent / "game"
SIGNING_KEY = hashlib.sha256(BOT_TOKEN.encode()).digest()

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("temple_roc")


def sign(payload: str) -> str:
    return hmac.new(SIGNING_KEY, payload.encode(), hashlib.sha256).hexdigest()


def make_payload(user_id: int, chat_id: int | None, message_id: int | None,
                 inline_message_id: str | None) -> str:
    return f"{user_id}|{chat_id or ''}|{message_id or ''}|{inline_message_id or ''}"


# ---------- Telegram handlers ----------

async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_game(GAME_SHORT_NAME)


async def help_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Run from the falling temple. /start to play. Swipe or arrow-keys to "
        "switch lanes; up to jump."
    )


async def on_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    cq = update.callback_query
    if cq.game_short_name != GAME_SHORT_NAME:
        await cq.answer()
        return

    chat_id = cq.message.chat.id if cq.message else None
    message_id = cq.message.message_id if cq.message else None
    inline_message_id = cq.inline_message_id

    payload = make_payload(cq.from_user.id, chat_id, message_id, inline_message_id)
    sig = sign(payload)

    params = {
        "uid": str(cq.from_user.id),
        "name": cq.from_user.first_name or "Runner",
        "sig": sig,
    }
    if chat_id is not None and message_id is not None:
        params["cid"] = str(chat_id)
        params["mid"] = str(message_id)
    if inline_message_id:
        params["imid"] = inline_message_id

    url = f"{PUBLIC_URL}/?{urlencode(params)}"
    await cq.answer(url=url)


# ---------- HTTP: game host + score submission ----------

async def submit_score(request: web.Request) -> web.Response:
    try:
        data = await request.json()
        uid = int(data["uid"])
        score = int(data["score"])
        sig = str(data["sig"])
        chat_id = int(data["cid"]) if data.get("cid") else None
        message_id = int(data["mid"]) if data.get("mid") else None
        inline_message_id = data.get("imid") or None
    except (KeyError, ValueError, TypeError):
        return web.json_response({"ok": False, "error": "bad_request"}, status=400)

    expected = sign(make_payload(uid, chat_id, message_id, inline_message_id))
    if not hmac.compare_digest(expected, sig):
        return web.json_response({"ok": False, "error": "bad_signature"}, status=403)

    if score < 0 or score > 10_000_000:
        return web.json_response({"ok": False, "error": "bad_score"}, status=400)

    bot = request.app["bot"]
    try:
        await bot.set_game_score(
            user_id=uid,
            score=score,
            chat_id=chat_id,
            message_id=message_id,
            inline_message_id=inline_message_id,
            disable_edit_message=False,
            force=False,
        )
    except Exception as e:
        # Telegram refuses to lower a player's high score unless force=True.
        # That's expected, not a server error — surface it as ok=False.
        log.info("set_game_score skipped: %s", e)
        return web.json_response({"ok": False, "error": str(e)}, status=200)

    return web.json_response({"ok": True})


async def healthz(_: web.Request) -> web.Response:
    return web.Response(text="ok")


async def game_index(request: web.Request) -> web.FileResponse:
    # aiohttp's add_static() won't auto-serve index.html — wire it explicitly
    # so /game/ and /game/?uid=... both render the game.
    return web.FileResponse(GAME_DIR / "index.html")


def build_web_app(application: Application) -> web.Application:
    app = web.Application()
    app["bot"] = application.bot
    app.router.add_post("/submit_score", submit_score)
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/game", game_index)
    app.router.add_get("/game/", game_index)
    app.router.add_static("/game/", path=str(GAME_DIR), show_index=False, name="game")
    return app


# ---------- entrypoint ----------

async def run() -> None:
    request = HTTPXRequest(connect_timeout=20, read_timeout=30, write_timeout=30, pool_timeout=10)
    get_updates_request = HTTPXRequest(connect_timeout=20, read_timeout=40, write_timeout=30, pool_timeout=10)
    application = (
        Application.builder()
        .token(BOT_TOKEN)
        .request(request)
        .get_updates_request(get_updates_request)
        .build()
    )
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_cmd))
    application.add_handler(CallbackQueryHandler(on_callback))

    web_app = build_web_app(application)
    runner = web.AppRunner(web_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)

    await application.initialize()
    await application.start()
    await application.updater.start_polling()
    await site.start()

    log.info("temple_roc up — game served at %s/game/  | bot polling", PUBLIC_URL)

    stop_event = asyncio.Event()
    try:
        await stop_event.wait()
    finally:
        await application.updater.stop()
        await application.stop()
        await application.shutdown()
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
