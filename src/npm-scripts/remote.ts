import { MCPDevice } from '../remote-device/device.js';
import os from 'os';

export interface RemoteMode {
    standalone: boolean;
    managed: boolean;
    managedMcpUrl?: string;
}

/**
 * Single canonical validation of the remote-device CLI mode flags: exactly one
 * of --standalone / --managed, and DC_MANAGED_MCP_URL when --managed. The two
 * entrypoints (index.ts pre-check and runRemote) previously duplicated this
 * logic; drift between them would let an invalid invocation pass one check
 * and fail later with a less precise error.
 */
export function parseRemoteMode(argv: string[] = process.argv): RemoteMode {
    const standalone = argv.includes('--standalone');
    const managed = argv.includes('--managed');

    if (standalone === managed) {
        throw new Error('Remote Desktop Commander requires exactly one of --standalone or --managed');
    }

    const managedMcpUrl = managed ? process.env.DC_MANAGED_MCP_URL : undefined;
    if (managed && !managedMcpUrl) {
        throw new Error('DC_MANAGED_MCP_URL is required with --managed');
    }

    return { standalone, managed, managedMcpUrl };
}

export async function runRemote() {
    // --persist-session is kept as an accepted no-op so existing invocations
    // and docs keep working; --no-persist-session opts back out.
    const persistSession = !process.argv.includes('--no-persist-session');
    if (!persistSession) {
        console.log('🔓 Session persistence disabled — re-authorization required on every start');
    }
    const disableNoSleep = process.argv.includes('--disable-no-sleep');
    const verbose = process.argv.includes('--debug');
    console.debug('[DEBUG] Verbose mode: ', verbose);
    // Override console.debug based on verbose flag
    // When --debug is not provided, console.debug becomes a no-op
    if (!verbose) {
        console.debug = () => { };
    }

    console.debug('[DEBUG] Platform:', os.platform());

    // Start caffeinate on macOS (unless disabled)
    // Caffeinate will monitor this process and automatically exit when it terminates
    if (!disableNoSleep && os.platform() === 'darwin') {
        try {
            console.debug('[DEBUG] Start caffeinate', process.pid);
            const { default: caffeinate } = await import('caffeinate');
            caffeinate({ pid: process.pid });
            console.log('☕ No sleep mode enabled');
        } catch (error) {
            console.warn('⚠️ Failed to start caffeinate:', error);
        }
    }

    // Single canonical validation (shared with the index.ts pre-check).
    const { standalone, managedMcpUrl } = parseRemoteMode();

    const device = new MCPDevice({
        persistSession,
        standalone,
        managedMcpUrl,
    });
    await device.start();
}
