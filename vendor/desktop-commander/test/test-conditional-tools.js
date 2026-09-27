#!/usr/bin/env node
/**
 * Test: Verify conditional tool registration based on client name
 * Tests that give_feedback_to_desktop_commander is excluded for desktop-commander client
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// Each spawned executor claims the canonical executor lease. Point HOME, the
// lease directory and the state directory at a throwaway tree so this test
// never contends with (or disturbs) a live executor on the host. The lease
// itself stays enabled.
const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dc-conditional-tools-"));
const isolatedEnv = {
    ...getDefaultEnvironment(),
    HOME: isolatedRoot,
    DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR: path.join(isolatedRoot, "lease"),
    DESKTOP_COMMANDER_STATE_DIR: path.join(isolatedRoot, "state"),
};

async function testConditionalTools() {
    console.log('\n=== Test: Conditional Tool Registration ===\n');

    // Test 1: Regular client (should include feedback tool)
    console.log('Test 1: Testing with regular client (should include feedback tool)...');
    const regularClient = new Client(
        {
            name: "test-client",
            version: "1.0.0"
        },
        {
            capabilities: {}
        }
    );

    const regularTransport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_ENTRY, "--standalone"],
        env: isolatedEnv
    });

    await regularClient.connect(regularTransport);
    const regularTools = await regularClient.listTools();

    const hasFeedbackRegular = regularTools.tools.some(t => t.name === 'give_feedback_to_desktop_commander');
    console.log(`   Tools count: ${regularTools.tools.length}`);
    console.log(`   Has give_feedback_to_desktop_commander: ${hasFeedbackRegular}`);

    if (hasFeedbackRegular) {
        console.log('   ✅ PASS: Feedback tool is included for regular client');
    } else {
        console.log('   ❌ FAIL: Feedback tool should be included for regular client');
        process.exit(1);
    }

    await regularClient.close();

    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 2: desktop-commander-app client (should exclude feedback tool and get_prompts)
    console.log('\nTest 2: Testing with desktop-commander-app client (should exclude feedback tool and get_prompts)...');
    const dcClient = new Client(
        {
            name: "desktop-commander-app",
            version: "1.0.0"
        },
        {
            capabilities: {}
        }
    );

    const dcTransport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_ENTRY, "--standalone"],
        env: isolatedEnv
    });

    await dcClient.connect(dcTransport);
    const dcTools = await dcClient.listTools();

    const hasFeedbackDC = dcTools.tools.some(t => t.name === 'give_feedback_to_desktop_commander');
    const hasGetPromptsDC = dcTools.tools.some(t => t.name === 'get_prompts');
    console.log(`   Tools count: ${dcTools.tools.length}`);
    console.log(`   Has give_feedback_to_desktop_commander: ${hasFeedbackDC}`);
    console.log(`   Has get_prompts: ${hasGetPromptsDC}`);

    if (!hasFeedbackDC) {
        console.log('   ✅ PASS: Feedback tool is excluded for desktop-commander-app client');
    } else {
        console.log('   ❌ FAIL: Feedback tool should be excluded for desktop-commander-app client');
        process.exit(1);
    }

    if (!hasGetPromptsDC) {
        console.log('   ✅ PASS: get_prompts is excluded for desktop-commander-app client');
    } else {
        console.log('   ❌ FAIL: get_prompts should be excluded for desktop-commander-app client');
        process.exit(1);
    }

    await dcClient.close();

    console.log('\n=== All Tests Passed! ===\n');
}

testConditionalTools()
    .catch(error => {
        console.error('Test failed:', error);
        process.exitCode = 1;
    })
    .finally(() => fs.rm(isolatedRoot, { recursive: true, force: true }));
