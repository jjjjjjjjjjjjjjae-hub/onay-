const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const PAIRING_TTL_SECONDS = 10 * 60;
const MAX_ENCRYPTED_PAYLOAD_LENGTH = 900_000;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomPairingCode() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 100_000_000).padStart(8, "0");
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function rateLimit(env, key, limit, windowSeconds) {
  const cutoff = nowSeconds() - windowSeconds;
  await env.DB.prepare(
    "DELETE FROM pair_rate_limits WHERE window_start < ?"
  ).bind(cutoff).run();

  const row = await env.DB.prepare(
    "SELECT attempts, window_start FROM pair_rate_limits WHERE rate_key = ?"
  ).bind(key).first();
  const now = nowSeconds();

  if (!row || Number(row.window_start) < cutoff) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO pair_rate_limits(rate_key, attempts, window_start) VALUES (?, 1, ?)"
    ).bind(key, now).run();
    return true;
  }

  if (Number(row.attempts) >= limit) return false;
  await env.DB.prepare(
    "UPDATE pair_rate_limits SET attempts = attempts + 1 WHERE rate_key = ?"
  ).bind(key).run();
  return true;
}

async function createPairing(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  const encryptedPayload = String(body?.encryptedPayload || "");

  if (phone.length < 10 || phone.length > 15) {
    return json({ ok: false, error: "invalid_phone" }, 400);
  }
  if (encryptedPayload.length < 16 || encryptedPayload.length > MAX_ENCRYPTED_PAYLOAD_LENGTH) {
    return json({ ok: false, error: "invalid_payload" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await rateLimit(env, `create:${ip}:${await sha256Hex(phone)}`, 20, 3600);
  if (!allowed) return json({ ok: false, error: "rate_limited" }, 429);

  const requestedCode = String(body?.pairCode || "").replace(/\D/g, "");
  const code = /^\d{8}$/.test(requestedCode) ? requestedCode : randomPairingCode();
  const codeHash = await sha256Hex(code);
  const phoneHash = await sha256Hex(phone);
  const expiresAt = nowSeconds() + PAIRING_TTL_SECONDS;

  await env.DB.prepare("DELETE FROM device_pairings WHERE expires_at < ?")
    .bind(nowSeconds()).run();
  const collision = await env.DB.prepare(
    "SELECT code_hash FROM device_pairings WHERE code_hash = ?"
  ).bind(codeHash).first();
  if (collision) return json({ ok: false, error: "code_collision" }, 409);
  await env.DB.prepare(
    "INSERT INTO device_pairings(code_hash, phone_hash, payload_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(codeHash, phoneHash, JSON.stringify({ encryptedPayload }), nowSeconds(), expiresAt).run();

  return json({
    ok: true,
    code,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    expiresInSeconds: PAIRING_TTL_SECONDS,
  });
}

async function claimPairing(request, env) {
  const body = await readJson(request);
  const code = String(body?.code || "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(code)) return json({ ok: false, error: "invalid_code" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await rateLimit(env, `claim:${ip}`, 30, 3600);
  if (!allowed) return json({ ok: false, error: "rate_limited" }, 429);

  const codeHash = await sha256Hex(code);
  const row = await env.DB.prepare(
    "SELECT phone_hash, payload_json, expires_at FROM device_pairings WHERE code_hash = ?"
  ).bind(codeHash).first();

  if (!row || Number(row.expires_at) <= nowSeconds()) {
    return json({ ok: false, error: "code_not_found_or_expired" }, 404);
  }

  const claimedAt = nowIso();
  const result = await env.DB.prepare(
    "DELETE FROM device_pairings WHERE code_hash = ?"
  ).bind(codeHash).run();
  if (!result.success || Number(result.meta?.changes || 0) !== 1) {
    return json({ ok: false, error: "code_already_claimed" }, 409);
  }

  let stored;
  try {
    stored = JSON.parse(row.payload_json);
  } catch {
    return json({ ok: false, error: "stored_payload_invalid" }, 500);
  }

  return json({
    ok: true,
    phoneHash: row.phone_hash,
    encryptedPayload: stored.encryptedPayload,
    claimedAt,
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "onay-device-sync" });
    }
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

    try {
      if (url.pathname === "/v1/pair/create") return await createPairing(request, env);
      if (url.pathname === "/v1/pair/claim") return await claimPairing(request, env);
      return json({ ok: false, error: "not_found" }, 404);
    } catch (error) {
      console.error("onay-device-sync request failed", error);
      return json({ ok: false, error: "internal_error" }, 500);
    }
  },
};

