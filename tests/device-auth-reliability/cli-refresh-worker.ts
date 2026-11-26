import { createHash } from "node:crypto";
import { refreshSession } from "../../apps/runtime/src/auth/refresh.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const killBeforePersist = process.env.ACS_TEST_KILL_BEFORE_PERSIST === "1";

const result = await refreshSession({
  env: process.env,
  fetchImpl: killBeforePersist
    ? async (input, init) => {
        const response = await fetch(input, init);
        await response.text();
        process.kill(process.pid, "SIGKILL");
        return response;
      }
    : undefined
});

process.stdout.write(
  JSON.stringify({
    ok: true,
    refreshed: result.refreshed,
    deviceId: result.session.deviceId,
    accessTokenHash: sha256Hex(result.session.accessToken),
    refreshTokenHash: sha256Hex(result.session.refreshToken),
    accessTokenExpiresAt: result.session.accessTokenExpiresAt
  }) + "\n"
);
