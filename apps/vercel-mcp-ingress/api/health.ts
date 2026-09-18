export const config = {
  maxDuration: 10
};

export default {
  fetch() {
    return Response.json(
      { status: "ok", transport: "vercel-queue" },
      {
        status: 200,
        headers: { "cache-control": "no-store" }
      }
    );
  }
};
