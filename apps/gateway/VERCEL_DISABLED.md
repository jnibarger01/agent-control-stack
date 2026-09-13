# Vercel deployment boundary

The ACS **gateway** is intentionally **not** deployed to Vercel.

It requires a long-running Node process, persistent SQLite storage, and the
repository-root Docker/Compose (or equivalent host) runtime. Serverless hosts
and an empty team Vercel project list for the gateway are expected and correct.

**Canonical operator map:** [README → Deploy](../../README.md#deploy) (supported:
local loopback, Docker/Compose, systemd, authenticated reverse-proxy/tunnel).

The adjacent `vercel.json` sets `ignoreCommand` to `exit 0` so the legacy
`agent-control-stack-gateway` Vercel project ignores Git-triggered builds.

The only Vercel-oriented surface in this repository is the static marketing site
`apps/public-site`. That site is **not** the control-plane gateway or the
operator dashboard. The dashboard is served by the gateway at `/`.
