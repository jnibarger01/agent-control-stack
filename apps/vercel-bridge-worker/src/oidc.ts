export interface ProjectOidcTokenProviderOptions {
  vercelAccessToken: string;
  projectIdOrName: string;
  teamId?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  refreshSkewMs?: number;
}

export class ProjectOidcTokenProvider {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private cached?: { token: string; expiresAtMs: number };

  constructor(private readonly options: ProjectOidcTokenProviderOptions) {
    if (!options.vercelAccessToken) {
      throw new Error("Vercel access token is required");
    }
    if (!options.projectIdOrName) {
      throw new Error("Vercel project id or name is required");
    }
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.refreshSkewMs > this.now()) {
      return this.cached.token;
    }

    const token = await this.mint();
    const expiresAtMs = jwtExpiryMs(token);
    if (expiresAtMs === undefined) {
      throw new Error("invalid project OIDC token");
    }
    this.cached = { token, expiresAtMs };
    return token;
  }
  invalidate(): void {
    this.cached = undefined;
  }

  private async mint(): Promise<string> {
    const url = new URL(`https://api.vercel.com/v1/projects/${encodeURIComponent(this.options.projectIdOrName)}/token`);
    if (this.options.teamId) {
      url.searchParams.set("teamId", this.options.teamId);
    }

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.vercelAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ source: "acs-vercel-bridge" })
    });
    if (!response.ok) {
      throw new Error(`Vercel project OIDC request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { token?: unknown };
    if (typeof payload.token !== "string" || payload.token.length < 16) {
      throw new Error("invalid project OIDC token");
    }
    return payload.token;
  }
}

function jwtExpiryMs(token: string): number | undefined {
  try {
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0
      ? payload.exp * 1_000
      : undefined;
  } catch {
    return undefined;
  }
}
