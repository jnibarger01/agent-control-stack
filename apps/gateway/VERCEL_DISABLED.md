# Vercel deployment boundary

The ACS gateway is intentionally not deployed to Vercel. It requires the repository-root Docker runtime, persistent SQLite storage, and production authentication configuration.

The adjacent `vercel.json` causes the legacy `agent-control-stack-gateway` Vercel project to ignore Git-triggered builds. The supported Vercel target is `apps/public-site`.
