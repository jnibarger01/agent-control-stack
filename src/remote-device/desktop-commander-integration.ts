import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { fileURLToPath } from 'url';
import type { Readable } from 'stream';
import { captureRemote } from '../utils/capture.js';
import { StartupStderrCapture, describeChildStartupFailure } from './startup-stderr.js';
import { GatewayOAuthProvider } from './gateway-oauth-provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_CONNECT_TIMEOUT_MS = 15_000;

interface McpConfig {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
}

export class DesktopCommanderIntegration {
    private mcpClient: Client | null = null;
    private mcpTransport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
    private isReady: boolean = false;
    private initializePromise: Promise<void> | null = null;
    private shutdownRequested: boolean = false;
    private disconnectHandler: ((reason: string) => void) | null = null;
    private reinitPromise: Promise<void> | null = null;

    get ready(): boolean {
        return this.isReady && this.mcpClient !== null;
    }

    onDisconnect(handler: (reason: string) => void): void {
        this.disconnectHandler = handler;
    }

    private handleLocalDisconnect(reason: string): void {
        if (this.shutdownRequested || !this.isReady) return;
        this.isReady = false;
        this.mcpClient = null;
        this.mcpTransport = null;
        console.error(` - ❌ Local Desktop Commander MCP went away (${reason})`);
        this.disconnectHandler?.(reason);
    }

    constructor(
        private readonly standalone: boolean = false,
        private readonly managedMcpUrl?: string,
    ) {}

    initialize(): Promise<void> {
        if (this.isReady) return Promise.resolve();
        if (this.initializePromise) return this.initializePromise;
        if (this.shutdownRequested) {
            return Promise.reject(new Error('Desktop Commander integration cannot initialize after shutdown'));
        }
        this.initializePromise = this.initializeInternal().finally(() => {
            this.initializePromise = null;
        });
        return this.initializePromise;
    }

    private async initializeInternal() {
        console.debug('[DEBUG] DesktopCommanderIntegration.initialize() called');

        if (this.managedMcpUrl) {
            await this.initializeManagedHttp();
            return;
        }

        const config = await this.resolveMcpConfig();

        if (!config) {
            console.debug('[DEBUG] No MCP config found');
            throw new Error('Desktop Commander MCP not found. Please install it globally via `npm install -g @wonderwhy-er/desktop-commander` or build the local project.');
        }

        console.log(` - ⏳ Connecting to Local Desktop Commander MCP using: ${config.command} ${config.args.join(' ')}`);
        console.debug('[DEBUG] MCP config:', JSON.stringify(config, null, 2));

        let startupStderr: StartupStderrCapture | null = null;
        let childExited = false;
        try {
            console.debug('[DEBUG] Creating StdioClientTransport');
            // DC_REMOTE_DEVICE tells the spawned server it is serving remote
            // services, so it suppresses local-only behavior like opening the
            // welcome page in a browser the remote user would never see.
            // stderr is piped (and forwarded to ours) rather than inherited so a
            // child that dies during startup — e.g. refused by the executor
            // lease — can explain why instead of a bare "Connection closed".
            this.mcpTransport = new StdioClientTransport({
                ...config,
                env: { ...getDefaultEnvironment(), ...config.env, DC_REMOTE_DEVICE: 'true' },
                stderr: 'pipe',
            });
            startupStderr = new StartupStderrCapture(this.mcpTransport.stderr as Readable | null);
            // Client.connect() chains this handler; before initialization
            // completes, a close can only mean the child went away.
            this.mcpTransport.onclose = () => { childExited = true; };

            // Create MCP client
            console.debug('[DEBUG] Creating MCP Client');
            this.mcpClient = new Client(
                {
                    name: "desktop-commander-client",
                    version: "1.0.0"
                },
                {
                    capabilities: {}
                }
            );

            // Connect to Desktop Commander
            console.debug('[DEBUG] Connecting MCP client to transport');
            await this.mcpClient.connect(this.mcpTransport, {
                timeout: MCP_CONNECT_TIMEOUT_MS,
                maxTotalTimeout: MCP_CONNECT_TIMEOUT_MS,
            });
            if (this.shutdownRequested) {
                await this.mcpClient.close().catch(() => undefined);
                throw new Error('Desktop Commander integration startup was cancelled by shutdown');
            }
            this.isReady = true;
            startupStderr.stop();
            this.mcpTransport.onclose = () => this.handleLocalDisconnect('stdio transport closed');
            this.mcpTransport.onerror = (error: Error) =>
                this.handleLocalDisconnect(`stdio transport error: ${error?.message ?? String(error)}`);

            console.log(' - 🔌 Connected to Desktop Commander MCP');
            console.debug('[DEBUG] Desktop Commander MCP connection successful');

        } catch (error) {
            this.isReady = false;
            this.mcpClient = null;
            if (this.mcpTransport) {
                try { await this.mcpTransport.close(); } catch { /* already dead */ }
                this.mcpTransport = null;
            }
            // Let stderr chunks already read from the dead child drain into the capture.
            await new Promise((resolve) => setImmediate(resolve));
            const startupError = startupStderr
                ? describeChildStartupFailure(error, { childExited, stderr: startupStderr.summary() })
                : error;
            startupStderr?.stop();
            console.error(' - ❌ Failed to connect to Desktop Commander MCP:', startupError instanceof Error ? startupError.message : startupError);
            console.debug('[DEBUG] MCP connection error:', error);
            // Telemetry keeps the original error only; child stderr stays local.
            await captureRemote('desktop_integration_init_failed', { error });
            throw startupError;
        }
    }

    private async initializeManagedHttp(): Promise<void> {
        const url = new URL(this.managedMcpUrl!);

        if (url.pathname !== '/mcp') {
            throw new Error(`Managed Desktop Commander URL must target /mcp (got ${url.pathname})`);
        }

        // Never attach the remote supervisor directly to the unauthenticated
        // bridge. All managed calls must traverse the OAuth/ACS gateway.
        if (
            (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
            url.port === '8002'
        ) {
            throw new Error('Managed remote attachment to raw bridge port 8002 is forbidden');
        }

        console.log(` - ⏳ Attaching to managed Desktop Commander MCP: ${url.origin}${url.pathname}`);

        const provider = new GatewayOAuthProvider();

        const makeTransport = () =>
            new StreamableHTTPClientTransport(url, { authProvider: provider });

        const makeClient = () =>
            new Client(
                { name: 'desktop-commander-client', version: '1.0.0' },
                { capabilities: {} },
            );

        let transport = makeTransport();
        let client = makeClient();

        try {
            try {
                await client.connect(transport, {
                    timeout: MCP_CONNECT_TIMEOUT_MS,
                    maxTotalTimeout: MCP_CONNECT_TIMEOUT_MS,
                });
            } catch (error) {
                if (!(error instanceof UnauthorizedError)) throw error;

                console.log(' - 🔐 Managed gateway authorization required');
                const authorizationCode = await provider.waitForAuthorizationCode();

                // Exchange the PKCE callback code using the transport that
                // initiated the OAuth flow.
                await transport.finishAuth(authorizationCode);
                await transport.close().catch(() => undefined);

                // A started Streamable HTTP transport is not restartable.
                // Reconnect using a fresh transport and client; OAuth state is
                // persisted by the provider.
                transport = makeTransport();
                client = makeClient();

                await client.connect(transport, {
                    timeout: MCP_CONNECT_TIMEOUT_MS,
                    maxTotalTimeout: MCP_CONNECT_TIMEOUT_MS,
                });
            }

            if (this.shutdownRequested) {
                await transport.close().catch(() => undefined);
                await client.close().catch(() => undefined);
                throw new Error('Desktop Commander integration startup was cancelled by shutdown');
            }

            this.mcpTransport = transport;
            this.mcpClient = client;
            this.isReady = true;

            transport.onclose = () =>
                this.handleLocalDisconnect('managed HTTP transport closed');

            transport.onerror = (error: Error) =>
                this.handleLocalDisconnect(
                    `managed HTTP transport error: ${error?.message ?? String(error)}`,
                );

            console.log(' - 🔌 Attached to managed Desktop Commander MCP');
            console.debug('[DEBUG] Managed Desktop Commander MCP connection successful');
        } catch (error) {
            this.isReady = false;
            this.mcpClient = null;
            this.mcpTransport = null;

            await transport.close().catch(() => undefined);
            await client.close().catch(() => undefined);

            console.error(
                ' - ❌ Failed to attach to managed Desktop Commander MCP:',
                error instanceof Error ? error.message : error,
            );

            await captureRemote('desktop_integration_init_failed', { error });
            throw error;
        }
    }

    async ensureReady(): Promise<void> {
        if (this.ready) return;
        if (this.shutdownRequested) throw new Error('Desktop Commander integration is shutting down');
        if (!this.reinitPromise) {
            this.reinitPromise = this.initialize().finally(() => { this.reinitPromise = null; });
        }
        await this.reinitPromise;
    }

    async resolveMcpConfig(): Promise<McpConfig | null> {
        if (!this.standalone) {
            throw new Error('Remote Desktop Commander integration requires explicit standalone opt-in');
        }
        console.debug('[DEBUG] Resolving MCP config...');
        // Option 1: Development/Local Build
        // Adjusting path resolution since we are now in src/remote-device and dist is in root/dist
        // Original: path.resolve(__dirname, '../../dist/index.js')
        const devPath = path.resolve(__dirname, '../../dist/index.js');
        console.debug('[DEBUG] Checking local dev path:', devPath);
        try {
            await fs.access(devPath);
            console.debug(' - 🔍 Found local MCP server at:', devPath);
            return {
                command: process.execPath, // Use the current node executable
                args: [devPath, '--standalone'],
                cwd: path.dirname(devPath)
            };
        } catch {
            console.debug('[DEBUG] Local dev path not found, trying global installation');
            // Local file not found, continue...
        }

        // Option 2: Global Installation
        const commandName = 'desktop-commander';
        console.debug('[DEBUG] Checking for global command:', commandName);
        try {
            await new Promise<void>((resolve, reject) => {
                // Use platform-appropriate command to check if the command exists in PATH
                // We can't run it directly as it's an stdio MCP server that waits for input
                const whichCommand = process.platform === 'win32' ? 'where' : 'which';
                console.debug('[DEBUG] Using platform command:', whichCommand, 'on platform:', process.platform);
                const check = spawn(whichCommand, [commandName], { windowsHide: true });  // Prevent visible console windows on Windows
                check.on('error', (err) => {
                    console.debug('[DEBUG] Spawn error for', whichCommand, ':', err.message);
                    reject(err);
                });
                check.on('close', (code) => {
                    console.debug('[DEBUG]', whichCommand, 'exited with code:', code);
                    return code === 0 ? resolve() : reject(new Error('Command not found'));
                });
            });
            console.debug(' - Found global desktop-commander CLI');
            return {
                command: commandName,
                args: ['--standalone']
            };
        } catch (err) {
            console.debug('[DEBUG] Global command not found:', err);
            // Global command not found
        }

        console.debug('[DEBUG] No MCP config resolved');
        return null;
    }

    async callClientTool(toolName: string, args: any, metadata?: any) {
        await this.ensureReady();

        // Proxy other tools to MCP server
        try {
            console.debug('[DEBUG] Calling MCP tool:', toolName, 'args:', JSON.stringify(args).substring(0, 100));
            const result = await this.mcpClient!.callTool({
                name: toolName,
                arguments: args,
                _meta: { remote: true, ...metadata || {} }
            } as any);
            console.debug('[DEBUG] Tool call successful:', toolName);
            return result;
        } catch (error) {
            console.error(`Error executing tool ${toolName}:`, error);
            console.debug('[DEBUG] Tool call error details:', error);
            await captureRemote('desktop_integration_tool_call_failed', { error, toolName });
            throw error;
        }
    }

    async listClientTools() {
        if (!this.mcpClient) return { tools: [] };

        try {
            // List tools from MCP server
            const mcpTools = await this.mcpClient.listTools();

            // Merge tools
            return {
                tools: mcpTools.tools || []
            };
        } catch (error) {
            console.error('Error fetching capabilities:', error);
            await captureRemote('desktop_integration_list_tools_failed', { error });
            // Fallback to local tools
            return {
                tools: []
            };
        }
    }

    async shutdown() {
        console.debug('[DEBUG] DesktopCommanderIntegration.shutdown() called');
        this.shutdownRequested = true;
        this.shutdownRequested = true;
        const closeWithTimeout = async (operation: () => Promise<void>, name: string, timeoutMs: number = 3000) => {
            return Promise.race([
                operation(),
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error(`${name} timeout after ${timeoutMs}ms`)), timeoutMs)
                )
            ]);
        };

        // The transport owns the child. Close it first so an MCP initialize
        // request that never completed cannot keep its SDK timeout alive.
        if (this.mcpTransport) {
            try {
                console.log('  → Closing MCP transport...');
                console.debug('[DEBUG] Calling mcpTransport.close() with timeout');
                await closeWithTimeout(
                    () => this.mcpTransport!.close(),
                    'MCP transport close'
                );
                console.log('  ✓ MCP transport closed');
            } catch (e: any) {
                console.warn('  ⚠️  MCP transport close timeout or error:', e.message);
                console.debug('[DEBUG] MCP transport close error:', e);
                await captureRemote('desktop_integration_shutdown_error', { error: e, component: 'transport' });
            }
            this.mcpTransport = null;
        }

        if (this.mcpClient) {
            try {
                console.log('  → Closing MCP client...');
                console.debug('[DEBUG] Calling mcpClient.close() with timeout');
                await closeWithTimeout(
                    () => this.mcpClient!.close(),
                    'MCP client close'
                );
                console.log('  ✓ MCP client closed');
            } catch (e: any) {
                console.warn('  ⚠️  MCP client close timeout or error:', e.message);
                console.debug('[DEBUG] MCP client close error:', e);
                await captureRemote('desktop_integration_shutdown_error', { error: e, component: 'client' });
            }
            this.mcpClient = null;
        }

        this.isReady = false;
        console.debug('[DEBUG] Desktop Commander integration shutdown complete');
    }
}
