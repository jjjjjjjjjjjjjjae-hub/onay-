const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const PAIRING_TTL_SECONDS = 10 * 60;
const PRESENCE_TTL_SECONDS = 45;
const MAX_ENCRYPTED_PAYLOAD_LENGTH = 4_000_000;

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

async function phoneRegistrationStatusByHash(env, phoneHash) {
  const registration = await env.DB.prepare(
    "SELECT owner_device_id FROM registered_phones WHERE phone_hash = ?"
  ).bind(phoneHash).first();
  if (!registration) return { phoneHash, registered: false, online: false, ownerDeviceId: "" };

  const presence = await env.DB.prepare(
    "SELECT device_id, expires_at FROM pair_presence WHERE phone_hash = ?"
  ).bind(phoneHash).first();
  const online = !!presence
    && String(presence.device_id || "") === String(registration.owner_device_id || "")
    && Number(presence.expires_at) > nowSeconds();
  if (presence && Number(presence.expires_at) <= nowSeconds()) {
    await env.DB.prepare("DELETE FROM pair_presence WHERE phone_hash = ?").bind(phoneHash).run();
  }

  return {
    phoneHash,
    registered: true,
    online,
    ownerDeviceId: String(registration.owner_device_id || ""),
  };
}

async function phoneRegistrationStatus(env, phone) {
  return phoneRegistrationStatusByHash(env, await sha256Hex(phone));
}

async function registerPhone(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  const deviceId = normalizeDeviceId(body?.deviceId);
  if (phone.length < 10 || phone.length > 15 || deviceId.length < 8) {
    return json({ ok: false, error: "invalid_registration" }, 400);
  }

  const phoneHash = await sha256Hex(phone);
  const now = nowSeconds();
  const existing = await env.DB.prepare(
    "SELECT owner_device_id FROM registered_phones WHERE phone_hash = ?"
  ).bind(phoneHash).first();

  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO registered_phones(phone_hash, owner_device_id, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind(phoneHash, deviceId, now, now).run();
    return json({ ok: true, registered: true, owner: true });
  }

  const owner = String(existing.owner_device_id || "") === deviceId;
  if (owner) {
    await env.DB.prepare(
      "UPDATE registered_phones SET updated_at = ? WHERE phone_hash = ?"
    ).bind(now, phoneHash).run();
  }
  return json({ ok: true, registered: true, owner });
}

async function accountStatus(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  const deviceId = normalizeDeviceId(body?.deviceId);
  if (phone.length < 10 || phone.length > 15) {
    return json({ ok: false, error: "invalid_phone" }, 400);
  }
  const status = await phoneRegistrationStatus(env, phone);
  const owner = status.registered
    && deviceId.length >= 8
    && status.ownerDeviceId === deviceId;
  return json({ ok: true, registered: status.registered, online: status.online, owner });
}

async function logoutPresence(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  const deviceId = normalizeDeviceId(body?.deviceId);
  if (phone.length < 10 || phone.length > 15 || deviceId.length < 8) {
    return json({ ok: false, error: "invalid_presence" }, 400);
  }

  const registration = await phoneRegistrationStatus(env, phone);
  if (!registration.registered) {
    return json({ ok: false, error: "phone_not_registered" }, 404);
  }
  if (registration.ownerDeviceId !== deviceId) {
    return json({ ok: false, error: "device_not_owner" }, 403);
  }

  await env.DB.prepare("DELETE FROM pair_presence WHERE phone_hash = ? AND device_id = ?")
    .bind(registration.phoneHash, deviceId).run();
  return json({ ok: true, online: false });
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

async function updatePresence(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  const deviceId = normalizeDeviceId(body?.deviceId);
  if (phone.length < 10 || phone.length > 15 || deviceId.length < 8) {
    return json({ ok: false, error: "invalid_presence" }, 400);
  }

  const registration = await phoneRegistrationStatus(env, phone);
  if (!registration.registered) {
    return json({ ok: false, error: "phone_not_registered" }, 404);
  }
  if (registration.ownerDeviceId !== deviceId) {
    return json({ ok: false, error: "device_not_owner" }, 403);
  }

  const phoneHash = registration.phoneHash;
  const now = nowSeconds();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO pair_presence(phone_hash, device_id, last_seen, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(phoneHash, deviceId, now, now + PRESENCE_TTL_SECONDS).run();
  return json({ ok: true, online: true, expiresAt: new Date((now + PRESENCE_TTL_SECONDS) * 1000).toISOString() });
}

async function checkPresence(request, env) {
  const body = await readJson(request);
  const phone = normalizePhone(body?.phone);
  if (phone.length < 10 || phone.length > 15) {
    return json({ ok: false, error: "invalid_phone" }, 400);
  }

  const status = await phoneRegistrationStatus(env, phone);
  return json({ ok: true, registered: status.registered, online: status.online });
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

  const registration = await phoneRegistrationStatus(env, phone);
  if (!registration.registered) {
    return json({ ok: false, error: "phone_not_registered" }, 404);
  }
  if (!registration.online) {
    return json({ ok: false, error: "owner_offline" }, 409);
  }

  const phoneHash = registration.phoneHash;
  await cleanupPairRequests(env);
  const existing = await env.DB.prepare(
    "SELECT request_id, created_at, expires_at FROM pair_requests WHERE phone_hash = ? AND requester_device_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
  ).bind(phoneHash, requesterDeviceId).first();
  if (existing && Number(existing.expires_at) > nowSeconds()) {
    return json({
      ok: true,
      requestId: existing.request_id,
      status: "pending",
      expiresAt: new Date(Number(existing.expires_at) * 1000).toISOString(),
      expiresInSeconds: Math.max(0, Number(existing.expires_at) - nowSeconds()),
      reused: true,
    });
  }

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
  const deviceId = normalizeDeviceId(body?.deviceId);
  if (phone.length < 10 || phone.length > 15) {
    return json({ ok: false, error: "invalid_phone" }, 400);
  }
  if (deviceId.length < 8) return json({ ok: false, error: "invalid_device" }, 400);

  const registration = await phoneRegistrationStatus(env, phone);
  if (!registration.registered) {
    return json({ ok: false, error: "phone_not_registered" }, 404);
  }
  if (registration.ownerDeviceId !== deviceId) {
    return json({ ok: false, error: "device_not_owner" }, 403);
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
  const deviceId = normalizeDeviceId(body?.deviceId);
  if (!requestId || phone.length < 10 || phone.length > 15) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  if (deviceId.length < 8) return json({ ok: false, error: "invalid_device" }, 400);

  const phoneHash = await sha256Hex(phone);
  const registration = await phoneRegistrationStatus(env, phone);
  if (!registration.registered || registration.ownerDeviceId !== deviceId) {
    return json({ ok: false, error: "device_not_owner" }, 403);
  }
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
  const approverDeviceId = normalizeDeviceId(body?.deviceId);
  const encryptedPayload = String(body?.encryptedPayload || "");
  const code = String(body?.pairCode || "").replace(/\D/g, "");

  if (!requestId || phone.length < 10 || phone.length > 15) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  if (approverDeviceId.length < 8) return json({ ok: false, error: "invalid_device" }, 400);
  if (encryptedPayload.length < 16 || encryptedPayload.length > MAX_ENCRYPTED_PAYLOAD_LENGTH) {
    return json({ ok: false, error: "invalid_payload" }, 400);
  }
  if (!/^\d{8}$/.test(code)) {
    return json({ ok: false, error: "invalid_code" }, 400);
  }

  const phoneHash = await sha256Hex(phone);
  const registration = await phoneRegistrationStatus(env, phone);
  if (!registration.registered || registration.ownerDeviceId !== approverDeviceId) {
    return json({ ok: false, error: "device_not_owner" }, 403);
  }
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
  ).bind(codeHash, JSON.stringify({ encryptedPayload, approverDeviceId }), nowSeconds(), requestId, phoneHash).run();
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
    "SELECT phone_hash, requester_device_id, status, pair_code_hash, payload_json, expires_at FROM pair_requests WHERE request_id = ?"
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

  const registration = await phoneRegistrationStatusByHash(env, row.phone_hash);
  if (!registration.registered || !stored.approverDeviceId
      || registration.ownerDeviceId !== String(stored.approverDeviceId)) {
    await env.DB.prepare(
      "UPDATE pair_requests SET status = 'expired' WHERE request_id = ? AND status = 'approved'"
    ).bind(requestId).run();
    return json({ ok: false, error: "request_stale" }, 409);
  }

  const claimedAt = nowIso();
  const claimedAtSeconds = nowSeconds();
  // Claim, transfer ownership, clear the old presence, and expire competing
  // requests in one D1 batch. D1 rolls the batch back if a statement fails.
  const [claimResult, ownershipResult] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE pair_requests SET status = 'claimed', payload_json = NULL, claimed_at = ? WHERE request_id = ? AND phone_hash = ? AND status = 'approved' AND pair_code_hash = ? AND EXISTS (SELECT 1 FROM registered_phones WHERE phone_hash = ? AND owner_device_id = ?)"
    ).bind(claimedAtSeconds, requestId, row.phone_hash, codeHash, row.phone_hash, stored.approverDeviceId),
    env.DB.prepare(
      "UPDATE registered_phones SET owner_device_id = ?, updated_at = ? WHERE phone_hash = ? AND owner_device_id = ?"
    ).bind(row.requester_device_id, claimedAtSeconds, row.phone_hash, stored.approverDeviceId),
    env.DB.prepare("DELETE FROM pair_presence WHERE phone_hash = ?").bind(row.phone_hash),
    env.DB.prepare(
      "UPDATE pair_requests SET status = 'expired' WHERE phone_hash = ? AND status IN ('pending','approved') AND request_id <> ?"
    ).bind(row.phone_hash, requestId),
  ]);
  if (!claimResult.success || Number(claimResult.meta?.changes || 0) !== 1) {
    return json({ ok: false, error: "code_already_claimed" }, 409);
  }
  if (!ownershipResult.success || Number(ownershipResult.meta?.changes || 0) !== 1) {
    return json({ ok: false, error: "account_transfer_failed" }, 500);
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
      if (url.pathname === "/v1/account/register") return await registerPhone(request, env);
      if (url.pathname === "/v1/account/status") return await accountStatus(request, env);
      if (url.pathname === "/v1/account/logout") return await logoutPresence(request, env);
      if (url.pathname === "/v1/pair/presence") return await updatePresence(request, env);
      if (url.pathname === "/v1/pair/availability") return await checkPresence(request, env);
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
