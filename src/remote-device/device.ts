#!/usr/bin/env node

import { RemoteChannel } from './remote-channel.js';
import { DeviceAuthenticator, normalizeRemoteControlPlaneUrl } from './device-authenticator.js';
import type { DeviceAuthState } from './device-authenticator.js';
import { DesktopCommanderIntegration } from './desktop-commander-integration.js';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { captureRemote } from '../utils/capture.js';

const LOCAL_MCP_STARTUP_TIMEOUT_MS = 15_000;
const REMOTE_CONFIG_TIMEOUT_MS = 10_000;
const REMOTE_REGISTER_TIMEOUT_MS = 30_000;
const DEVICE_SHUTDOWN_TIMEOUT_MS = 7_000;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export interface MCPDeviceOptions {
    persistSession?: boolean;
    standalone?: boolean;
    managedMcpUrl?: string;
    onStateChange?: (state: DeviceAuthState) => void;
}

/**
 * How many recently-handled call ids to remember for duplicate-delivery
 * suppression. The two transports deliver a call within MILLISECONDS of each
 * other, so this only has to outlive that window — 100 ids is several minutes
 * of even the heaviest agent traffic, and costs ~10 KB on the user's machine
 * (the device process, not the shared server).
 */
const SEEN_CALL_IDS_MAX = 100;

export class MCPDevice {
    private baseServerUrl: string;
    private remoteChannel: RemoteChannel;
    private deviceId?: string;
    private isShuttingDown: boolean;
    private configPath: string;
    private persistSession: boolean;
    private desktop: DesktopCommanderIntegration;
    private startPromise: Promise<void> | null = null;
    private shutdownPromise: Promise<void> | null = null;
    private readonly onStateChange?: (state: DeviceAuthState) => void;
    private currentState: DeviceAuthState = 'DISCONNECTED';
    /** Call ids already handled by THIS process (insertion-ordered, bounded). */
    private seenCallIds: Set<string> = new Set();

    private assertRunning(): void {
        if (this.isShuttingDown) throw new Error('MCP device startup cancelled by shutdown');
    }

    constructor(options: MCPDeviceOptions = {}) {
        this.baseServerUrl = normalizeRemoteControlPlaneUrl(
            process.env.MCP_SERVER_URL || 'https://mcp.desktopcommander.app',
        );
        this.remoteChannel = new RemoteChannel({
            isLocalReady: () => this.desktop?.ready === true,
            onReconnectExhausted: async ({ attempts, message }) => {
                if (this.isShuttingDown) return;
                console.error(JSON.stringify({
                    event: 'remote_device_stopping_after_reconnect_exhaustion',
                    attempts,
                    error: message,
                }));
                const forceExit = setTimeout(() => {
                    console.error(JSON.stringify({ event: 'remote_device_forced_exit_after_reconnect_exhaustion' }));
                    process.exit(1);
                }, DEVICE_SHUTDOWN_TIMEOUT_MS + 1000);
                try {
                    await this.shutdown();
                    process.exitCode = 1;
                } finally {
                    clearTimeout(forceExit);
                }
            },
        });
        this.deviceId = undefined;
        this.isShuttingDown = false;
        this.configPath = path.join(os.homedir(), '.desktop-commander-device', 'device.json');
        // Default ON. Off meant a full re-authorization on every start, and each
        // one mints a fresh GoTrue session that nothing ever revokes; the orphaned
        // refresh-token families get replayed, trip GoTrue's reuse detection, and
        // take the whole family down including the token a healthy connector holds.
        this.persistSession = options.persistSession ?? true;
        this.onStateChange = options.onStateChange;

        // Initialize desktop integration
        this.desktop = new DesktopCommanderIntegration(
            options.standalone === true,
            options.managedMcpUrl,
        );

        // Graceful shutdown handlers (only set once)
        this.setupShutdownHandlers();
    }

    private transition(state: DeviceAuthState): void {
        this.currentState = state;
        this.onStateChange?.(state);
    }

    private setupShutdownHandlers() {
        const handleShutdown = async (signal: string) => {
            if (this.isShuttingDown) {
                console.log(`\n${signal} received, but already shutting down...`);
                // Force exit if we get multiple signals
                process.exit(1);
                return;
            }

            console.log(`\n${signal} received, initiating graceful shutdown...`);

            // Force exit after the bounded graceful-shutdown budget.
            const forceExit = setTimeout(() => {
                console.error('\n⚠️ Graceful shutdown timed out, forcing exit...');
                process.exit(1);
            }, DEVICE_SHUTDOWN_TIMEOUT_MS + 1000);

            try {
                await this.shutdown();
                clearTimeout(forceExit);
                process.exit(0);
            } catch (error) {
                console.error('Error during shutdown:', error);
                await captureRemote('remote_device_shutdown_handler_error', { error });
                process.exit(1);
            }
        };

        // Remove any existing SIGINT/SIGTERM listeners to prevent default behavior
        // process.removeAllListeners('SIGINT');
        // process.removeAllListeners('SIGTERM');

        // Add our custom handlers
        process.on('SIGINT', () => {
            handleShutdown('SIGINT').catch((error) => {
                console.error('Fatal error during shutdown:', error);
                captureRemote('remote_device_shutdown_handler_error', { error, signal: 'SIGINT' }).catch(() => { });
                process.exit(1);
            });
        });

        process.on('SIGTERM', () => {
            handleShutdown('SIGTERM').catch((error) => {
                console.error('Fatal error during shutdown:', error);
                captureRemote('remote_device_shutdown_handler_error', { error, signal: 'SIGTERM' }).catch(() => { });
                process.exit(1);
            });
        });
    }

    start(): Promise<void> {
        if (this.isShuttingDown) {
            return Promise.reject(new Error('MCP device cannot start after shutdown'));
        }
        if (this.startPromise) return this.startPromise;
        this.startPromise = this.startInternal();
        return this.startPromise;
    }

    private async startInternal() {
        try {
            this.transition('DISCONNECTED');
            console.log('🚀 Starting MCP Device...');
            if (process.env.DEBUG_MODE === 'true') {
                console.log(`  - 🐞 DEBUG_MODE`);
            }


            // Initialize desktop integration
            await withTimeout(
                this.desktop.initialize(),
                LOCAL_MCP_STARTUP_TIMEOUT_MS,
                'Local Desktop Commander MCP startup',
            );
            this.desktop.onDisconnect((reason) => void this.handleLocalMcpLoss(reason));
            this.assertRunning();

            console.log(`⏳ Connecting to Remote MCP ${this.baseServerUrl}`);
            const { supabaseUrl, anonKey } = await withTimeout(
                this.fetchSupabaseConfig(),
                REMOTE_CONFIG_TIMEOUT_MS,
                'Remote MCP configuration fetch',
            );
            this.assertRunning();
            console.log(`   - 🔌 Connected to Remote MCP`);

            // Initialize Remote Channel
            this.remoteChannel.initialize(supabaseUrl, anonKey);

            // Load persisted configuration (deviceId, session)
            let session = await this.loadPersistedConfig();
            this.assertRunning();

            // 2. Set Session or Authenticate
            if (session) {
                this.transition('CONNECTING');
                const { error } = await this.remoteChannel.setSession(session);
                this.assertRunning();

                if (error) {
                    console.log('   - ⚠️ Persisted session invalid:', error.message);
                    session = null;
                } else {
                    console.log('   - ✅ Session restored');
                }
            }

            if (!session) {
                console.log('\n🔐 Authenticating with Remote MCP server...');
                const authenticator = new DeviceAuthenticator(this.baseServerUrl, {
                    onStateChange: (state) => this.transition(state),
                });
                session = await authenticator.authenticate(this.deviceId);
                this.assertRunning();
                if (session.device_id) {
                    if (!this.deviceId) {
                        await captureRemote('remote_device_auth_success', {
                            "device": "assigned"
                        });
                        console.log(`   - ✅ Device ID assigned: ${session.device_id}`);
                    } else if (this.deviceId !== session.device_id) {
                        await captureRemote('remote_device_auth_success', {
                            "device": "changed"
                        });
                        console.log(`   - ⚠️ Device ID changed: ${this.deviceId} → ${session.device_id}`);
                    } else {
                        await captureRemote('remote_device_auth_success', {
                            "device": "authenticated"
                        });
                        console.log(`   - ✅ Device ID authenticated: ${session.device_id}`);
                    }
                    this.deviceId = session.device_id;
                }
                // Set session in Remote Channel
                this.transition('CONNECTING');
                const { error } = await this.remoteChannel.setSession(session);
                this.assertRunning();
                if (error) throw error;
            }


            // Force save the current session immediately to ensure it's persisted
            await this.savePersistedConfig();
            this.assertRunning();

            const deviceName = os.hostname();

            // Register as device
            await withTimeout(
                this.remoteChannel.registerDevice(
                    await this.desktop.listClientTools(),
                    this.deviceId,
                    deviceName,
                    (payload: any) => this.handleNewToolCall(payload)
                ),
                REMOTE_REGISTER_TIMEOUT_MS,
                'Remote MCP device registration',
            );
            this.assertRunning();

            console.log('✅ Device ready:');
            console.log(`   - User:         ${this.remoteChannel.user!.email}`);
            console.log(`   - Device ID:    ${this.deviceId}`);
            console.log(`   - Device Name:  ${deviceName}`);

            // Keep process alive
            this.remoteChannel.startHeartbeat(this.deviceId!);
            this.transition('CONNECTED');

        } catch (error: any) {
            if (!['PAIRING_SESSION_FAILED', 'PAIRING_SESSION_EXPIRED', 'VERIFICATION_REJECTED', 'VERIFICATION_EXPIRED', 'VERIFICATION_TIMEOUT'].includes(this.currentState)) {
                this.transition('CONNECTION_FAILED');
            }
            console.error(' - ❌ Device startup failed:', error.message);
            if (error.stack && process.env.DEBUG_MODE === 'true') {
                console.error('Stack trace:', error.stack);
            }
            await captureRemote('remote_device_startup_failed', { error });
            await this.shutdown();
            throw error;
        }
    }


    async loadPersistedConfig() {
        try {
            console.debug('[DEBUG] Loading persisted config from:', this.configPath);
            const data = await fs.readFile(this.configPath, 'utf8');
            const config = JSON.parse(data);

            this.deviceId = config?.deviceId;
            console.debug('[DEBUG] Loaded device ID:', this.deviceId);

            if (config.session && this.persistSession) {
                console.log('💾 Found persisted session for device ' + this.deviceId);
                console.debug('[DEBUG] Session found in config, returning session');
                return config.session;
            }

            // A previously saved session must not be reused on an opted-out run:
            // it would skip the re-authorization the flag promises, and the save
            // at the end of start() then discards a possibly-rotated refresh
            // token — orphaning one more live server-side session.
            if (config.session) {
                console.debug('[DEBUG] Ignoring persisted session (--no-persist-session)');
            } else {
                console.debug('[DEBUG] No session in config');
            }
            return null;
        } catch (error: any) {

            if (error.code !== 'ENOENT') {
                console.warn('⚠️ Failed to load config:', error.message);
                await captureRemote('remote_device_config_load_error', { error });
            } else {
                console.debug('[DEBUG] Config file does not exist (ENOENT)');
            }
            return null;
        } finally {
            // No need to ensure device ID here
        }
    }

    async savePersistedConfig() {
        try {
            console.debug('[DEBUG] Saving persisted config, persistSession:', this.persistSession);
            const currentSessionStore = await this.remoteChannel.getSession();
            const session = currentSessionStore.data.session;

            const config = {
                deviceId: this.deviceId,
                // Only save session if --persist-session flag is set
                session: (session && this.persistSession) ? {
                    access_token: session.access_token,
                    refresh_token: session.refresh_token
                } : null
            };
            // Ensure the config directory exists
            console.debug('[DEBUG] Creating config directory:', path.dirname(this.configPath));
            await fs.mkdir(path.dirname(this.configPath), { recursive: true });
            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
            console.debug('[DEBUG] Config saved to:', this.configPath);
        } catch (error: any) {
            console.error(' - ❌ Failed to save config:', error.message);
            console.debug('[DEBUG] Config save error details:', error);
            await captureRemote('remote_device_config_save_error', { error });
        }
    }

    async fetchSupabaseConfig() {
        // No auth header needed for this public endpoint
        console.debug('[DEBUG] Fetching Supabase config from:', `${this.baseServerUrl}/api/mcp-info`);
        const response = await fetch(`${this.baseServerUrl}/api/mcp-info`, {
            signal: AbortSignal.timeout(REMOTE_CONFIG_TIMEOUT_MS),
        });

        if (!response.ok) {
            console.debug('[DEBUG] Supabase config fetch failed, status:', response.status, response.statusText);
            throw new Error(`Failed to fetch Supabase config: ${response.statusText}`);
        }

        const config = await response.json();
        console.debug('[DEBUG] Supabase config received, URL:', config.supabaseUrl?.substring(0, 30) + '...');
        return {
            supabaseUrl: config.supabaseUrl,
            anonKey: config.supabasePublishableKey
        };
    }

    // Methods moved to RemoteChannel

    private async handleLocalMcpLoss(reason: string): Promise<void> {
        if (this.isShuttingDown) return;
        if (this.deviceId) {
            await this.remoteChannel.setOnlineStatus(this.deviceId, 'offline').catch((error: any) =>
                console.error('Failed to mark device offline after local MCP loss:', error.message));
        }
        try {
            await this.desktop.ensureReady();
            this.remoteChannel.syncReachabilityStatus();
            console.log(`♻️  Local Desktop Commander MCP restarted (${reason})`);
        } catch (error: any) {
            console.error(`❌ Could not restart local Desktop Commander MCP: ${error.message}`);
            await captureRemote('remote_device_local_mcp_restart_failed', { error, reason });
        }
    }

    /** Record a handled call id, evicting the oldest once the cap is reached. */
    private rememberCallId(callId: string) {
        this.seenCallIds.add(callId);
        if (this.seenCallIds.size > SEEN_CALL_IDS_MAX) {
            // Sets iterate in insertion order — drop the oldest entry.
            const oldest = this.seenCallIds.values().next().value;
            if (oldest !== undefined) this.seenCallIds.delete(oldest);
        }
    }

    async handleNewToolCall(payload: any) {
        const toolCall = payload.new;
        // Expect toolCall to include a device_id field used to route calls to this device instance.
        const { id: call_id, tool_name, tool_args, device_id, metadata = {} } = toolCall;

        console.debug('[DEBUG] Tool call received, device_id:', device_id, 'this.deviceId:', this.deviceId);

        // Only process jobs for this device
        if (device_id && device_id !== this.deviceId) {
            console.debug('[DEBUG] Ignoring tool call for different device');
            return;
        }

        console.log(`🔧 Received tool call ${call_id}: ${tool_name} ${JSON.stringify(tool_args)} metadata: ${JSON.stringify(metadata)}`);

        // LOCAL claim first — this is the authoritative guard against executing
        // a call twice. During the transition both transports deliver every call
        // to THIS SAME PROCESS, so an in-memory check is sufficient and, unlike
        // the DB claim below, cannot fail open: a transient REST error made
        // markCallExecuting return true for both deliveries, which could run a
        // side-effecting command twice (found in review, 2026-07-24).
        if (this.seenCallIds.has(call_id)) {
            console.debug('[DEBUG] Duplicate delivery for call already handled here, skipping:', call_id);
            return;
        }
        this.rememberCallId(call_id);

        try {
            // DB claim second — keeps the row state machine honest, gives
            // cross-restart/cross-process protection, and is observable. It may
            // fail open (returns true on a transient write error); the local
            // guard above is what makes execution exactly-once. The doorbell
            // path claims before dispatch and marks the payload `claimed`.
            const claimed = payload.claimed === true || await this.remoteChannel.markCallExecuting(call_id);
            if (!claimed) {
                // markCallExecuting already logged the duplicate-delivery skip.
                return;
            }

            let result;

            // Handle 'ping' tool specially
            if (tool_name === 'ping') {
                result = {
                    content: [{
                        type: 'text',
                        text: `pong ${new Date().toISOString()}`
                    }]
                };
            } else if (tool_name === 'shutdown') {
                result = {
                    content: [{
                        type: 'text',
                        text: `Shutdown initialized at ${new Date().toISOString()}`
                    }]
                };

                // Trigger shutdown after sending response
                setTimeout(async () => {
                    console.log('🛑 Remote shutdown requested. Exiting...');
                    await this.shutdown();
                    process.exit(0);
                }, 1000);
            } else {
                // Execute other tools using desktop integration
                result = await this.desktop.callClientTool(tool_name, tool_args, metadata);
            }

            console.log(`✅ Tool call ${tool_name} completed:\r\n ${JSON.stringify(result)}`);

            // Update database with result, THEN ring the doorbell — the server
            // fetches the row by id on the doorbell, so the write must land first.
            await this.remoteChannel.updateCallResult(call_id, 'completed', result);
            await this.remoteChannel.notifyResult(call_id);

        } catch (error: any) {
            console.error(`❌ Tool call ${tool_name} failed:`, error.message);
            // The failure path must not fail: this method's promise is discarded
            // at every call site, so a throw here becomes an unhandled rejection
            // and takes the device process down.
            try {
                await captureRemote('remote_device_tool_call_failed', { error, tool_name });
                await this.remoteChannel.updateCallResult(call_id, 'failed', null, error.message);
                await this.remoteChannel.notifyResult(call_id);
            } catch (reportError: any) {
                console.error(`❌ Could not report failure for ${call_id}:`, reportError?.message);
            }
        }
    }

    shutdown(): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.isShuttingDown = true;
        this.shutdownPromise = withTimeout(
            this.shutdownInternal(),
            DEVICE_SHUTDOWN_TIMEOUT_MS,
            'Remote device shutdown'
        );
        return this.shutdownPromise;
    }

    private async shutdownInternal(): Promise<void> {
        console.log('\n🛑 Shutting down device...');
        console.debug('[DEBUG] Shutdown initiated for device:', this.deviceId);

        // Every cleanup stage is independent: a remote teardown error must
        // never skip closing the owned local MCP child.
        try {
            console.log('  → Stopping heartbeat...');
            console.debug('[DEBUG] Calling stopHeartbeat()');
            this.remoteChannel.stopHeartbeat();
            console.log('  ✓ Heartbeat stopped');
        } catch (error: any) {
            console.error('Heartbeat shutdown error:', error.message);
        }

        // Close the owned local MCP child before any remote bookkeeping wait.
        // Even if a remote status request is wedged, local execution cannot be
        // orphaned and the outer shutdown deadline remains meaningful.
        try {
            console.log('  → Shutting down desktop integration...');
            console.debug('[DEBUG] Calling desktop.shutdown()');
            await this.desktop.shutdown();
            console.log('  ✓ Desktop integration shut down');
        } catch (error: any) {
            console.error('Desktop integration shutdown error:', error.message);
            captureRemote('remote_device_shutdown_error', { error, component: 'desktop' }).catch(() => { });
        }

        try {
            console.log('  → Unsubscribing from channel...');
            console.debug('[DEBUG] Calling channel.unsubscribe()');
            await this.remoteChannel.unsubscribe();
        } catch (error: any) {
            console.error('Channel unsubscribe error:', error.message);
            captureRemote('remote_device_shutdown_error', { error, component: 'channel' }).catch(() => { });
        }

        try {
            console.log('  → Marking device offline...');
            console.debug('[DEBUG] Calling setOffline() with deviceId:', this.deviceId);
            await this.remoteChannel.setOffline(this.deviceId);
        } catch (error: any) {
            console.error('Offline status error:', error.message);
            captureRemote('remote_device_shutdown_error', { error, component: 'status' }).catch(() => { });
        }

        console.log('✓ Device shutdown complete');
        console.debug('[DEBUG] Shutdown sequence completed');
    }
}

// Start device if called directly or as a bin command
// When installed globally, npm creates a wrapper, so we need to check multiple conditions
const isMainModule = process.argv[1] && (
    // Direct execution: node device.js
    import.meta.url === `file://${process.argv[1]}` ||
    fileURLToPath(import.meta.url) === process.argv[1] ||
    // Global bin execution: desktop-commander-device (npm creates a wrapper)
    process.argv[1].endsWith('desktop-commander-device') ||
    process.argv[1].endsWith('desktop-commander-device.js')
);

if (isMainModule) {
    // Parse command-line arguments
    const args = process.argv.slice(2);
    const options = {
        // --persist-session is kept as an accepted no-op so existing invocations
        // and docs keep working; --no-persist-session opts back out.
        persistSession: !args.includes('--no-persist-session')
    };

    if (!options.persistSession) {
        console.log('🔓 Session persistence disabled — re-authorization required on every start');
    }

    if (!args.includes('--standalone')) {
        console.error('Remote Desktop Commander requires explicit --standalone opt-in');
        process.exitCode = 1;
    } else {
        const device = new MCPDevice({ ...options, standalone: true });
        device.start().catch((error) => {
            console.error(JSON.stringify({
                event: 'remote_device_fatal',
                error: error instanceof Error ? error.message : String(error),
            }));
            process.exitCode = 1;
        });
    }
}
