import { describe, expect, it, vi } from "vitest";
import { pollForToken, requestDeviceCode } from "./device-flow.js";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("requestDeviceCode", () => {
  it("posts form-urlencoded and parses the device code response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        device_code: "raw-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://acs.example.com/device/verify",
        verification_uri_complete: "https://acs.example.com/device/verify?user_code=ABCD-EFGH",
        expires_in: 900,
        interval: 5
      })
    );
    const result = await requestDeviceCode("https://acs.example.com", "acs-cli", "PEM", "workstation", ["acs:device"], {
      fetchImpl
    });
    expect(result.deviceCode).toBe("raw-code");
    expect(result.interval).toBe(5);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://acs.example.com/oauth/device/code");
    expect(init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(String(init.body)).toContain("client_id=acs-cli");
  });

  it("throws with the server's error code on failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid_client" }));
    await expect(
      requestDeviceCode("https://acs.example.com", "bad-client", "PEM", "workstation", [], { fetchImpl })
    ).rejects.toThrow(/invalid_client/);
  });
});

describe("pollForToken", () => {
  const code = {
    deviceCode: "dc",
    userCode: "uc",
    verificationUri: "https://acs.example.com/device/verify",
    verificationUriComplete: "https://acs.example.com/device/verify?user_code=uc",
    expiresIn: 60,
    interval: 5
  };

  it("never busy-loops: sleeps before every poll attempt", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: "authorization_pending" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: "acs:device",
          device_id: "dev_1",
          principal: "operator-1"
        })
      );
    const outcome = await pollForToken("https://acs.example.com", "acs-cli", code, { fetchImpl, sleepImpl });
    expect(outcome).toEqual({
      status: "success",
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3600,
      scope: "acs:device",
      deviceId: "dev_1",
      principal: "operator-1"
    });
    expect(sleepImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 5000);
  });

  it("increases the interval on slow_down and keeps polling", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: "slow_down" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: "",
          device_id: "dev_1",
          principal: "operator-1"
        })
      );
    await pollForToken("https://acs.example.com", "acs-cli", code, { fetchImpl, sleepImpl });
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 5000);
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 10000);
  });

  it("stops immediately on access_denied", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "access_denied" }));
    const outcome = await pollForToken("https://acs.example.com", "acs-cli", code, { fetchImpl, sleepImpl });
    expect(outcome).toEqual({ status: "denied" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops on expired_token", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "expired_token" }));
    const outcome = await pollForToken("https://acs.example.com", "acs-cli", code, { fetchImpl, sleepImpl });
    expect(outcome).toEqual({ status: "expired" });
  });

  it("surfaces an unrecognized server error without retrying forever", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));
    const outcome = await pollForToken("https://acs.example.com", "acs-cli", code, { fetchImpl, sleepImpl });
    expect(outcome).toEqual({ status: "error", error: "invalid_grant" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
