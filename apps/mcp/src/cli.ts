import { MachineController, loadMachineControllerConfig } from "@agent-control-stack/machine-controller";
import { McpStdioServer } from "./server.js";

const configPath = configPathFromArgs(process.argv.slice(2)) ?? process.env.ACS_MCP_CONFIG;
const config = loadMachineControllerConfig(configPath);
new McpStdioServer(process.stdin, process.stdout, new MachineController(config)).start();

function configPathFromArgs(args: string[]): string | undefined {
  const index = args.indexOf("--config");
  return index >= 0 ? args[index + 1] : undefined;
}
