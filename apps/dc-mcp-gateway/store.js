/**
 * Persistent SQLite store (node:sqlite, 0600, WAL) for dc-mcp-gateway:
 *  - dpop_jtis: persistent DPoP proof replay table across restarts
 *  - auth_codes: persistent single-use PKCE authorization codes
 *  - jc_devices: enrolled jace-commander-cli devices (sub + jkt + status)
 *  - jc_device_codes: RFC 8628 device authorization state machine
 *  - jc_refresh_tokens: transactional refresh-token rotation + AES-256-GCM recovery envelopes
 *
 * Zero runtime dependencies. Never persists plaintext live access/refresh tokens.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sha256B64u = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('base64url');
const isoFromSec = (sec) => new Date(sec * 1000).toISOString();

export function normalizeUserCode(code) {
  if (typeof code !== 'string') return '';
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function deriveRecoveryKey(signingKey, overrideKey) {
  const secret = overrideKey && overrideKey.length > 0 ? overrideKey : signingKey;
  const info =
    overrideKey && overrideKey.length > 0
      ? 'jc-refresh-recovery-override-v1'
      : 'jc-refresh-recovery-v1';
  const raw = crypto.hkdfSync(
    'sha256',
    Buffer.from(String(secret || 'ephemeral-test-key'), 'utf8'),
    Buffer.alloc(0),
    Buffer.from(info, 'utf8'),
    32,
  );
  return Buffer.from(raw);
}

function encryptRecovery(key, aad, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

function decryptRecovery(key, aad, blob) {
  if (typeof blob !== 'string') throw new Error('missing recovery blob');
  const parts = blob.split('.');
  if (parts.length !== 3) throw new Error('malformed recovery blob');
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(pt);
}

function recoveryAad({ deviceId, family, cnfJkt, oldTokenHash, requestId }) {
  return `${deviceId || ''}|${family}|${cnfJkt}|${oldTokenHash}|${requestId}`;
}

export function createGatewayStore(dbPath, { signingKey = '', recoveryKey = '' } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    /* best effort */
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS dpop_jtis (
      jti TEXT PRIMARY KEY,
      jkt TEXT NOT NULL,
      exp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dpop_jtis_exp ON dpop_jtis(exp);

    CREATE TABLE IF NOT EXISTS auth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      issuer TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL,
      dpop_jkt TEXT,
      device_name TEXT,
      exp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jc_devices (
      device_id TEXT PRIMARY KEY,
      sub TEXT NOT NULL,
      client_id TEXT NOT NULL,
      jkt TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      last_refreshed_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jc_devices_sub ON jc_devices(sub);
    CREATE INDEX IF NOT EXISTS idx_jc_devices_jkt ON jc_devices(jkt);

    CREATE TABLE IF NOT EXISTS jc_device_codes (
      device_code_hash TEXT PRIMARY KEY,
      user_code_hash TEXT UNIQUE NOT NULL,
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      issuer TEXT NOT NULL,
      dpop_jkt TEXT,
      device_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sub TEXT,
      interval_s INTEGER NOT NULL,
      last_poll_ms INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jc_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      family TEXT NOT NULL,
      device_id TEXT,
      client_id TEXT NOT NULL,
      sub TEXT NOT NULL,
      cnf_jkt TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      issuer TEXT NOT NULL,
      exp INTEGER NOT NULL,
      inactivity_exp INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      revoked INTEGER NOT NULL DEFAULT 0,
      rotated_at INTEGER,
      used_request_id TEXT,
      successor_hash TEXT,
      recovery_blob TEXT,
      recovery_expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jc_rt_family ON jc_refresh_tokens(family);
    CREATE INDEX IF NOT EXISTS idx_jc_rt_device ON jc_refresh_tokens(device_id);
  `);

  const recKey = deriveRecoveryKey(signingKey, recoveryKey);

  function withImmediateTx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  let jtiOps = 0;
  function consumeJti(jti, jkt, exp, nowSec = Math.floor(Date.now() / 1000)) {
    jtiOps += 1;
    if (jtiOps % 100 === 0) {
      db.prepare('DELETE FROM dpop_jtis WHERE exp < ?').run(nowSec);
    }
    try {
      db.prepare('INSERT INTO dpop_jtis (jti, jkt, exp) VALUES (?, ?, ?)').run(jti, jkt, exp);
      return true;
    } catch (err) {
      if (String(err?.code || '').includes('SQLITE_CONSTRAINT') || /UNIQUE|PRIMARY KEY/i.test(String(err?.message))) {
        return false;
      }
      throw err;
    }
  }

  function saveAuthCode(code, rec) {
    db.prepare(
      `INSERT INTO auth_codes
       (code_hash, client_id, redirect_uri, scope, resource, issuer, code_challenge, code_challenge_method, dpop_jkt, device_name, exp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sha256B64u(code),
      rec.client_id,
      rec.redirect_uri,
      rec.scope,
      rec.resource,
      rec.issuer,
      rec.code_challenge,
      rec.code_challenge_method || 'S256',
      rec.dpop_jkt || null,
      rec.device_name || null,
      rec.exp,
    );
  }

  function peekAuthCode(code, nowSec = Math.floor(Date.now() / 1000)) {
    const row = db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(sha256B64u(code));
    if (!row || row.exp < nowSec) return null;
    return row;
  }

  function consumeAuthCode(code, nowSec = Math.floor(Date.now() / 1000)) {
    return withImmediateTx(() => {
      const hash = sha256B64u(code);
      const row = db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(hash);
      db.prepare('DELETE FROM auth_codes WHERE code_hash = ?').run(hash);
      db.prepare('DELETE FROM auth_codes WHERE exp < ?').run(nowSec);
      if (!row || row.exp < nowSec) return null;
      return row;
    });
  }

  function isDeviceOrJktRevoked(deviceId, jkt) {
    if (deviceId) {
      const dev = db.prepare('SELECT status, jkt FROM jc_devices WHERE device_id = ?').get(deviceId);
      if (!dev || dev.status !== 'active') return true;
      if (jkt && dev.jkt !== jkt) return true;
    }
    if (jkt) {
      const rev = db
        .prepare("SELECT 1 AS hit FROM jc_devices WHERE jkt = ? AND status = 'revoked' LIMIT 1")
        .get(jkt);
      if (rev) return true;
    }
    return false;
  }

  function ensureActiveDeviceTx({ sub, clientId, jkt, label, nowSec }) {
    const revoked = db
      .prepare("SELECT 1 AS hit FROM jc_devices WHERE jkt = ? AND status = 'revoked' LIMIT 1")
      .get(jkt);
    if (revoked) return { ok: false, reason: 'device_revoked' };

    const existing = db
      .prepare(
        "SELECT device_id FROM jc_devices WHERE sub = ? AND client_id = ? AND jkt = ? AND status = 'active' LIMIT 1",
      )
      .get(sub, clientId, jkt);
    if (existing) {
      if (label) {
        db.prepare(
          'UPDATE jc_devices SET label = ?, last_used_at = ?, last_refreshed_at = ? WHERE device_id = ?',
        ).run(label, nowSec, nowSec, existing.device_id);
      } else {
        db.prepare(
          'UPDATE jc_devices SET last_used_at = ?, last_refreshed_at = ? WHERE device_id = ?',
        ).run(nowSec, nowSec, existing.device_id);
      }
      return { ok: true, deviceId: existing.device_id };
    }
    const deviceId = `dev_${crypto.randomBytes(12).toString('base64url')}`;
    db.prepare(
      `INSERT INTO jc_devices
       (device_id, sub, client_id, jkt, label, status, created_at, last_used_at, last_refreshed_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(deviceId, sub, clientId, jkt, label || clientId, nowSec, nowSec, nowSec);
    return { ok: true, deviceId };
  }

  function issueDpopGrant({
    sub,
    clientId,
    jkt,
    label,
    scope,
    resource,
    issuer,
    refreshToken,
    family,
    nowSec,
    refreshTtlS,
    inactivityTtlS,
  }) {
    return withImmediateTx(() => {
      const dev = ensureActiveDeviceTx({ sub, clientId, jkt, label, nowSec });
      if (!dev.ok) return dev;
      const exp = nowSec + refreshTtlS;
      const inactivityExp = Math.min(exp, nowSec + inactivityTtlS);
      db.prepare(
        `INSERT INTO jc_refresh_tokens
         (token_hash, family, device_id, client_id, sub, cnf_jkt, scope, resource, issuer, exp, inactivity_exp, active, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
      ).run(
        sha256B64u(refreshToken),
        family,
        dev.deviceId,
        clientId,
        sub,
        jkt,
        scope,
        resource,
        issuer,
        exp,
        inactivityExp,
      );
      return { ok: true, deviceId: dev.deviceId, refreshExpiresAt: exp };
    });
  }

  function rotateDpopRefresh({
    presentedRefreshToken,
    presentedClientId,
    dpopJkt,
    refreshRequestId,
    expectedResource,
    expectedIssuer,
    nowSec,
    inactivityTtlS,
    recoveryTtlS = 120,
    mintTokens,
  }) {
    const oldHash = sha256B64u(presentedRefreshToken);
    return withImmediateTx(() => {
      const row = db.prepare('SELECT * FROM jc_refresh_tokens WHERE token_hash = ?').get(oldHash);
      if (!row) return { ok: false, reason: 'refresh_unknown' };
      if (presentedClientId && presentedClientId !== row.client_id) {
        return { ok: false, reason: 'client_mismatch' };
      }
      if (
        (expectedResource && row.resource !== expectedResource) ||
        (expectedIssuer && row.issuer !== expectedIssuer)
      ) {
        return { ok: false, reason: 'invalid_target', clientId: row.client_id, family: row.family };
      }

      const revokeFamily = () => {
        db.prepare('UPDATE jc_refresh_tokens SET revoked = 1, active = 0, recovery_blob = NULL WHERE family = ?').run(
          row.family,
        );
        if (row.device_id) {
          db.prepare("UPDATE jc_devices SET status = 'revoked', revoked_at = ? WHERE device_id = ?").run(
            nowSec,
            row.device_id,
          );
        }
      };

      if (row.device_id && isDeviceOrJktRevoked(row.device_id, row.cnf_jkt)) {
        revokeFamily();
        return { ok: false, reason: 'revoked', clientId: row.client_id, family: row.family };
      }
      if (row.revoked) {
        return { ok: false, reason: 'revoked', clientId: row.client_id, family: row.family };
      }
      if (dpopJkt !== row.cnf_jkt) {
        revokeFamily();
        return { ok: false, reason: 'refresh_reused', clientId: row.client_id, family: row.family };
      }
      if (row.active === 1) {
        if (nowSec > row.exp || nowSec > row.inactivity_exp) {
          return { ok: false, reason: 'refresh_expired', clientId: row.client_id, family: row.family };
        }
        const minted = mintTokens({
          sub: row.sub,
          client_id: row.client_id,
          scope: row.scope,
          resource: row.resource,
          issuer: row.issuer,
          cnf_jkt: row.cnf_jkt,
          device_id: row.device_id,
          family: row.family,
        });
        const newHash = sha256B64u(minted.refresh_token);
        const newInactivityExp = Math.min(row.exp, nowSec + inactivityTtlS);
        db.prepare(
          `INSERT INTO jc_refresh_tokens
           (token_hash, family, device_id, client_id, sub, cnf_jkt, scope, resource, issuer, exp, inactivity_exp, active, revoked)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
        ).run(
          newHash,
          row.family,
          row.device_id,
          row.client_id,
          row.sub,
          row.cnf_jkt,
          row.scope,
          row.resource,
          row.issuer,
          row.exp,
          newInactivityExp,
        );

        let recoveryBlob = null;
        let recoveryExpiresAt = null;
        const reqId =
          typeof refreshRequestId === 'string' && refreshRequestId.length > 0 && refreshRequestId.length <= 128
            ? refreshRequestId
            : null;
        if (reqId) {
          const aad = recoveryAad({
            deviceId: row.device_id,
            family: row.family,
            cnfJkt: row.cnf_jkt,
            oldTokenHash: oldHash,
            requestId: reqId,
          });
          recoveryBlob = encryptRecovery(recKey, aad, minted.response);
          recoveryExpiresAt = nowSec + recoveryTtlS;
        }
        db.prepare(
          `UPDATE jc_refresh_tokens
           SET active = 0, rotated_at = ?, used_request_id = ?, successor_hash = ?, recovery_blob = ?, recovery_expires_at = ?
           WHERE token_hash = ?`,
        ).run(nowSec, reqId, newHash, recoveryBlob, recoveryExpiresAt, oldHash);

        if (row.device_id) {
          db.prepare('UPDATE jc_devices SET last_refreshed_at = ?, last_used_at = ? WHERE device_id = ?').run(
            nowSec,
            nowSec,
            row.device_id,
          );
        }
        return { ok: true, response: minted.response, refreshExpiresAt: row.exp, clientId: row.client_id, family: row.family, recovered: false };
      }

      // Already consumed: check encrypted crash-recovery envelope
      const reqId =
        typeof refreshRequestId === 'string' && refreshRequestId.length > 0 && refreshRequestId.length <= 128
          ? refreshRequestId
          : null;
      const successor = row.successor_hash
        ? db.prepare('SELECT active, revoked FROM jc_refresh_tokens WHERE token_hash = ?').get(row.successor_hash)
        : null;
      if (
        reqId &&
        row.used_request_id === reqId &&
        row.recovery_expires_at !== null &&
        nowSec <= row.recovery_expires_at &&
        nowSec <= row.exp &&
        row.recovery_blob &&
        successor &&
        successor.active === 1 &&
        successor.revoked === 0
      ) {
        try {
          const aad = recoveryAad({
            deviceId: row.device_id,
            family: row.family,
            cnfJkt: row.cnf_jkt,
            oldTokenHash: oldHash,
            requestId: reqId,
          });
          const recovered = decryptRecovery(recKey, aad, row.recovery_blob);
          return { ok: true, response: recovered, refreshExpiresAt: row.exp, clientId: row.client_id, family: row.family, recovered: true };
        } catch {
          revokeFamily();
          return { ok: false, reason: 'refresh_reused', clientId: row.client_id, family: row.family };
        }
      }

      revokeFamily();
      return { ok: false, reason: 'refresh_reused', clientId: row.client_id, family: row.family };
    });
  }

  function hasRefreshToken(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken) return false;
    const row = db
      .prepare('SELECT 1 AS hit FROM jc_refresh_tokens WHERE token_hash = ? LIMIT 1')
      .get(sha256B64u(refreshToken));
    return Boolean(row);
  }

  function createDeviceCode({
    deviceCode,
    userCode,
    clientId,
    scope,
    resource,
    issuer,
    dpopJkt,
    deviceName,
    intervalS,
    expiresAt,
    nowSec,
  }) {
    db.prepare(
      `INSERT INTO jc_device_codes
       (device_code_hash, user_code_hash, client_id, scope, resource, issuer, dpop_jkt, device_name, status, interval_s, last_poll_ms, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)`,
    ).run(
      sha256B64u(deviceCode),
      sha256B64u(normalizeUserCode(userCode)),
      clientId,
      scope,
      resource,
      issuer,
      dpopJkt || null,
      deviceName || null,
      intervalS,
      expiresAt,
      nowSec,
    );
  }

  function decideDeviceCode({ userCode, decision, sub, nowSec }) {
    const hash = sha256B64u(normalizeUserCode(userCode));
    return withImmediateTx(() => {
      const row = db.prepare('SELECT * FROM jc_device_codes WHERE user_code_hash = ?').get(hash);
      if (!row || row.expires_at < nowSec || row.status !== 'pending') {
        return { ok: false };
      }
      const nextStatus = decision === 'deny' ? 'denied' : 'approved';
      db.prepare('UPDATE jc_device_codes SET status = ?, sub = ? WHERE device_code_hash = ?').run(
        nextStatus,
        nextStatus === 'approved' ? sub : null,
        row.device_code_hash,
      );
      return { ok: true, status: nextStatus, clientId: row.client_id, scope: row.scope };
    });
  }

  function pollDeviceCode({ deviceCode, clientId, dpopJkt, nowMs = Date.now() }) {
    const nowSec = Math.floor(nowMs / 1000);
    const hash = sha256B64u(deviceCode);
    return withImmediateTx(() => {
      const row = db.prepare('SELECT * FROM jc_device_codes WHERE device_code_hash = ?').get(hash);
      if (!row) return { ok: false, error: 'invalid_grant' };
      if (row.client_id !== clientId) return { ok: false, error: 'invalid_grant' };
      if (row.status === 'consumed') return { ok: false, error: 'invalid_grant' };
      if (row.expires_at < nowSec) return { ok: false, error: 'expired_token' };
      if (row.status === 'denied') {
        db.prepare("UPDATE jc_device_codes SET status = 'consumed' WHERE device_code_hash = ?").run(hash);
        return { ok: false, error: 'access_denied' };
      }

      if (row.status === 'pending' && row.last_poll_ms > 0 && nowMs - row.last_poll_ms < row.interval_s * 1000) {
        const nextInterval = row.interval_s + 5;
        db.prepare('UPDATE jc_device_codes SET interval_s = ?, last_poll_ms = ? WHERE device_code_hash = ?').run(
          nextInterval,
          nowMs,
          hash,
        );
        return { ok: false, error: 'slow_down', interval: nextInterval };
      }

      db.prepare('UPDATE jc_device_codes SET last_poll_ms = ? WHERE device_code_hash = ?').run(nowMs, hash);

      if (row.status === 'pending') {
        return { ok: false, error: 'authorization_pending' };
      }
      if (row.status !== 'approved') {
        return { ok: false, error: 'invalid_grant' };
      }
      if (row.dpop_jkt && row.dpop_jkt !== dpopJkt) {
        return { ok: false, error: 'invalid_grant', description: 'dpop_jkt mismatch' };
      }

      const revoked = db
        .prepare("SELECT 1 AS hit FROM jc_devices WHERE jkt = ? AND status = 'revoked' LIMIT 1")
        .get(dpopJkt);
      if (revoked) {
        return { ok: false, error: 'invalid_grant', description: 'device has been revoked' };
      }

      db.prepare("UPDATE jc_device_codes SET status = 'consumed' WHERE device_code_hash = ?").run(hash);
      return {
        ok: true,
        sub: row.sub || 'jacen',
        client_id: row.client_id,
        scope: row.scope,
        resource: row.resource,
        issuer: row.issuer,
        device_name: row.device_name,
      };
    });
  }

  function listDevices(sub) {
    const rows = db
      .prepare(
        `SELECT device_id, client_id, jkt, label, created_at, last_used_at, last_refreshed_at, status
         FROM jc_devices WHERE sub = ? ORDER BY created_at DESC`,
      )
      .all(sub);
    return rows.map((r) => ({
      device_id: r.device_id,
      client_id: r.client_id,
      jkt: r.jkt,
      label: r.label,
      created_at: isoFromSec(r.created_at),
      last_used_at: isoFromSec(r.last_used_at),
      last_refreshed_at: isoFromSec(r.last_refreshed_at),
      status: r.status,
    }));
  }

  function touchDevice(deviceId, nowSec) {
    if (!deviceId) return;
    db.prepare('UPDATE jc_devices SET last_used_at = ? WHERE device_id = ? AND last_used_at < ?').run(
      nowSec,
      deviceId,
      nowSec - 30,
    );
  }

  function revokeDevice(deviceId, sub, nowSec) {
    return withImmediateTx(() => {
      const dev = db.prepare('SELECT device_id, sub FROM jc_devices WHERE device_id = ?').get(deviceId);
      if (!dev || dev.sub !== sub) return { found: false };
      db.prepare("UPDATE jc_devices SET status = 'revoked', revoked_at = ? WHERE device_id = ?").run(
        nowSec,
        deviceId,
      );
      db.prepare(
        'UPDATE jc_refresh_tokens SET revoked = 1, active = 0, recovery_blob = NULL WHERE device_id = ?',
      ).run(deviceId);
      return { found: true, deviceId };
    });
  }

  return {
    consumeJti,
    saveAuthCode,
    peekAuthCode,
    consumeAuthCode,
    isDeviceOrJktRevoked,
    issueDpopGrant,
    rotateDpopRefresh,
    hasRefreshToken,
    createDeviceCode,
    decideDeviceCode,
    pollDeviceCode,
    listDevices,
    touchDevice,
    revokeDevice,
    close: () => db.close(),
  };
}
