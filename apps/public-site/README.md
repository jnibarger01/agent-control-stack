# Public site deployment boundary

This app is the synthetic, static Vercel target. Configure the Vercel project root directory as `apps/public-site` and deploy only this Vite app.

The ACS gateway is not a Vercel target. It requires the Docker runtime in the repository root, a persistent `/data` volume for SQLite, loopback publication or an intentional authenticated proxy/tunnel, and production authentication variables. No deployment or Vercel project-setting changes are performed by repository tests.
