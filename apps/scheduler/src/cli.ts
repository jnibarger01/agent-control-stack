import { runSchedulerOnce } from "./index.js";

const result = await runSchedulerOnce();
console.log(JSON.stringify(result));
