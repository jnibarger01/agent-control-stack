import { fileURLToPath } from "node:url";

/**
 * Directory holding the built Mission Control SPA (scripts/build-control-console.mjs
 * writes it to apps/control-ui/dist/app). The gateway serves it read-only under /console/*.
 */
export const CONSOLE_ASSET_DIR: string = fileURLToPath(new URL("./app", import.meta.url));
