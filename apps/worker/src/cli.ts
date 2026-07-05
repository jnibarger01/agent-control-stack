import { runWorkerOnce } from "./index.js";

const result = await runWorkerOnce();
console.log(JSON.stringify(result));
