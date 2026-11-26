#!/usr/bin/env node
// Captures the jace-auth production-issuer negative proofs N1 and N2 against a local, isolated gateway.
//
// - Starts apps/gateway/src/index.ts under NODE_ENV=production and ACS_STRICT_CONFIG=1 with the frozen
//   jace-auth preset, a disposable credential and a temporary database. Only loopback sockets are used.
// - Run A uses the exact documented production configuration (real JWKS URI).
// - Run B is identical except ACS_OAUTH_JWKS_URI points at a logging relay. The relay forwards
//   GET /jwks to the production JWKS unchanged and records what it returned, so the gateway's JWKS
//   fetch is observed, not assumed.
// - N2 uses a valid-shaped RS256 JWT with jace-auth iss/aud/exp, the production key id, and a signature
//   made by a key that exists only in this process's memory. That key is never written anywhere.
// - A separate verifier re-runs the same token through jose against the production JWKS, to pin the
//   rejection to the signature stage (ERR_JWS_SIGNATURE_VERIFICATION_FAILED).
// - Writes sanitized artifacts. Nothing secret is recorded: the disposable credential is redacted, the
//   private key is never serialized, and the gateway environment is never dumped.
//
// Usage: node scripts/jace-auth-negative-proofs.mjs --out <dir>
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as jose from "jose";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outArg = process.argv.indexOf("--out");
const OUT = resolve(outArg >= 0 ? process.argv[outArg + 1] : join(ROOT, "docs/evidence/jace-auth-negative-proofs"));

const ISSUER = "https://jace-auth.vercel.app";
const AUDIENCE = "https://jace-auth.vercel.app/resources/agent-control-stack";
const PROD_JWKS = "https://jace-auth.vercel.app/jwks";
const GATEWAY_PORT = 3010;
const RELAY_PORT = 3011;
// The gateway's own metadata URL. The validator requires https and a non-issuer origin, so the host
// is a reserved placeholder. Only the advertised value is checked. Nothing is resolved from it.
const METADATA_URL = "https://gateway.drill.example/.well-known/oauth-protected-resource/mcp";
const ALLOWED_ORIGIN = "https://gateway.drill.example";

const CREDENTIAL_TOKEN = randomBytes(24).toString("hex"); // 48 hex characters, disposable, per run.
const started = new Date().toISOString();

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function redact(text) {
  return text.split(CREDENTIAL_TOKEN).join("[REDACTED_DISPOSABLE_CREDENTIAL]");
}

function codeHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function jaceAuthProvenance() {
  const dir = "/home/jacen/projects/jace-auth";
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--short"], { cwd: dir, encoding: "utf8" }).trim();
    return { commit: sha, workingTreeDirty: dirty.length > 0 };
  } catch {
    return { commit: null, workingTreeDirty: null };
  }
}

async function fetchProductionJwks() {
  const response = await fetch(PROD_JWKS);
  const body = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body,
    sha256: sha256(body),
    keys: JSON.parse(body).keys.map((key) => ({ kid: key.kid, kty: key.kty, alg: key.alg, use: key.use }))
  };
}

function startRelay(log) {
  const server = createServer(async (request, response) => {
    const entry = { at: new Date().toISOString(), method: request.method, path: request.url };
    if (request.method !== "GET" || request.url !== "/jwks") {
      entry.note = "not forwarded";
      log.push(entry);
      response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
      return;
    }
    const upstream = await fetch(PROD_JWKS);
    const body = await upstream.text();
    entry.upstreamStatus = upstream.status;
    entry.bodySha256 = sha256(body);
    log.push(entry);
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(body);
  });
  return new Promise((resolveStart) => server.listen(RELAY_PORT, "127.0.0.1", () => resolveStart(server)));
}

function gatewayEnv(tempDir, jwksUri) {
  return {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    ACS_STRICT_CONFIG: "1",
    HOST: "127.0.0.1",
    PORT: String(GATEWAY_PORT),
    ACS_DB_PATH: join(tempDir, "control.db"),
    ACS_GATEWAY_CREDENTIALS_JSON: JSON.stringify([
      {
        id: "drill-1",
        token: CREDENTIAL_TOKEN,
        actor: "operator",
        actorId: "drill-1",
        roles: ["operator"],
        scopes: ["acs:read"]
      }
    ]),
    ACS_MCP_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    ACS_OAUTH_ISSUER: ISSUER,
    ACS_OAUTH_AUDIENCE: AUDIENCE,
    ACS_OAUTH_JWKS_URI: jwksUri,
    ACS_MCP_RESOURCE_METADATA_URL: METADATA_URL
  };
}

async function waitForGateway(child, logLines) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited early with code ${child.exitCode}: ${redact(logLines.join("")).slice(-800)}`);
    }
    try {
      await fetch(`http://127.0.0.1:${GATEWAY_PORT}/mcp`, { method: "GET" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("gateway did not listen within 90s");
}

function startGateway(tempDir, jwksUri) {
  const logLines = [];
  const child = spawn(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "apps/gateway/src/index.ts")], {
    cwd: ROOT,
    env: gatewayEnv(tempDir, jwksUri),
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logLines.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logLines.push(chunk.toString()));
  return { child, logLines };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "negative-proof", version: "1" } }
};

async function postInitialize(headers) {
  const body = JSON.stringify(INITIALIZE);
  const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body
  });
  const text = await response.text();
  return {
    status: response.status,
    wwwAuthenticate: response.headers.get("www-authenticate"),
    contentType: response.headers.get("content-type"),
    body: text.slice(0, 600)
  };
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), "acs-jace-auth-proof-"));
  const provenance = {
    acsCodeCommit: codeHead(),
    jaceAuth: jaceAuthProvenance(),
    startedAt: started,
    gatewayUrl: `http://127.0.0.1:${GATEWAY_PORT}`,
    productionJwks: PROD_JWKS,
    issuer: ISSUER,
    audience: AUDIENCE,
    metadataUrlConfigured: METADATA_URL
  };

  const jwks = await fetchProductionJwks();
  // RSA signing key with alg RS256, or no alg field (the production set omits use and alg on some keys).
  const productionKid = jwks.keys.find(
    (key) => key.kty === "RSA" && (key.alg === "RS256" || key.alg === undefined)
  )?.kid;
  if (!productionKid) throw new Error("production JWKS has no RS256 signing key");

  // The forged token. Its key pair is in memory only.
  const { privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "forged-subject-negative-proof",
    client_id: "forged-client-negative-proof",
    scope: "acs:work:read acs:work:create",
    iat: now,
    exp: now + 300
  };
  const forged = await new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: productionKid })
    .sign(privateKey);
  const [headerSegment, payloadSegment, signatureSegment] = forged.split(".");
  const tokenSummary = {
    header: decodeSegment(headerSegment),
    claims: decodeSegment(payloadSegment),
    signatureBytesBase64urlLength: signatureSegment.length,
    note: "Disposable forged token. Signed by a key that exists only in memory during this run."
  };

  // Stage proof: the same token through jose, the library the gateway uses, against the production JWKS.
  const remote = jose.createRemoteJWKSet(new URL(PROD_JWKS));
  let signatureStage;
  try {
    await jose.jwtVerify(forged, remote, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["RS256", "PS256"],
      currentDate: new Date()
    });
    signatureStage = { result: "accepted", note: "unexpected: forged token verified" };
  } catch (error) {
    signatureStage = { result: "rejected", code: error.code ?? null, name: error.name, message: error.message };
  }
  // Control: the same claims with a kid absent from the production set, so kid matching is what fails.
  const unknownKid = await new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "not-in-production-jwks" })
    .sign(privateKey);
  let kidControl;
  try {
    await jose.jwtVerify(unknownKid, remote, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["RS256", "PS256"] });
    kidControl = { result: "accepted" };
  } catch (error) {
    kidControl = { result: "rejected", code: error.code ?? null };
  }

  const runs = {};
  const relayLog = [];
  const relay = await startRelay(relayLog);

  async function runGateway(label, jwksUri) {
    const { child, logLines } = startGateway(tempDir, jwksUri);
    try {
      await waitForGateway(child, logLines);
      const metadata = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/.well-known/oauth-protected-resource/mcp`);
      const metadataBody = await metadata.text();
      const n0 = { status: metadata.status, body: metadataBody.slice(0, 800) };
      const n1 = await postInitialize({});
      const n2 = await postInitialize({ authorization: `Bearer ${forged}` });
      runs[label] = { jwksUri, n0MetadataEndpoint: n0, n1NoBearer: n1, n2ForgedToken: n2 };
      writeFileSync(join(OUT, `gateway-log-${label}.redacted.txt`), redact(logLines.join("")).slice(-20000));
    } finally {
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }

  try {
    await runGateway("runA-documented-production-jwks-uri", PROD_JWKS);
    await runGateway("runB-relayed-production-jwks", `http://127.0.0.1:${RELAY_PORT}/jwks`);
  } finally {
    relay.close();
  }

  const relayFetches = relayLog.filter((entry) => entry.upstreamStatus !== undefined);
  const relayMatchesProduction =
    relayFetches.length > 0 && relayFetches.every((entry) => entry.bodySha256 === jwks.sha256);

  const n1 = runs["runA-documented-production-jwks-uri"].n1NoBearer;
  const n1Pass =
    n1.status === 401 &&
    n1.body.includes("missing_token") &&
    n1.wwwAuthenticate !== null &&
    n1.wwwAuthenticate.includes(METADATA_URL) &&
    !n1.wwwAuthenticate.includes(`${ISSUER}/.well-known/oauth-protected-resource`);
  const n2 = runs["runA-documented-production-jwks-uri"].n2ForgedToken;
  const n2RunB = runs["runB-relayed-production-jwks"].n2ForgedToken;
  const stageRejected =
    signatureStage.result === "rejected" && signatureStage.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  const n2Pass =
    n2.status === 401 &&
    n2.body.includes("invalid_token") &&
    n2RunB.status === 401 &&
    relayMatchesProduction &&
    stageRejected;

  const summary = {
    ...provenance,
    finishedAt: new Date().toISOString(),
    productionJwks: { ...jwks, body: undefined, rs256Kid: productionKid },
    forgedToken: tokenSummary,
    signatureStage,
    kidControl,
    relay: { fetches: relayFetches.length, allMatchProduction: relayMatchesProduction, log: relayLog },
    runs,
    verdicts: {
      N0_metadata_endpoint_served:
        runs["runA-documented-production-jwks-uri"].n0MetadataEndpoint.status === 200 ? "PASS" : "FAIL",
      N1_no_bearer_advertises_gateway_metadata: n1Pass ? "PASS" : "FAIL",
      N2_forged_token_rejected_at_signature_against_production_jwks: n2Pass ? "PASS" : "UNVERIFIED",
      N2_rejection_stage_detail: stageRejected ? "signature" : "not established"
    }
  };
  writeFileSync(join(OUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    join(OUT, "jwks-production.public.json"),
    `${JSON.stringify({ sha256: jwks.sha256, keys: jwks.keys }, null, 2)}\n`
  );
  rmSync(tempDir, { recursive: true, force: true });
  console.log(JSON.stringify(summary.verdicts, null, 2));
}

main().catch((error) => {
  console.error(redact(String(error?.stack ?? error)));
  process.exit(1);
});
