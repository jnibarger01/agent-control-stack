import { protectedResourceMetadataFromEnv } from "../src/auth-config.js";

export const config = {
  maxDuration: 10
};

export default {
  fetch() {
    const metadata = protectedResourceMetadataFromEnv();
    if (!metadata) {
      return Response.json(
        { error: "oauth_not_configured" },
        { status: 404, headers: { "cache-control": "no-store" } }
      );
    }
    return Response.json(metadata, {
      status: 200,
      headers: { "cache-control": "no-store" }
    });
  }
};
