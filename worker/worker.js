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

function normalizeDeviceId(value) {
  return String(value || "").trim().slice(0, 120);
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

async function cleanupPairRequests(env) {
  await env.DB.prepare(
    "DELETE FROM pair_requests WHERE expires_at < ?"
  ).bind(nowSeconds()).run();
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

async function requestPairing(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  const requesterDeviceId = normalizeDeviceId(body?.requesterDeviceId);

  if (phone.length < 10 || phone.length > 15) {
    return json({ ok: false, error: "invalid_phone" }, 400);
  }
  if (requesterDeviceId.length < 8) {
    return json({ ok: false, error: "invalid_device" }, 400);
  }

  const phoneHash = await sha256Hex(phone);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await rateLimit(env, `request:${ip}:${phoneHash}`, 12, 3600);
  if (!allowed) return json({ ok: false, error: "rate_limited" }, 429);

  await cleanupPairRequests(env);
  await env.DB.prepare(
    "UPDATE pair_requests SET status = 'expired' WHERE phone_hash = ? AND status = 'pending'"
  ).bind(phoneHash).run();

  const requestId = crypto.randomUUID();
  const createdAt = nowSeconds();
  const expiresAt = createdAt + PAIRING_TTL_SECONDS;
  await env.DB.prepare(
    "INSERT INTO pair_requests(request_id, phone_hash, requester_device_id, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)"
  ).bind(requestId, phoneHash, requesterDeviceId, createdAt, expiresAt).run();

  return json({
    ok: true,
    requestId,
    status: "pending",
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    expiresInSeconds: PAIRING_TTL_SECONDS,
  });
}

async function pendingPairing(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  if (phone.length < 10 || phone.length > 15) {
    return json({ ok: false, error: "invalid_phone" }, 400);
  }

  await cleanupPairRequests(env);
  const phoneHash = await sha256Hex(phone);
  const row = await env.DB.prepare(
    "SELECT request_id, created_at, expires_at FROM pair_requests WHERE phone_hash = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
  ).bind(phoneHash).first();

  if (!row) return json({ ok: true, pending: false });
  return json({
    ok: true,
    pending: true,
    requestId: row.request_id,
    createdAt: new Date(Number(row.created_at) * 1000).toISOString(),
    expiresAt: new Date(Number(row.expires_at) * 1000).toISOString(),
  });
}

async function rejectPairing(request, env) {
  const body = await readJson(request);
  const requestId = String(body?.requestId || "").trim().slice(0, 100);
  const phone = normalizePhone(body?.phone);
  if (!requestId || phone.length < 10 || phone.length > 15) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }

  const phoneHash = await sha256Hex(phone);
  const result = await env.DB.prepare(
    "UPDATE pair_requests SET status = 'rejected' WHERE request_id = ? AND phone_hash = ? AND status = 'pending'"
  ).bind(requestId, phoneHash).run();
  if (!result.success || Number(result.meta?.changes || 0) !== 1) {
    return json({ ok: false, error: "request_not_pending" }, 409);
  }
  return json({ ok: true, requestId, status: "rejected" });
}

async function approvePairing(request, env) {
  const body = await readJson(request);
  const requestId = String(body?.requestId || "").trim().slice(0, 100);
  const phone = normalizePhone(body?.phone);
  const encryptedPayload = String(body?.encryptedPayload || "");
  const code = String(body?.pairCode || "").replace(/\D/g, "");

  if (!requestId || phone.length < 10 || phone.length > 15) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  if (encryptedPayload.length < 16 || encryptedPayload.length > MAX_ENCRYPTED_PAYLOAD_LENGTH) {
    return json({ ok: false, error: "invalid_payload" }, 400);
  }
  if (!/^\d{8}$/.test(code)) {
    return json({ ok: false, error: "invalid_code" }, 400);
  }

  const phoneHash = await sha256Hex(phone);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await rateLimit(env, `approve:${ip}:${phoneHash}`, 20, 3600);
  if (!allowed) return json({ ok: false, error: "rate_limited" }, 429);

  const row = await env.DB.prepare(
    "SELECT status, expires_at FROM pair_requests WHERE request_id = ? AND phone_hash = ?"
  ).bind(requestId, phoneHash).first();
  if (!row || row.status !== "pending") {
    return json({ ok: false, error: "request_not_pending" }, 409);
  }
  if (Number(row.expires_at) <= nowSeconds()) {
    await env.DB.prepare(
      "UPDATE pair_requests SET status = 'expired' WHERE request_id = ? AND status = 'pending'"
    ).bind(requestId).run();
    return json({ ok: false, error: "request_expired" }, 410);
  }

  const codeHash = await sha256Hex(code);
  const result = await env.DB.prepare(
    "UPDATE pair_requests SET status = 'approved', pair_code_hash = ?, payload_json = ?, approved_at = ? WHERE request_id = ? AND phone_hash = ? AND status = 'pending'"
  ).bind(codeHash, JSON.stringify({ encryptedPayload }), nowSeconds(), requestId, phoneHash).run();
  if (!result.success || Number(result.meta?.changes || 0) !== 1) {
    return json({ ok: false, error: "request_already_handled" }, 409);
  }

  return json({
    ok: true,
    requestId,
    status: "approved",
    code,
    expiresAt: new Date(Number(row.expires_at) * 1000).toISOString(),
  });
}

async function pairingStatus(request, env) {
  const body = await readJson(request);
  const requestId = String(body?.requestId || "").trim().slice(0, 100);
  if (!requestId) return json({ ok: false, error: "invalid_request" }, 400);

  const row = await env.DB.prepare(
    "SELECT status, expires_at, approved_at, claimed_at FROM pair_requests WHERE request_id = ?"
  ).bind(requestId).first();
  if (!row) return json({ ok: false, error: "request_not_found" }, 404);

  let status = String(row.status || "");
  if ((status === "pending" || status === "approved") && Number(row.expires_at) <= nowSeconds()) {
    await env.DB.prepare(
      "UPDATE pair_requests SET status = 'expired' WHERE request_id = ? AND status = ?"
    ).bind(requestId, status).run();
    status = "expired";
  }

  return json({
    ok: true,
    requestId,
    status,
    expiresAt: new Date(Number(row.expires_at) * 1000).toISOString(),
    approvedAt: row.approved_at ? new Date(Number(row.approved_at) * 1000).toISOString() : null,
    claimedAt: row.claimed_at ? new Date(Number(row.claimed_at) * 1000).toISOString() : null,
  });
}

async function claimRequestedPairing(request, env) {
  const body = await readJson(request);
  const requestId = String(body?.requestId || "").trim().slice(0, 100);
  const code = String(body?.code || "").replace(/\D/g, "");
  if (!requestId || !/^\d{8}$/.test(code)) {
    return json({ ok: false, error: "invalid_code" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await rateLimit(env, `claim-request:${ip}`, 30, 3600);
  if (!allowed) return json({ ok: false, error: "rate_limited" }, 429);

  const codeHash = await sha256Hex(code);
  const row = await env.DB.prepare(
    "SELECT phone_hash, status, pair_code_hash, payload_json, expires_at FROM pair_requests WHERE request_id = ?"
  ).bind(requestId).first();

  if (!row || row.status !== "approved" || Number(row.expires_at) <= nowSeconds()) {
    return json({ ok: false, error: "request_not_approved_or_expired" }, 404);
  }
  if (row.pair_code_hash !== codeHash) {
    return json({ ok: false, error: "invalid_code" }, 403);
  }

  let stored;
  try {
    stored = JSON.parse(row.payload_json || "");
  } catch {
    return json({ ok: false, error: "stored_payload_invalid" }, 500);
  }

  const claimedAt = nowIso();
  const result = await env.DB.prepare(
    "UPDATE pair_requests SET status = 'claimed', payload_json = NULL, claimed_at = ? WHERE request_id = ? AND status = 'approved' AND pair_code_hash = ?"
  ).bind(claimedAt, requestId, codeHash).run();
  if (!result.success || Number(result.meta?.changes || 0) !== 1) {
    return json({ ok: false, error: "code_already_claimed" }, 409);
  }

  return json({
    ok: true,
    requestId,
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
      if (url.pathname === "/v1/pair/request") return await requestPairing(request, env);
      if (url.pathname === "/v1/pair/pending") return await pendingPairing(request, env);
      if (url.pathname === "/v1/pair/reject") return await rejectPairing(request, env);
      if (url.pathname === "/v1/pair/approve") return await approvePairing(request, env);
      if (url.pathname === "/v1/pair/status") return await pairingStatus(request, env);
      if (url.pathname === "/v1/pair/claim-request") return await claimRequestedPairing(request, env);
      return json({ ok: false, error: "not_found" }, 404);
    } catch (error) {
      console.error("onay-device-sync request failed", error);
      return json({ ok: false, error: "internal_error" }, 500);
    }
  },
};
