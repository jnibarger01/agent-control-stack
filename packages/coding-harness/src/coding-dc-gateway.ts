import type {
  DesktopCommanderMachineExecutor,
  ExecutionAuthorization
} from "@agent-control-stack/desktop-commander-adapter";
import type { NormalizedToolRequest, AcsToolGateway, ToolObservation } from "./coding-tools.js";

export interface ManagedExecutionAuthorizer {
  authorize(request: NormalizedToolRequest, signal?: AbortSignal): Promise<ExecutionAuthorization>;
}

export class DesktopCommanderAcsGateway implements AcsToolGateway {
  constructor(
    private readonly executor: Pick<DesktopCommanderMachineExecutor, "execute">,
    private readonly authorizer: ManagedExecutionAuthorizer
  ) {}
  async execute(request: NormalizedToolRequest, signal?: AbortSignal): Promise<ToolObservation> {
    const authorization = await this.authorizer.authorize(request, signal);
    const result = await this.executor.execute({ authorization, signal });
    return {
      ok: !result.isError,
      output: result.output,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      evidenceHash: result.resultHash
    };
  }
}
