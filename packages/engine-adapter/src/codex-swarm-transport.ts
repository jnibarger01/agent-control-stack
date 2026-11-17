import net from "node:net";
import type { SwarmExecutionEvidence } from "./codex-swarm-envelope.js";
import type { CodexSwarmAcsTransport } from "./codex-swarm.js";

/** Simple line-delimited JSON /acs/v1 unix-socket transport client. */
export function createUnixSocketAcsTransport(socketPath: string): CodexSwarmAcsTransport {
  return {
    async execute({ envelope, secret, signal }) {
      return await new Promise<SwarmExecutionEvidence>((resolve, reject) => {
        const sock = net.createConnection(socketPath);
        let buf = "";
        const onAbort = () => { sock.destroy(new Error("cancelled")); };
        signal?.addEventListener("abort", onAbort, { once: true });
        sock.setEncoding("utf8");
        sock.on("connect", () => {
          sock.write(JSON.stringify({ method: "execute", params: { envelope, secret } }) + "\n");
        });
        sock.on("data", (chunk) => { buf += chunk; });
        sock.on("error", (e) => { signal?.removeEventListener("abort", onAbort); reject(e); });
        sock.on("close", () => {
          signal?.removeEventListener("abort", onAbort);
          try {
            const line = buf.trim().split("\n").pop() ?? "";
            const msg = JSON.parse(line);
            if (msg && msg.ok) resolve(msg.evidence as SwarmExecutionEvidence);
            else reject(new Error(msg?.error || "acs_v1_transport_error"));
          } catch (e) { reject(e); }
        });
      });
    },
  };
}
