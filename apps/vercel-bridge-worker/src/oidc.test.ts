import { describe, expect, it, vi } from "vitest";
import { ProjectOidcTokenProvider } from "./oidc.js";

function jwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.`;
}

describe("Vercel project OIDC provider", () => {
  it("mints a project token through the Vercel REST API", async () => {
    const token = jwt(2_000_000_000);
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ token }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const provider = new ProjectOidcTokenProvider({
      vercelAccessToken: "vcp_test_secret",
      projectIdOrName: "acs ingress",
      teamId: "team_123",
      fetchFn,
      now: () => 1_000
    });

    await expect(provider.getToken()).resolves.toBe(token);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://api.vercel.com/v1/projects/acs%20ingress/token?teamId=team_123");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer vcp_test_secret",
      "Content-Type": "application/json"
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      source: "acs-vercel-bridge"
    });
  });
  it("reuses a token while it is outside the refresh window", async () => {
    const token = jwt(10_000);
    const fetchFn = vi.fn(async () => Response.json({ token }));
    let now = 1_000_000;
    const provider = new ProjectOidcTokenProvider({
      vercelAccessToken: "vcp_test_secret",
      projectIdOrName: "acs",
      fetchFn,
      now: () => now,
      refreshSkewMs: 60_000
    });

    expect(await provider.getToken()).toBe(token);
    now += 1_000;
    expect(await provider.getToken()).toBe(token);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the cached token is near expiry", async () => {
    const first = jwt(100);
    const second = jwt(1_000);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token: first }))
      .mockResolvedValueOnce(Response.json({ token: second }));
    let now = 30_000;
    const provider = new ProjectOidcTokenProvider({
      vercelAccessToken: "vcp_test_secret",
      projectIdOrName: "acs",
      fetchFn,
      now: () => now,
      refreshSkewMs: 60_000
    });

    expect(await provider.getToken()).toBe(first);
    now = 50_000;
    expect(await provider.getToken()).toBe(second);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("fails without exposing response bodies or credentials", async () => {
    const fetchFn = vi.fn(async () => new Response("vcp_leaked_from_server", { status: 403 }));
    const provider = new ProjectOidcTokenProvider({
      vercelAccessToken: "vcp_local_secret",
      projectIdOrName: "acs",
      fetchFn
    });

    let message = "";
    try {
      await provider.getToken();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("403");
    expect(message).not.toContain("vcp_local_secret");
    expect(message).not.toContain("vcp_leaked_from_server");
  });

  it("rejects malformed token responses", async () => {
    const provider = new ProjectOidcTokenProvider({
      vercelAccessToken: "vcp_test_secret",
      projectIdOrName: "acs",
      fetchFn: vi.fn(async () => Response.json({ token: "" }))
    });

    await expect(provider.getToken()).rejects.toThrow("invalid project OIDC token");
  });
});
