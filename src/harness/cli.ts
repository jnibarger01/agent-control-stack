#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DesktopCommanderAgent } from './openai-agent.js';

interface CliOptions {
  model?: string;
  systemPath?: string;
  approveMutations: boolean;
  maxToolRounds?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  mode: 'standalone' | 'managed';
  prompt: string[];
  help: boolean;
}

function usage(): string {
  return `Desktop Commander ChatGPT harness

Usage:
  dc-agent [options] [prompt...]
  npm run agent -- [options] [prompt...]

Options:
  --model <id>              OpenAI model (default: OPENAI_MODEL or gpt-5.6)
  --system <path>           SYSTEM.md path
  --reasoning <effort>      none|low|medium|high|xhigh|max
  --max-tool-rounds <n>     Maximum tool-call rounds (default: 24)
  --approve-mutations       Treat this invocation as upfront approval for mutating tools
  --mode <mode>             standalone|managed (default: standalone)
  -h, --help                Show this help

Managed mode requires an embedding caller to provide fresh ACS metadata per tool call.
`;
}
function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const parsed: CliOptions = {
    approveMutations: false,
    mode: 'standalone',
    prompt: [],
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') parsed.help = true;
    else if (arg === '--approve-mutations' || arg === '--approve-writes') parsed.approveMutations = true;
    else if (arg === '--model') parsed.model = requireValue(args, index++, arg);
    else if (arg === '--system') parsed.systemPath = requireValue(args, index++, arg);
    else if (arg === '--max-tool-rounds') {
      const value = Number(requireValue(args, index++, arg));
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error('--max-tool-rounds must be an integer between 1 and 100');
      }
      parsed.maxToolRounds = value;
    } else if (arg === '--reasoning') {
      const value = requireValue(args, index++, arg);
      if (!['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
        throw new Error('--reasoning must be none|low|medium|high|xhigh|max');
      }
      parsed.reasoningEffort = value as CliOptions['reasoningEffort'];
    } else if (arg === '--mode') {
      const value = requireValue(args, index++, arg);
      if (value !== 'standalone' && value !== 'managed') {
        throw new Error('--mode must be standalone or managed');
      }
      parsed.mode = value;
    } else {
      parsed.prompt.push(arg);
    }
  }
  return parsed;
}
function previewArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args, null, 2);
  return text.length <= 1200 ? text : `${text.slice(0, 1200)}\n... [truncated]`;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    stdout.write(usage());
    return;
  }
  if (cli.mode === 'managed') {
    throw new Error('The CLI cannot mint ACS capabilities. Embed DesktopCommanderAgent with toolMetaProvider for managed mode.');
  }

  const terminal = readline.createInterface({ input: stdin, output: stdout });
  const agent = new DesktopCommanderAgent({
    model: cli.model,
    systemPath: cli.systemPath,
    approveMutations: cli.approveMutations,
    maxToolRounds: cli.maxToolRounds,
    reasoningEffort: cli.reasoningEffort,
    mode: cli.mode,
    approval: async ({ toolName, args }) => {
      if (!stdin.isTTY) return false;
      stdout.write(`\nMutation requested: ${toolName}\n${previewArgs(args)}\n`);
      const answer = await terminal.question('Approve this tool call? [y/N] ');
      return /^(y|yes)$/i.test(answer.trim());
    },
  });

  try {
    if (cli.prompt.length > 0) {
      stdout.write(`${await agent.run(cli.prompt.join(' '))}\n`);
      return;
    }
    stdout.write('Desktop Commander agent harness. /help for commands.\n');
    while (true) {
      const prompt = (await terminal.question('dc> ')).trim();
      if (!prompt) continue;
      if (prompt === '/exit' || prompt === '/quit') break;
      if (prompt === '/clear') {
        agent.clearConversation();
        stdout.write('Conversation state cleared.\n');
        continue;
      }
      if (prompt === '/help') {
        stdout.write('/clear  clear OpenAI conversation state\n/exit   quit\n');
        continue;
      }

      try {
        stdout.write(`${await agent.run(prompt)}\n`);
      } catch (error) {
        process.stderr.write(`Agent error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    await agent.shutdown().catch(() => undefined);
    terminal.close();
  }
}

main().catch((error) => {
  process.stderr.write(`dc-agent: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
