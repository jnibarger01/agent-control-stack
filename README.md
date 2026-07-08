# Agent Control Stack

Agent Control Stack is a local-first control plane for policy-gated agent work. This alpha is a dry-run control-plane release: it evaluates requested actions, records audit events, binds approvals to exact action hashes, leases approved work to a local worker, and persists dry-run worker results.

It does not provide real command execution, OS sandbox isolation, a hardened worker runtime, production-safe machine mutation, or production remote connector mode.

## What This Alpha Can Claim

- Policy evaluation for requested work-item actions.
- Hash-bound approval lifecycle with request hashes and consumed approval records.
- Tamper-detecting audit chain with mutation fail-closed behavior after invalid chain detection.
- Local-boundary worker claim and lease flow.
- Dry-run execution simulation with `execution_mode: "dry_run"` attested in worker result audit events.

## What This Alpha Must Not Claim

- Real command execution.
- Sandbox isolation.
- Hardened worker runtime.
- Production-safe filesystem, shell, service, or package mutation.
- Production-ready remote connector operation.

## Local Validation

```sh
npm ci
npm run check
```

`npm run check` runs the TypeScript build and the Vitest suite.

## Run Locally

```sh
ACS_DB_PATH=storage/local.db \
ACS_GATEWAY_TOKEN=local-dev-token \
npm run start:gateway
```

Use the gateway and worker only as a dry-run control-plane loop until the execution slice adds real sandboxing and passes its own release gate.
