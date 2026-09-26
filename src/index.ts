#!/usr/bin/env node

// MUST be first: raises the libuv threadpool size before any fs work is
// submitted. See src/bootstrap.ts for why import order matters.
import './bootstrap.js';
import { FilteredStdioServerTransport } from './custom-stdio.js';
import { server, flushDeferredMessages, ensureCanonicalExecutorLease } from './server.js';
import { commandManager } from './command-manager.js';
import { configManager } from './config-manager.js';
import { featureFlagManager } from './utils/feature-flags.js';
import { runSetup } from './npm-scripts/setup.js';
import { runUninstall } from './npm-scripts/uninstall.js';
import { capture } from './utils/capture.js';
import { logToStderr, logger } from './utils/logger.js';
import { runRemote, parseRemoteMode } from './npm-scripts/remote.js';
import { ensureChromeAvailable } from './tools/pdf/markdown.js';
import { desktopCommanderExecutionMode, revokeManagedAcsRuntime } from './managed-acs-runtime.js';
import { reconcileSessionsOnStartup } from './session-reconciliation.js';
import { terminalManager } from './terminal-manager.js';

// Store messages to defer until after initialization
const deferredMessages: Array<{ level: string, message: string }> = [];
function deferLog(level: string, message: string) {
  deferredMessages.push({ level, message });
}

async function runServer() {
  try {
    // Check if first argument is "setup"
    if (process.argv[2] === 'setup') {
      await runSetup();
      return;
    }

    // Check if first argument is "remove"
    if (process.argv[2] === 'remove') {
      await runUninstall();
      return;
    }

    // Check if first argument is "remote"
    if (process.argv[2] === 'remote') {
      // Single canonical mode validation, shared with runRemote().
      parseRemoteMode();
      await runRemote();
      return;
    }

    // Parse command line arguments for onboarding control
    const DISABLE_ONBOARDING = process.argv.includes('--no-onboarding');
    if (DISABLE_ONBOARDING) {
      logToStderr('info', 'Onboarding disabled via --no-onboarding flag');
    }

    // Set global flag for onboarding control
    (global as any).disableOnboarding = DISABLE_ONBOARDING;

    const executionMode = desktopCommanderExecutionMode();
    logToStderr('info', `Desktop Commander execution mode: ${executionMode}`);

    // Item #2 ownership semantics: this process (the executor entrypoint)
    // claims the canonical executor lease — the remote-device supervisor that
    // spawned it does NOT claim (it is a relay/client, not an executor). Any
    // second executor refuses here, fail closed.
    ensureCanonicalExecutorLease();

    // Create transport FIRST so all logging gets properly buffered
    // This must happen before any code that might use logger.*
    const transport = new FilteredStdioServerTransport();

    // Export transport for use throughout the application
    global.mcpTransport = transport;

    if (executionMode === 'managed' && process.platform !== 'win32') {
      process.once('SIGUSR2', async () => {
        await revokeManagedAcsRuntime().catch(() => undefined);
        logToStderr('warning', 'Desktop Commander managed runtime revoked; closing session');
        await server.close().catch(() => undefined);
      });
    }

    try {
      deferLog('info', 'Loading configuration...');
      await configManager.loadConfig();
      deferLog('info', 'Configuration loaded successfully');

      // Initialize feature flags (non-blocking)
      deferLog('info', 'Initializing feature flags...');
      await featureFlagManager.initialize();

      // Reconcile durable process-session records (P2.1) against current OS
      // state before accepting any tool calls, so a session left over from
      // a prior run of this server is classified (recovered / stale /
      // quarantined-corrupt) rather than silently forgotten or, worse,
      // treated as live without verification.
      deferLog('info', 'Reconciling durable process sessions...');
      try {
        const summary = await reconcileSessionsOnStartup();
        for (const handle of summary.recovered) {
          terminalManager.registerRecoveredSession(handle);
        }
        deferLog(
          'info',
          `Session reconciliation: ${summary.recovered.length} recovered, ${summary.markedStale} stale, ` +
          `${summary.alreadyTerminal} already terminal, ${summary.corrupt} corrupt (quarantined), ${summary.pruned} pruned`
        );
      } catch (reconciliationError) {
        // Reconciliation failing must never block server startup — fail
        // closed on session recovery (no sessions get adopted this run),
        // not on the server itself starting.
        deferLog(
          'warning',
          `Session reconciliation failed, continuing with no recovered sessions: ${reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError)}`
        );
      }
    } catch (configError) {
      deferLog('error', `Failed to load configuration: ${configError instanceof Error ? configError.message : String(configError)}`);
      if (configError instanceof Error && configError.stack) {
        deferLog('debug', `Stack trace: ${configError.stack}`);
      }
      deferLog('warning', 'Continuing with in-memory configuration only');
      // Continue anyway - we'll use an in-memory config
    }

    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // If this is a JSON parsing error, log it to stderr but don't crash
      if (errorMessage.includes('JSON') && errorMessage.includes('Unexpected token')) {
        logger.error(`JSON parsing error: ${errorMessage}`);
        return; // Don't exit on JSON parsing errors
      }

      capture('run_server_uncaught_exception', {
        error: errorMessage
      });

      logger.error(`Uncaught exception: ${errorMessage}`);
      process.exit(1);
    });

    // Handle unhandled rejections
    process.on('unhandledRejection', async (reason) => {
      const errorMessage = reason instanceof Error ? reason.message : String(reason);

      // If this is a JSON parsing error, log it to stderr but don't crash
      if (errorMessage.includes('JSON') && errorMessage.includes('Unexpected token')) {
        logger.error(`JSON parsing rejection: ${errorMessage}`);
        return; // Don't exit on JSON parsing errors
      }

      capture('run_server_unhandled_rejection', {
        error: errorMessage
      });

      logger.error(`Unhandled rejection: ${errorMessage}`);
      process.exit(1);
    });

    capture('run_server_start');

    deferLog('info', 'Connecting server...');

    // Set up event-driven initialization completion handler
    server.oninitialized = () => {
      // This callback is triggered after the client sends the "initialized" notification
      // At this point, the MCP protocol handshake is fully complete
      transport.enableNotifications();

      // Flush all deferred messages from both index.ts and server.ts
      while (deferredMessages.length > 0) {
        const msg = deferredMessages.shift()!;
        transport.sendLog('info', msg.message);
      }
      flushDeferredMessages();

      // Now we can send regular logging messages
      transport.sendLog('info', 'Server connected successfully');
      transport.sendLog('info', 'MCP fully initialized, all startup messages sent');

      // Preemptively check/download Chrome for PDF generation (runs in background)
      ensureChromeAvailable();
    };

    await server.connect(transport);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`FATAL ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
      logger.debug(error.stack);
    }

    // Send a structured error notification
    const errorNotification = {
      jsonrpc: "2.0" as const,
      method: "notifications/message",
      params: {
        level: "error",
        logger: "desktop-commander",
        data: `Failed to start server: ${errorMessage} (${new Date().toISOString()})`
      }
    };
    process.stdout.write(JSON.stringify(errorNotification) + '\n');

    capture('run_server_failed_start_error', {
      error: errorMessage
    });
    process.exit(1);
  }
}

runServer().catch(async (error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`RUNTIME ERROR: ${errorMessage}`);
  console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
  process.stderr.write(JSON.stringify({
    type: 'error',
    timestamp: new Date().toISOString(),
    message: `Fatal error running server: ${errorMessage}`
  }) + '\n');


  capture('run_server_fatal_error', {
    error: errorMessage
  });
  process.exit(1);
});