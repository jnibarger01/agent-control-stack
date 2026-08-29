# Public contract artifacts

`v1/` is generated from the Zod schemas used by the gateway at runtime. Do not
edit generated JSON by hand.

Run `npm run contracts:generate` after changing a public boundary. CI and
`npm run check` run `npm run contracts:check`, which regenerates in memory,
validates the examples, compares committed artifacts byte-for-byte, and checks
the compatibility baseline.

The compatibility checker classifies operation or tool removal, property
removal, and newly required properties as breaking. A deliberate breaking
change requires:

1. a major contract-version change in `public-contracts.ts`;
2. an entry in `breaking-changes.json` using the checker-reported identifier;
3. migration guidance in the release notes; and
4. an explicit `npm run contracts:baseline` after review.

The compatibility baseline is not a generated deliverable consumed by clients.
It is the reviewed v1 surface against which later generation is classified.
