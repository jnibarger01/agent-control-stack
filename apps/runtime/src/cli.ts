import { installRuntimeShutdown } from "./lifecycle.js";
import { loadRuntimeConfig } from "./config.js";
import { startAcsRuntime } from "./index.js";
import { runLogin } from "./auth/login.js";
import { runLogout } from "./auth/logout.js";
import { runStatus } from "./auth/status.js";

const USAGE = "Usage: acs serve | acs auth login [--acs-url <url>] [--no-open] | acs auth status | acs auth logout";

async function main(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv;

  if (command === "serve") {
    const runtime = await startAcsRuntime(loadRuntimeConfig());
    installRuntimeShutdown(runtime);
    return 0;
  }

  if (command === "auth") {
    if (sub === "login") {
      const acsUrl = flagValue(rest, "--acs-url") ?? process.env.ACS_URL;
      if (!acsUrl) {
        console.error("acs auth login requires --acs-url <url> or ACS_URL");
        return 1;
      }
      const result = await runLogin({ acsUrl, openBrowser: !rest.includes("--no-open") });
      return result.ok ? 0 : 1;
    }
    if (sub === "status") {
      const report = runStatus();
      return report.connectionState === "authenticated" ? 0 : 1;
    }
    if (sub === "logout") {
      runLogout();
      return 0;
    }
  }

  console.error(USAGE);
  return 1;
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

process.exitCode = await main(process.argv.slice(2));
