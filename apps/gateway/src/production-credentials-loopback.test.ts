import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionConfigError } from "./production-config.js";
import { startGateway } from "./server.js";

const credential = {
  id: "synthetic-operator",
  token: "synthetic-production-token-0123456789abcdef",
  actor: "user",
  actorId: "synthetic-human",
  roles: ["operator"],
  scopes: ["acs:read", "acs:write"]
};
let directory: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function configure(credentials: unknown, port: string) {
  // Only this test process is changed; no host credentials or service configuration is loaded.
  for (const key of Object.keys(process.env)) if (key.startsWith("ACS_")) vi.stubEnv(key, undefined);
  directory = mkdtempSync(join(tmpdir(), "acs-production-boot-"));
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("HOST", "127.0.0.1");
  vi.stubEnv("PORT", port);
  vi.stubEnv("ACS_DB_PATH", join(directory, "control.db"));
  vi.stubEnv("ACS_GATEWAY_CREDENTIALS_JSON", JSON.stringify(credentials));
}

async function unusedPort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
  if (!address || typeof address === "string") throw new Error("expected a loopback TCP port");
  return address.port;
}

async function status(port: number, path: string, token?: string) {
  return await new Promise<number>((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, agent: false, headers: token ? { authorization: `Bearer ${token}` } : {} },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.setTimeout(5_000, () => req.destroy(new Error("production fixture HTTP timeout")));
    req.on("error", reject);
    req.end();
  });
}

describe("production credential boot contract", () => {
  it.each([
    ["missing roles", [{ ...credential, roles: undefined }]],
    ["missing scopes", [{ ...credential, scopes: undefined }]],
    ["duplicate ids", [credential, { ...credential, token: credential.token + "2" }]],
    ["invalid expiry", [{ ...credential, expiresAt: "tomorrow" }]],
    ["invalid status", [{ ...credential, status: "paused" }]]
  ])("rejects %s in structured preflight before listener configuration", async (_name, credentials) => {
    // An invalid port proves credential rejection happens before listen configuration, without opening a socket.
    configure(credentials, "not-a-port");
    await expect(startGateway()).rejects.toBeInstanceOf(ProductionConfigError);
  });

  it("boots valid production credentials on disposable loopback and enforces authentication", async () => {
    const port = await unusedPort();
    configure([credential], String(port));
    const app = await startGateway();
    try {
      expect(await status(port, "/healthz")).toBe(200);
      expect(await status(port, "/readyz")).toBe(200);
      expect(await status(port, "/work-items")).toBe(401);
      expect(await status(port, "/work-items", "synthetic-wrong-token-0123456789abcdef")).toBe(401);
      expect(await status(port, "/work-items", credential.token)).toBe(200);
    } finally {
      await app.close();
    }
  });
});
