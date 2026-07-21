import type { ClaimedWorkItem, SubmitWorkResultInput, WorkItem } from "@agent-control-stack/work-items";

export interface WorkerGatewayClientOptions {
  baseUrl: string;
  token: string;
  workerId: string;
  fetchImpl?: typeof fetch;
}

export interface WorkerGatewayClient {
  claim(leaseMs?: number): Promise<ClaimedWorkItem | undefined>;
  submit(
    id: string,
    input: { leaseToken: string; status: SubmitWorkResultInput["status"]; result?: Record<string, unknown> }
  ): Promise<WorkItem>;
}

export function createWorkerGatewayClient(options: WorkerGatewayClientOptions): WorkerGatewayClient {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = {
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
    "x-acs-worker-id": options.workerId
  };

  return {
    async claim(leaseMs) {
      const response = await fetchImpl(`${baseUrl}/worker/claim`, {
        method: "POST",
        headers,
        body: JSON.stringify(leaseMs === undefined ? {} : { leaseMs })
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(`worker claim failed (${response.status}): ${errorMessage(body)}`);
      }
      const workItem = body.workItem;
      if (workItem === null || workItem === undefined) return undefined;
      if (!isClaimedWorkItem(workItem)) {
        throw new Error("worker claim response did not contain a lease-bound work item");
      }
      return workItem;
    },
    async submit(id, input) {
      const response = await fetchImpl(`${baseUrl}/work-items/${encodeURIComponent(id)}/results`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          id,
          workerId: options.workerId,
          leaseToken: input.leaseToken,
          status: input.status,
          result: input.result ?? {}
        })
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(`worker result submission failed (${response.status}): ${errorMessage(body)}`);
      }
      if (!body.workItem || typeof body.workItem !== "object") {
        throw new Error("worker result response did not contain a work item");
      }
      return body.workItem as WorkItem;
    }
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json().catch(() => ({}));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function errorMessage(body: Record<string, unknown>): string {
  return typeof body.error === "string" ? body.error : "unknown worker gateway error";
}

function isClaimedWorkItem(value: unknown): value is ClaimedWorkItem {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).workerId === "string" &&
    typeof (value as Record<string, unknown>).leaseToken === "string" &&
    typeof (value as Record<string, unknown>).leaseExpiresAt === "string" &&
    typeof (value as Record<string, unknown>).leaseId === "string"
  );
}
