import assert from "node:assert/strict";
import os from "node:os";
import { performance } from "node:perf_hooks";
import * as typescript from "../../packages/integration-manager/src/graph.ts";
import native from "./index.cjs";
import { workload } from "./datasets.mjs";

function ordered(result) {
  if (result instanceof Map) return [...result];
  return Object.fromEntries(
    Object.entries(result).map(([name, value]) => [
      name,
      value instanceof Map || value instanceof Set ? [...value] : value
    ])
  );
}

function timed(fn, args, repetitions) {
  const start = performance.now();
  for (let iteration = 0; iteration < repetitions; iteration++) fn(...args);
  return (performance.now() - start) / repetitions;
}

function median(samples) {
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

const rows = [];
for (const [dataset, count, dense, repetitions] of [
  ["routine", 24, false, 300],
  ["GitHub single-page limit", 100, true, 60],
  ["stacked and overlapping", 150, true, 40],
  ["large stress", 1500, false, 3]
]) {
  const prs = workload(count, dense);
  // Reconciliation sorts snapshots by PR number before invoking the kernels.
  prs.sort((a, b) => a.number - b.number);
  for (const [fn, args] of [
    ["analyzeDependencies", [prs, "main"]],
    ["findOverlaps", [prs]]
  ]) {
    const js = typescript[fn];
    const rust = native[fn];
    assert.deepEqual(ordered(rust(...args)), ordered(js(...args)), `${dataset} ${fn}`);
    for (const implementation of [js, rust]) timed(implementation, args, Math.min(repetitions, 30));
    const jsSamples = [];
    const rustSamples = [];
    for (let round = 0; round < 7; round++) {
      for (const [implementation, samples] of round % 2
        ? [
            [rust, rustSamples],
            [js, jsSamples]
          ]
        : [
            [js, jsSamples],
            [rust, rustSamples]
          ]) {
        samples.push(timed(implementation, args, repetitions));
      }
    }
    const typescriptMs = median(jsSamples);
    const nativeMs = median(rustSamples);
    rows.push({
      dataset,
      pullRequests: count,
      fn,
      repetitions,
      typescriptMs,
      nativeMs,
      speedup: typescriptMs / nativeMs
    });
  }
}
console.log(
  JSON.stringify(
    { node: process.version, arch: process.arch, os: os.platform(), cpu: os.cpus()[0].model, rows },
    null,
    2
  )
);
