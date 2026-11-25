/* global module */
"use strict";

function pullRequestNumbers(prs) {
  if (!Array.isArray(prs)) return undefined;
  const seen = new Set();
  const numbers = [];
  for (const pr of prs) {
    const number = pr?.number;
    if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number)) return undefined;
    numbers.push(number);
    seen.add(number);
  }
  return numbers;
}

function stringIds() {
  const ids = new Map();
  return {
    id(value) {
      let id = ids.get(value);
      if (id === undefined) {
        id = ids.size + 1;
        ids.set(value, id);
      }
      return id;
    }
  };
}

function createGraphBridge(native) {
  if (
    native.graphAbiVersion?.() !== 1 ||
    typeof native.analyzeDependencies !== "function" ||
    typeof native.findOverlaps !== "function"
  ) {
    throw new TypeError("Incompatible ACS integration graph addon");
  }

  return {
    analyzeDependencies(prs, target) {
      const numbers = pullRequestNumbers(prs);
      if (numbers === undefined || typeof target !== "string") return undefined;
      const refs = stringIds();
      const heads = [];
      const bases = [];
      for (const pr of prs) {
        if (
          typeof pr.isCrossRepository !== "boolean" ||
          typeof pr.headRef !== "string" ||
          typeof pr.baseRef !== "string"
        ) {
          return undefined;
        }
        heads.push(pr.isCrossRepository ? 0 : refs.id(pr.headRef));
        bases.push(refs.id(pr.baseRef));
      }
      const result = native.analyzeDependencies(numbers, heads, bases, refs.id(target));
      return {
        dependsOn: new Map(numbers.map((number, row) => [number, result.parents[row]])),
        cyclic: new Set(result.cyclic),
        blockedByCycle: new Set(result.blockedByCycle),
        detached: new Set(result.detached),
        order: result.order
      };
    },

    findOverlaps(prs) {
      const numbers = pullRequestNumbers(prs);
      if (numbers === undefined) return undefined;
      const paths = stringIds();
      const byId = [""];
      const files = [];
      for (const pr of prs) {
        if (!Array.isArray(pr.changedFiles)) return undefined;
        const row = [];
        for (const file of pr.changedFiles) {
          if (typeof file !== "string") return undefined;
          const id = paths.id(file);
          if (id === byId.length) byId.push(file);
          row.push(id);
        }
        files.push(row);
      }
      const rows = native.findOverlaps(numbers, files);
      return new Map(
        numbers.map((number, row) => [
          number,
          rows[row].map((overlap) => ({
            number: overlap.number,
            files: overlap.files.map((id) => byId[id]).sort()
          }))
        ])
      );
    }
  };
}

module.exports = { createGraphBridge };
