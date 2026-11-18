import { cases } from "./datasets.mjs";

// Rust Anything's JSONL uses markers for JS strings that cannot be represented in UTF-8.
function encode(_key, value) {
  if (typeof value !== "string" || value.isWellFormed()) return value;
  return { $utf16: Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)) };
}

for (const [prs, target] of cases()) {
  console.log(JSON.stringify({ fn: "analyzeDependencies", args: [prs, target] }, encode));
  console.log(JSON.stringify({ fn: "findOverlaps", args: [prs] }, encode));
}
