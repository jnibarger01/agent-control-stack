import { strictCanonicalJsonV1, strictCanonicalSha256V1 } from "./strict-canonical-v1.js";

const input = JSON.parse(process.argv[2] ?? "null") as unknown;
process.stdout.write(
  JSON.stringify({
    canonical: strictCanonicalJsonV1(input),
    digest: strictCanonicalSha256V1(input)
  })
);
