import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

import type {
    OAuthClientProvider,
    OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';

import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

interface PersistedGatewayOAuth {
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    codeVerifier?: string;
    discoveryState?: OAuthDiscoveryState;
}

const DEFAULT_CALLBACK_PORT = 18123;

export class GatewayOAuthProvider implements OAuthClientProvider {
    private readonly statePath: string;
    private readonly callbackPort: number;
    private readonly callbackUrl: URL;

    private loaded = false;
    private stateData: PersistedGatewayOAuth = {};

    private expectedState?: string;
    private callbackServer?: http.Server;
    private authorizationPromise?: Promise<string>;
    private authorizationResolve?: (code: string) => void;
    private authorizationReject?: (error: Error) => void;

    constructor() {
        const port = Number.parseInt(
            process.env.DC_MANAGED_OAUTH_CALLBACK_PORT || '',
            10,
        );

        this.callbackPort =
            Number.isFinite(port) && port > 0 && port < 65536
                ? port
                : DEFAULT_CALLBACK_PORT;

        this.callbackUrl = new URL(
            `http://127.0.0.1:${this.callbackPort}/oauth/callback`,
        );

        this.statePath =
            process.env.DC_MANAGED_OAUTH_STATE_PATH ||
            path.join(
                os.homedir(),
                '.desktop-commander-device',
                'managed-gateway-oauth.json',
            );
    }

    get redirectUrl(): URL {
        return this.callbackUrl;
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            redirect_uris: [this.callbackUrl.toString()],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            client_name: 'Desktop Commander Remote Managed Attach',
            scope: 'mcp',
        };
    }

    async state(): Promise<string> {
        return randomBytes(24).toString('base64url');
    }

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
        await this.load();
        return this.stateData.clientInformation;
    }

    async saveClientInformation(
        clientInformation: OAuthClientInformationMixed,
    ): Promise<void> {
        await this.load();
        this.stateData.clientInformation = clientInformation;
        await this.persist();
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        await this.load();
        return this.stateData.tokens;
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
        await this.load();
        this.stateData.tokens = tokens;
        await this.persist();
    }

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
        await this.load();
        this.stateData.codeVerifier = codeVerifier;
        await this.persist();
    }

    async codeVerifier(): Promise<string> {
        await this.load();

        if (!this.stateData.codeVerifier) {
            throw new Error('Managed gateway OAuth PKCE verifier is unavailable');
        }

        return this.stateData.codeVerifier;
    }

    async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
        await this.load();
        this.stateData.discoveryState = state;
        await this.persist();
    }

    async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
        await this.load();
        return this.stateData.discoveryState;
    }

    async invalidateCredentials(
        scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
    ): Promise<void> {
        await this.load();

        if (scope === 'all' || scope === 'client') {
            delete this.stateData.clientInformation;
        }

        if (scope === 'all' || scope === 'tokens') {
            delete this.stateData.tokens;
        }

        if (scope === 'all' || scope === 'verifier') {
            delete this.stateData.codeVerifier;
        }

        if (scope === 'all' || scope === 'discovery') {
            delete this.stateData.discoveryState;
        }

        await this.persist();
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        this.expectedState = authorizationUrl.searchParams.get('state') || undefined;

        this.ensureAuthorizationPromise();
        await this.startCallbackServer();

        console.log(
            `🔐 Managed Desktop Commander authorization:\n${authorizationUrl.toString()}`,
        );

        if (process.platform === 'linux') {
            const child = spawn(
                'xdg-open',
                [authorizationUrl.toString()],
                { detached: true, stdio: 'ignore' },
            );

            child.once('error', () => undefined);
            child.unref();
        }
    }

    waitForAuthorizationCode(): Promise<string> {
        return this.ensureAuthorizationPromise();
    }

    private ensureAuthorizationPromise(): Promise<string> {
        if (!this.authorizationPromise) {
            this.authorizationPromise = new Promise<string>((resolve, reject) => {
                this.authorizationResolve = resolve;
                this.authorizationReject = reject;
            });
        }

        return this.authorizationPromise;
    }

    private async startCallbackServer(): Promise<void> {
        if (this.callbackServer) return;

        this.callbackServer = http.createServer((req, res) => {
            const url = new URL(req.url || '/', this.callbackUrl);

            if (url.pathname !== this.callbackUrl.pathname) {
                res.writeHead(404).end();
                return;
            }

            const error = url.searchParams.get('error');
            if (error) {
                const description =
                    url.searchParams.get('error_description') || error;

                res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('Desktop Commander authorization failed. You may close this tab.');

                this.finishAuthorization(
                    new Error(`Managed gateway OAuth authorization failed: ${description}`),
                );
                return;
            }

            const returnedState = url.searchParams.get('state') || undefined;
            if (this.expectedState && returnedState !== this.expectedState) {
                res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('Desktop Commander authorization state mismatch.');

                this.finishAuthorization(
                    new Error('Managed gateway OAuth state mismatch'),
                );
                return;
            }

            const code = url.searchParams.get('code');
            if (!code) {
                res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('Desktop Commander authorization code missing.');

                this.finishAuthorization(
                    new Error('Managed gateway OAuth authorization code missing'),
                );
                return;
            }

            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Desktop Commander authorized. You may close this tab.');

            this.finishAuthorization(undefined, code);
        });

        await new Promise<void>((resolve, reject) => {
            this.callbackServer!.once('error', reject);
            this.callbackServer!.listen(
                this.callbackPort,
                '127.0.0.1',
                () => resolve(),
            );
        });
    }

    private finishAuthorization(error?: Error, code?: string): void {
        const server = this.callbackServer;
        this.callbackServer = undefined;

        server?.close();

        if (error) {
            this.authorizationReject?.(error);
        } else if (code) {
            this.authorizationResolve?.(code);
        }

        this.authorizationPromise = undefined;
        this.authorizationResolve = undefined;
        this.authorizationReject = undefined;
    }

    private async load(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;

        try {
            const raw = await fs.readFile(this.statePath, 'utf8');
            this.stateData = JSON.parse(raw) as PersistedGatewayOAuth;
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }

    private async persist(): Promise<void> {
        const directory = path.dirname(this.statePath);
        const temporary = `${this.statePath}.${process.pid}.tmp`;

        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(
            temporary,
            `${JSON.stringify(this.stateData, null, 2)}\n`,
            { mode: 0o600 },
        );
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, this.statePath);
    }
}
