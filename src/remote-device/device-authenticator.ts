import open from 'open';
import os from 'os';
import crypto from 'crypto';
import { captureRemote } from '../utils/capture.js';

interface AuthSession {
    access_token: string;
    refresh_token: string | null;
    device_id?: string;
}

export type DeviceAuthState =
    | 'DISCONNECTED'
    | 'PAIRING_SESSION_CREATED'
    | 'ADD_DEVICE_PAGE_OPENED'
    | 'AWAITING_DEVICE_VERIFICATION'
    | 'DEVICE_VERIFIED'
    | 'CONNECTING'
    | 'CONNECTED'
    | 'PAIRING_SESSION_FAILED'
    | 'PAIRING_SESSION_EXPIRED'
    | 'VERIFICATION_REJECTED'
    | 'VERIFICATION_EXPIRED'
    | 'VERIFICATION_TIMEOUT'
    | 'BROWSER_LAUNCH_FAILED'
    | 'CONNECTION_FAILED';

interface DeviceAuthResponse {
    /** Pairing identity used by the hosted add-device page. */
    session_id?: string;
    user_code: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
    /** Kept for compatibility with the token polling transport. */
    device_code?: string;
}

interface PollResponse {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
    device_id?: string;
}

const CLIENT_ID = 'mcp-device';
export function buildAddDeviceUrl(baseServerUrl: string, sessionId: string): string {
    const url = new URL(normalizeRemoteControlPlaneUrl(baseServerUrl));
    url.pathname = `${url.pathname.replace(/\/$/, '')}/add-device`;
    url.searchParams.set('session_id', requireNonEmpty(sessionId, 'session_id'));
    return url.toString();
}

export function buildVerifyDeviceUrl(baseServerUrl: string, userCode: string): string {
    const url = new URL(normalizeRemoteControlPlaneUrl(baseServerUrl));
    url.pathname = `${url.pathname.replace(/\/$/, '')}/verify-device`;
    url.searchParams.set('verify_device', 'true');
    url.searchParams.set('user_code', requireNonEmpty(userCode, 'user_code'));
    return url.toString();
}

function requireNonEmpty(value: string, name: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Invalid ${name}`);
    }
    return value;
}

export function normalizeRemoteControlPlaneUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Invalid remote control-plane URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Remote control-plane URL must be an http(s) origin without credentials or query parameters');
    }
    return url.toString().replace(/\/$/, '');
}

export interface DeviceAuthenticatorOptions {
    fetchImpl?: typeof fetch;
    openBrowser?: (url: string) => Promise<unknown>;
    sleep?: (milliseconds: number) => Promise<void>;
    onStateChange?: (state: DeviceAuthState) => void;
}

export class DeviceAuthenticator {
    private baseServerUrl: string;
    private readonly fetchImpl: typeof fetch;
    private readonly openBrowser: (url: string) => Promise<unknown>;
    private readonly sleepImpl: (milliseconds: number) => Promise<void>;
    private readonly onStateChange?: (state: DeviceAuthState) => void;

    constructor(baseServerUrl: string, options: DeviceAuthenticatorOptions = {}) {
        this.baseServerUrl = normalizeRemoteControlPlaneUrl(baseServerUrl);
        this.fetchImpl = options.fetchImpl || fetch;
        this.openBrowser = options.openBrowser || ((url) => open(url));
        this.sleepImpl = options.sleep || ((milliseconds) => this.sleep(milliseconds));
        this.onStateChange = options.onStateChange;
    }

    async authenticate(deviceId?: string): Promise<AuthSession> {
        console.log('🔐 Starting device authorization flow...\n');

        // Generate PKCE
        const pkce = this.generatePKCE();

        // Step 1: Request device code
        let deviceAuth: DeviceAuthResponse;
        try {
            deviceAuth = await this.requestDeviceCode(pkce.challenge, deviceId);
            this.transition('PAIRING_SESSION_CREATED');
        } catch (error) {
            this.transition('PAIRING_SESSION_FAILED');
            throw error;
        }

        // Step 2: Display user instructions and open browser
        await this.displayUserInstructions(deviceAuth);
        this.transition('AWAITING_DEVICE_VERIFICATION');

        // Step 3: Poll for authorization
        let tokens: AuthSession;
        try {
            tokens = await this.pollForAuthorization(deviceAuth, pkce.verifier);
        } catch (error) {
            this.transition(this.classifyFailure(error));
            throw error;
        }

        this.transition('DEVICE_VERIFIED');
        console.log('   - ✅ Authorization successful!\n');

        return tokens;
    }

    private generatePKCE() {
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        return { verifier, challenge };
    }

    private async requestDeviceCode(codeChallenge: string, deviceId?: string): Promise<DeviceAuthResponse> {
        console.log('   - 📡 Requesting device code...');

        const response = await this.fetchImpl(`${this.baseServerUrl}/device/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: 'mcp:tools',
                device_name: os.hostname(),
                device_type: 'mcp',
                device_id: deviceId,
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
            }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Unknown error' }));
            const errorMessage = error.error_description || 'Failed to start device flow';
            await captureRemote('remote_device_auth_request_failed', { error: 'request_failed' });
            throw new Error(errorMessage);
        }

        const data = await response.json() as Partial<DeviceAuthResponse>;
        const sessionId = data.session_id;
        const userCode = data.user_code;
        const expiresIn = data.expires_in;
        const deviceCode = data.device_code;
        if ((!sessionId && !deviceCode) || !userCode || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
            await captureRemote('remote_device_auth_request_failed', { error: 'invalid_pairing_response' });
            throw new Error('Remote device authorization returned an invalid pairing session');
        }
        console.log('   - ✅ Device code received\n');
        return {
            session_id: sessionId,
            user_code: userCode,
            expires_in: expiresIn,
            interval: data.interval,
            device_code: deviceCode,
            verification_uri: data.verification_uri,
            verification_uri_complete: data.verification_uri_complete,
        };
    }

    private async displayUserInstructions(deviceAuth: DeviceAuthResponse): Promise<void> {
        const browserUrl = deviceAuth.session_id
            ? buildAddDeviceUrl(this.baseServerUrl, deviceAuth.session_id)
            : deviceAuth.verification_uri_complete || deviceAuth.verification_uri;
        if (!browserUrl) throw new Error('Remote device authorization returned no browser URL');
        console.log('📋 Please complete authentication in your browser:\n');
        console.log('   1. Open this URL in your browser:');
        console.log(`      ${browserUrl}\n`);
        console.log(deviceAuth.session_id
            ? '   2. Complete the Add Device and Verify Device steps.\n'
            : '   2. Complete the device verification step and authorize this device.\n');
        console.log(`   Code expires in ${Math.floor(deviceAuth.expires_in / 60)} minutes.\n`);

        // Try to open browser automatically
        try {
            await this.openBrowser(browserUrl);
            this.transition('ADD_DEVICE_PAGE_OPENED');
        } catch {
            this.transition('BROWSER_LAUNCH_FAILED');
            console.log('   - Could not open browser automatically.');
            console.log(`   - Please visit: ${browserUrl}\n`);
        }

        console.log('   - ⏳ Waiting for authorization...\n');
    }

    private async pollForAuthorization(deviceAuth: DeviceAuthResponse, codeVerifier: string): Promise<AuthSession> {
        const pollIntervalSeconds = deviceAuth.interval || 5;
        const interval = pollIntervalSeconds * 1000;
        const maxAttempts = Math.max(1, Math.ceil(deviceAuth.expires_in / pollIntervalSeconds));
        let attempt = 0;

        while (attempt < maxAttempts) {
            attempt++;

            // Wait before polling
            await this.sleepImpl(interval);

            let response: Response;
            let data: PollResponse;
            try {
                response = await this.fetchImpl(`${this.baseServerUrl}/device/poll`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...(deviceAuth.session_id ? { session_id: deviceAuth.session_id } : {}),
                        ...(deviceAuth.device_code ? { device_code: deviceAuth.device_code } : {}),
                        client_id: CLIENT_ID,
                        code_verifier: codeVerifier,
                    }),
                });

                // Parse response body exactly once
                data = await response.json().catch(() => ({ error: 'invalid_response' }));
            } catch (fetchError) {
                // Network error - retry unless we're out of attempts
                if (attempt >= maxAttempts) {
                    await captureRemote('remote_device_auth_network_error', { error: 'network_error' });
                    throw fetchError;
                }
                // Continue polling on network errors
                continue;
            }

            // Successful authentication is the authoritative verification result.
            if (response.ok && data.access_token) {
                return {
                    device_id: data.device_id,
                    access_token: data.access_token,
                    refresh_token: data.refresh_token || null,
                };
            }

            if (data.error === 'authorization_pending') continue;
            if (data.error === 'slow_down') {
                await this.sleepImpl(interval);
                continue;
            }

            const errorMessage = data.error_description || data.error || 'Authorization failed';
            await captureRemote('remote_device_auth_failed', { error: 'authorization_failed' });
            throw new Error(errorMessage);
        }

        const timeoutError = 'Authorization timeout - user did not authorize within the time limit';
        await captureRemote('remote_device_auth_timeout', { error: 'verification_timeout' });
        throw new Error(timeoutError);
    }

    private transition(state: DeviceAuthState): void {
        this.onStateChange?.(state);
    }

    private classifyFailure(error: unknown): DeviceAuthState {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        if (message.includes('timeout')) return 'VERIFICATION_TIMEOUT';
        if (message.includes('expired') || message.includes('invalid_grant')) return 'VERIFICATION_EXPIRED';
        if (message.includes('reject') || message.includes('denied')) return 'VERIFICATION_REJECTED';
        return 'CONNECTION_FAILED';
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
