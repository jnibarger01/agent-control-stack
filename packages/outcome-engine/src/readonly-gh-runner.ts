import { PULL_REQUEST_BY_NUMBER_QUERY, parseRepository, type GhRunner } from "@agent-control-stack/integration-manager";

export class OutcomeReadError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "OutcomeReadError";
  }
}

/**
 * Wraps a `gh` runner so that the only invocation it will ever forward is the one by-number GraphQL query, with an
 * exactly positioned argv. `-X`, `--method`, `--input`, `@file` values, `--hostname`, `-H`, extra variables and reordered
 * arguments are all refused, so a bug elsewhere cannot turn the reader into a writer. The wrapper also names the case
 * where the command runner redacted the whole output (it does so when any substring looks like a token).
 */
export function createReadOnlyGhRunner(inner: GhRunner): GhRunner {
  return async (args) => {
    assertReadOnlyArgv(args);
    const result = await inner(args);
    if (result.exitCode === 0 && result.stdout.trim() === "[redacted]") {
      throw new OutcomeReadError(
        "github_response_redacted_by_runner",
        "the command runner redacted the whole GitHub response; treating the read as unavailable"
      );
    }
    return result;
  };
}

export function assertReadOnlyArgv(args: readonly string[]): void {
  const fail = (): never => {
    throw new OutcomeReadError(
      "gh_argv_not_allowed",
      "refusing a gh invocation that is not the read-only pull request query"
    );
  };
  if (args.length !== 10) fail();
  const [api, graphql, f1, query, f2, owner, f3, name, f4, number] = args as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string
  ];
  if (api !== "api" || graphql !== "graphql") fail();
  if (f1 !== "-f" || query !== `query=${PULL_REQUEST_BY_NUMBER_QUERY}`) fail();
  if (f2 !== "-F" || f3 !== "-F" || f4 !== "-F") fail();
  if (!owner.startsWith("owner=") || !name.startsWith("name=") || !number.startsWith("number=")) fail();
  try {
    parseRepository(`${owner.slice("owner=".length)}/${name.slice("name=".length)}`);
  } catch {
    fail();
  }
  if (!/^number=[1-9][0-9]{0,9}$/u.test(number)) fail();
}
