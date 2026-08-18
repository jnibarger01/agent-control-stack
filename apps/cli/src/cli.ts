#!/usr/bin/env node
import { runAcsCli } from "./dispatch.js";

process.exitCode = await runAcsCli(process.argv.slice(2));
