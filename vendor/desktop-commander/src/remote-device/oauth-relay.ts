/**
 * Own-relay ("supabase_oauth_pkce") mode.
 *
 * Selected only when the control plane's /api/mcp-info advertises the exact
 * own-relay contract. Every other response keeps the DC-cloud behavior. In this
 * mode the device holds its own Supabase OAuth 2.1 tokens (issued to the public
 * client `oauthClientId`), so refreshes go to /auth/v1/oauth/token with
 * client_id and the refresh token rotates on every use.
 */

export type RemoteAuthMode = 'dc_cloud' | 'supabase_oauth_pkce';

export interface OAuthRelaySettings {
    supabaseUrl: string;
    anonKey: string;
    clientId: string;
    redirectUri: string;
    /** Absolute URL of the plane's device registration endpoint. */
    registrationUrl: string;
}

export interface RemoteConfig {
    supabaseUrl: string;
    anonKey: string;
    mode: RemoteAuthMode;
    /** Present only in supabase_oauth_pkce mode. */
    oauth?: OAuthRelaySettings;
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

/** D2: parse /api/mcp-info. OAuth-relay mode requires all three gate fields. */
export function parseMcpInfo(info: any, baseServerUrl: string): RemoteConfig {
    const supabaseUrl = info?.supabaseUrl;
    const anonKey = info?.supabasePublishableKey;
    const isRelay = info?.deviceAuthMode === 'supabase_oauth_pkce'
        && info?.controlPlaneVersion === 1
        && nonEmptyString(info?.oauthClientId);
    if (!isRelay) return { supabaseUrl, anonKey, mode: 'dc_cloud' };

    if (!nonEmptyString(supabaseUrl) || !nonEmptyString(anonKey)) {
        throw new Error('Own-relay mcp-info is missing supabaseUrl or supabasePublishableKey');
    }
    const base = baseServerUrl.replace(/\/$/, '');
    const redirectUri = nonEmptyString(info.oauthRedirectUri) ? info.oauthRedirectUri : `${base}/device/callback`;
    const registration = nonEmptyString(info.deviceRegistrationEndpoint) ? info.deviceRegistrationEndpoint : '/api/devices/register';
    return {
        supabaseUrl,
        anonKey,
        mode: 'supabase_oauth_pkce',
        oauth: {
            supabaseUrl: supabaseUrl.replace(/\/$/, ''),
            anonKey,
            clientId: info.oauthClientId,
            redirectUri,
            registrationUrl: resolveRelayEndpoint(base, registration),
        },
    };
}

/**
 * The relay may live under a path (https://host/relay). A root-relative
 * endpoint like "/api/devices/register" is relative to the relay base, not the
 * origin: `new URL('/x', 'https://host/relay/')` would drop "/relay".
 */
export function resolveRelayEndpoint(base: string, endpoint: string): string {
    if (/^https?:\/\//i.test(endpoint)) return new URL(endpoint).toString();
    return `${base.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
}

export function deviceTopic(userId: string, deviceId: string): string {
    return `user:${userId}:device:${deviceId}`;
}

export interface PresenceMeta {
    device_id: string;
    transport: 'broadcast_v1';
    local_mcp_ready: boolean;
    connection_generation: string;
}

export function presenceMeta(deviceId: string, localReady: boolean, connectionGeneration: string): PresenceMeta {
    return { device_id: deviceId, transport: 'broadcast_v1', local_mcp_ready: localReady, connection_generation: connectionGeneration };
}

/**
 * Registration capabilities for the relay. Postgres caps the column at 8 KiB,
 * so tool names are sent, not full schemas. transport_broadcast_v1 is part of
 * the contract here: the server still requires matching live Presence
 * before it will dispatch.
 */
export function relayCapabilities(tools: unknown, appVersion: string, broadcastCapable: boolean): Record<string, unknown> {
    const list = Array.isArray((tools as any)?.tools) ? (tools as any).tools : Array.isArray(tools) ? tools : [];
    const names: string[] = [];
    let bytes = 0;
    for (const tool of list) {
        const name = typeof tool?.name === 'string' ? tool.name : null;
        if (!name || name.length > 128) continue;
        if (bytes + name.length + 3 > 6_000) break;
        names.push(name);
        bytes += name.length + 3;
    }
    return { app_version: appVersion, tool_names: names, ...(broadcastCapable ? { transport_broadcast_v1: true } : {}) };
}

interface RefreshRewrite {
    url: string;
    init: RequestInit;
}

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return (input as Request).url;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    new Headers(headers ?? {}).forEach((value, key) => { out[key] = value; });
    return out;
}

/**
 * D1: auth-js refreshes by POSTing JSON {refresh_token} to
 * /auth/v1/token?grant_type=refresh_token. An OAuth-issued refresh token must
 * instead go to /auth/v1/oauth/token as a form with the public client_id.
 * Returns null for every other request, which passes through untouched.
 */
export function rewriteRefreshRequest(input: RequestInfo | URL, init: RequestInit | undefined, settings: Pick<OAuthRelaySettings, 'supabaseUrl' | 'clientId'>): RefreshRewrite | null {
    const method = (init?.method ?? (typeof input === 'object' && 'method' in (input as any) ? (input as Request).method : 'GET')).toUpperCase();
    if (method !== 'POST') return null;
    let url: URL;
    try { url = new URL(requestUrl(input)); } catch { return null; }
    const base = new URL(settings.supabaseUrl);
    if (url.origin !== base.origin || url.pathname !== '/auth/v1/token' || url.searchParams.get('grant_type') !== 'refresh_token') return null;
    let refreshToken: unknown;
    try { refreshToken = JSON.parse(typeof init?.body === 'string' ? init.body : '')?.refresh_token; } catch { return null; }
    if (!nonEmptyString(refreshToken)) return null;

    const headers = headerRecord(init?.headers);
    delete headers['content-type'];
    delete headers['authorization'];
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['accept'] = 'application/json';
    return {
        url: `${url.origin}/auth/v1/oauth/token`,
        init: {
            ...init,
            method: 'POST',
            headers,
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: settings.clientId }).toString(),
        },
    };
}

/**
 * D1: /oauth/token returns {access_token, token_type, expires_in, refresh_token, …}
 * with no expires_at and no user. auth-js needs both to treat it as a session.
 */
export function normalizeOAuthTokenResponse(body: any, user: unknown, nowSeconds: number): Record<string, unknown> {
    const expiresIn = Number(body?.expires_in);
    return {
        ...body,
        token_type: body?.token_type ?? 'bearer',
        expires_in: expiresIn,
        expires_at: Number.isFinite(Number(body?.expires_at)) ? Number(body.expires_at) : nowSeconds + expiresIn,
        user,
    };
}

/** Wraps a fetch so auth-js refreshes use the OAuth token endpoint (see rewriteRefreshRequest). */
export function oauthRelayFetch(baseFetch: typeof fetch, settings: OAuthRelaySettings, now: () => number = Date.now): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const rewrite = rewriteRefreshRequest(input, init, settings);
        if (!rewrite) return baseFetch(input, init);
        const response = await baseFetch(rewrite.url, rewrite.init);
        console.log(`🔄 Own-relay token refresh via /auth/v1/oauth/token (client_id=${settings.clientId}) → ${response.status}`);
        if (!response.ok) return response;
        const body = await response.json();
        const userResponse = await baseFetch(`${new URL(settings.supabaseUrl).origin}/auth/v1/user`, {
            headers: { apikey: settings.anonKey, authorization: `Bearer ${body.access_token}` },
        });
        if (!userResponse.ok) return userResponse;
        const normalized = normalizeOAuthTokenResponse(body, await userResponse.json(), Math.floor(now() / 1000));
        const headers = new Headers({ 'content-type': 'application/json' });
        const date = response.headers.get('date');
        if (date) headers.set('date', date);
        return new Response(JSON.stringify(normalized), { status: 200, headers });
    }) as typeof fetch;
}

export interface CodeExchangeInput {
    supabaseUrl: string;
    anonKey: string;
    clientId: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
}

/** D5: the device, not the plane, redeems the authorization code with its own PKCE verifier. */
export async function exchangeAuthorizationCode(fetchImpl: typeof fetch, input: CodeExchangeInput): Promise<{ access_token: string; refresh_token: string }> {
    const response = await fetchImpl(`${input.supabaseUrl.replace(/\/$/, '')}/auth/v1/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', apikey: input.anonKey },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: input.code,
            client_id: input.clientId,
            redirect_uri: input.redirectUri,
            code_verifier: input.codeVerifier,
        }).toString(),
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok || !nonEmptyString(data?.access_token) || !nonEmptyString(data?.refresh_token)) {
        throw new Error(`Authorization code exchange failed: ${data?.error_description || data?.error || response.status}`);
    }
    return { access_token: data.access_token, refresh_token: data.refresh_token };
}

export interface RelayRegistrationInput {
    registrationUrl: string;
    accessToken: string;
    deviceId?: string;
    deviceName: string;
    capabilities: Record<string, unknown>;
}

/** D5: POST /api/devices/register with the device's own token; returns the server's device row. */
export async function registerWithRelay(fetchImpl: typeof fetch, input: RelayRegistrationInput): Promise<{ id: string; [key: string]: unknown }> {
    const attempt = async (deviceId?: string) => fetchImpl(input.registrationUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${input.accessToken}` },
        body: JSON.stringify({ ...(deviceId ? { device_id: deviceId } : {}), device_name: input.deviceName, capabilities: input.capabilities }),
    });
    let response = await attempt(input.deviceId);
    // A persisted id the relay no longer knows (e.g. rows reset) registers fresh.
    if (response.status === 404 && input.deviceId) response = await attempt(undefined);
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok || !nonEmptyString(data?.id)) {
        throw new Error(`Relay device registration failed: ${data?.error || response.status}`);
    }
    return data;
}
