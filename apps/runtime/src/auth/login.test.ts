import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCredentials } from "./credential-store.js";
import { runLogin } from "./login.js";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("runLogin", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function path(): string {
    dir = mkdtempSync(join(tmpdir(), "acs-cli-login-"));
    return join(dir, "credentials.json");
  }

  it("prints the verification URL and code, never opens a browser without permission being asked, and persists the session on success", async () => {
    const file = path();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "raw-device-code",
          user_code: "WXYZ-1234",
          verification_uri: "https://acs.example.com/device/verify",
          verification_uri_complete: "https://acs.example.com/device/verify?user_code=WXYZ-1234",
          expires_in: 900,
          interval: 5
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: "acs:device",
          device_id: "dev_abc",
          principal: "operator-1"
        })
      );
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const lines: string[] = [];
    const openedUrls: string[] = [];

    const result = await runLogin({
      acsUrl: "https://acs.example.com",
      credentialsPathOverride: file,
      deps: { fetchImpl, sleepImpl },
      print: (line) => lines.push(line),
      openBrowserImpl: (url) => openedUrls.push(url)
    });

    expect(result).toEqual({
      ok: true,
      deviceId: "dev_abc",
      principal: "operator-1",
      acsUrl: "https://acs.example.com"
    });
    const output = lines.join("\n");
    expect(output).toContain("WXYZ-1234");
    expect(output).toContain("https://acs.example.com/device/verify?user_code=WXYZ-1234");
    expect(output).not.toContain("raw-device-code"); // never print the raw device_code secret
    expect(openedUrls).toEqual(["https://acs.example.com/device/verify?user_code=WXYZ-1234"]);

    const stored = readCredentials(file);
    expect(stored?.session?.deviceId).toBe("dev_abc");
    expect(stored?.session?.accessToken).toBe("at");
  });

  it("does not open a browser when openBrowser is false", async () => {
    const file = path();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "dc",
          user_code: "uc",
          verification_uri: "https://acs.example.com/device/verify",
          verification_uri_complete: "https://acs.example.com/device/verify?user_code=uc",
          expires_in: 900,
          interval: 5
        })
      )
      .mockResolvedValueOnce(jsonResponse(400, { error: "expired_token" }));
    const openedUrls: string[] = [];
    await runLogin({
      acsUrl: "https://acs.example.com",
      credentialsPathOverride: file,
      openBrowser: false,
      deps: { fetchImpl, sleepImpl: vi.fn().mockResolvedValue(undefined) },
      print: () => {},
      openBrowserImpl: (url) => openedUrls.push(url)
    });
    expect(openedUrls).toEqual([]);
  });

  it("reports denial without writing a session", async () => {
    const file = path();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "dc",
          user_code: "uc",
          verification_uri: "https://acs.example.com/device/verify",
          verification_uri_complete: "https://acs.example.com/device/verify?user_code=uc",
          expires_in: 900,
          interval: 5
        })
      )
      .mockResolvedValueOnce(jsonResponse(400, { error: "access_denied" }));
    const result = await runLogin({
      acsUrl: "https://acs.example.com",
      credentialsPathOverride: file,
      deps: { fetchImpl, sleepImpl: vi.fn().mockResolvedValue(undefined) },
      print: () => {},
      openBrowserImpl: () => {}
    });
    expect(result).toEqual({ ok: false, reason: "denied" });
    expect(readCredentials(file)?.session).toBeUndefined();
  });
});
