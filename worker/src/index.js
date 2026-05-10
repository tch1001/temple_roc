// Cloudflare Worker replacement for bot.py.
//
// Wire-compatible with the original Python signing scheme, so old game
// sessions issued by bot.py keep validating once we flip over.
//
//   key       = sha256(BOT_TOKEN)
//   payload   = `${user_id}|${chat_id||''}|${message_id||''}|${inline_message_id||''}`
//   signature = hmac_sha256_hex(key, payload)
//
// Routes:
//   POST /webhook       — Telegram webhook (callback_query, /start)
//   POST /submit_score  — game submits final score; we call setGameScore
//   OPTIONS /submit_score — CORS preflight
//   GET  /healthz       — liveness

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders, ...(init.headers || {}) },
  });
}

async function deriveSigningKey(token) {
  const tokenBytes = new TextEncoder().encode(token);
  const hashBuf    = await crypto.subtle.digest('SHA-256', tokenBytes);
  return crypto.subtle.importKey(
    'raw', hashBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify'],
  );
}

async function hmacHex(key, payload) {
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sigBuf), b => b.toString(16).padStart(2, '0')).join('');
}

function makePayload(uid, cid, mid, imid) {
  return `${uid}|${cid ?? ''}|${mid ?? ''}|${imid ?? ''}`;
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function tg(env, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) {
    const err = new Error(`tg.${method} ${res.status}: ${j.description || res.statusText}`);
    err.tg = j;
    throw err;
  }
  return j.result;
}

async function handleSubmitScore(req, env) {
  let data;
  try { data = await req.json(); }
  catch (_) { return jsonResponse({ ok: false, error: 'bad_json' }, { status: 400 }); }

  const uid   = parseInt(data.uid, 10);
  const score = parseInt(data.score, 10);
  const sig   = String(data.sig || '');
  const cid   = data.cid  ? parseInt(data.cid, 10) : null;
  const mid   = data.mid  ? parseInt(data.mid, 10) : null;
  const imid  = data.imid || null;

  if (!Number.isFinite(uid) || !Number.isFinite(score) || !sig) {
    return jsonResponse({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  if (score < 0 || score > 10_000_000) {
    return jsonResponse({ ok: false, error: 'bad_score' }, { status: 400 });
  }

  const key = await deriveSigningKey(env.BOT_TOKEN);
  const expected = await hmacHex(key, makePayload(uid, cid, mid, imid));
  if (!constantTimeEqual(expected, sig)) {
    return jsonResponse({ ok: false, error: 'bad_signature' }, { status: 403 });
  }

  try {
    await tg(env, 'setGameScore', {
      user_id: uid,
      score,
      chat_id: cid,
      message_id: mid,
      inline_message_id: imid,
      force: false,
      disable_edit_message: false,
    });
  } catch (e) {
    // Telegram refuses to lower a player's high score — that's expected, not a server error.
    return jsonResponse({ ok: false, error: String(e.message) }, { status: 200 });
  }
  return jsonResponse({ ok: true });
}

async function handleWebhook(req, env) {
  if (env.WEBHOOK_SECRET) {
    const got = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (got !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  }

  let update;
  try { update = await req.json(); }
  catch (_) { return new Response('bad json', { status: 400 }); }

  const SHORT    = env.GAME_SHORT_NAME;
  const GAME_URL = env.GAME_URL.replace(/\/+$/, '');

  // /start → sendGame
  if (update.message && typeof update.message.text === 'string' && update.message.text.startsWith('/start')) {
    try {
      await tg(env, 'sendGame', {
        chat_id: update.message.chat.id,
        game_short_name: SHORT,
      });
    } catch (e) { /* swallow */ }
    return new Response('ok');
  }

  if (update.message && update.message.text === '/help') {
    await tg(env, 'sendMessage', {
      chat_id: update.message.chat.id,
      text: 'Run from the falling temple. /start to play.',
    }).catch(() => {});
    return new Response('ok');
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    if (cq.game_short_name !== SHORT) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
      return new Response('ok');
    }

    const uid = cq.from.id;
    const chat_id = cq.message?.chat?.id ?? null;
    const message_id = cq.message?.message_id ?? null;
    const inline_message_id = cq.inline_message_id ?? null;

    const key = await deriveSigningKey(env.BOT_TOKEN);
    const sig = await hmacHex(key, makePayload(uid, chat_id, message_id, inline_message_id));

    const params = new URLSearchParams({
      uid: String(uid),
      name: cq.from.first_name || 'Runner',
      sig,
    });
    if (chat_id !== null && message_id !== null) {
      params.set('cid', String(chat_id));
      params.set('mid', String(message_id));
    }
    if (inline_message_id) params.set('imid', inline_message_id);

    const url = `${GAME_URL}/?${params.toString()}`;
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, url }).catch(() => {});
    return new Response('ok');
  }

  return new Response('ok');
}

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (url.pathname === '/submit_score' && request.method === 'POST') {
      return handleSubmitScore(request, env);
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }
    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200 });
    }
    return new Response('temple roc worker', { status: 200 });
  },
};
