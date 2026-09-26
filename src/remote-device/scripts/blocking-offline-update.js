#!/usr/bin/env node

/**
 * Blocking script to update device status to offline
 * Runs synchronously during shutdown to ensure DB update completes
 *
 * Usage: node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey> <statusTimestamp>
 *        stdin: {"access_token":"..."}
 *
 * The access token arrives on stdin only (argv is visible to every local user
 * via ps). No refresh token is ever passed, and this process never refreshes:
 * a refresh here would rotate the parent's single-use refresh token. An expired
 * access token exits 2 without writing; the server's staleness sweep covers it.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// Parse command line arguments
const [deviceId, supabaseUrl, supabaseKey, statusTimestamp] = process.argv.slice(2);

if (!deviceId || !supabaseUrl || !supabaseKey || !statusTimestamp || Number.isNaN(Date.parse(statusTimestamp))) {
    console.error('❌ Missing required arguments');
    console.error('Usage: node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey> <statusTimestamp>  (access token on stdin)');
    process.exit(1);
}

let accessToken;
try {
    accessToken = JSON.parse(readFileSync(0, 'utf8')).access_token;
} catch {
    accessToken = undefined;
}
if (typeof accessToken !== 'string' || accessToken.split('.').length !== 3) {
    console.error('❌ Missing access token on stdin');
    process.exit(1);
}

function tokenExpired(token) {
    try {
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now() + 5_000;
    } catch {
        return true;
    }
}
if (tokenExpired(accessToken)) {
    console.error('⏱️ Access token expired; skipping offline write (no refresh in this process)');
    process.exit(2);
}

// Set timeout for entire operation
const TIMEOUT_MS = 3000;
const timeoutHandle = setTimeout(() => {
    console.error('⏱️ Timeout: Update took too long');
    process.exit(2); // Exit code 2 for timeout
}, TIMEOUT_MS);

try {
    const client = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    // Update device status to offline, stamping the exact shutdown moment so
    // "last seen X ago" is precise for clean shutdowns (the periodic
    // bookkeeping write only runs on the slow capable cadence).
    const { error } = await client
        .from('mcp_devices')
        .update({ status: 'offline', last_seen: statusTimestamp })
        .eq('id', deviceId)
        .lte('last_seen', statusTimestamp);

    clearTimeout(timeoutHandle);

    if (error) {
        console.error('❌ DB update error:', error.message);
        process.exit(4); // Exit code 4 for DB error
    }

    console.log('✓ Device marked as offline');
    process.exit(0); // Success

} catch (error) {
    clearTimeout(timeoutHandle);
    console.error('❌ Unexpected error:', error.message);
    process.exit(5); // Exit code 5 for unexpected error
}
