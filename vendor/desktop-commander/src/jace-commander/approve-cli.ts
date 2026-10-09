/**
 * Human side of local approval (ADR 0026 D4): `jace-commander approve|reject|pending`.
 *
 * Talks to decide.sock only, which the `jc` server account cannot reach. `approve`
 * additionally requires an interactive TTY on stdin AND stdout and a typed
 * confirmation of the invocation hash, so a script, a piped process or a model
 * driving a child process cannot approve its own request.
 */
import os from 'node:os';
import { approverCall, ApproverUnavailable } from './approver-client.js';
import { redactSecrets } from './looptrace.js';

export interface ApproveIo {
  stdout(text: string): void;
  stderr(text: string): void;
  isTty: boolean;
  /** Reads one line from the operator. */
  prompt(question: string): Promise<string>;
}

export interface ApproveDeps {
  decideSocket: string | undefined;
  approverId?: string;
  io: ApproveIo;
}

export const APPROVE_EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, notAllowed: 3, unavailable: 5 });

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

function displayArgs(args: unknown): string {
  // Display only: the approval binds the exact bytes via the invocation hash.
  return redactSecrets(JSON.stringify(args, null, 2)).text;
}

export async function runApproveCommand(command: 'approve' | 'reject' | 'pending', args: string[], deps: ApproveDeps): Promise<number> {
  const { io } = deps;
  if (!deps.decideSocket) {
    io.stderr('jace-commander: set JC_APPROVER_DECIDE_SOCKET to the approverd decide socket');
    return APPROVE_EXIT.usage;
  }
  const approverId = deps.approverId ?? os.userInfo().username.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
  try {
    if (command === 'pending') {
      const reply = await approverCall(deps.decideSocket, { op: 'list' });
      const pending = Array.isArray(reply.pending) ? reply.pending as Array<Record<string, string>> : [];
      if (pending.length === 0) io.stdout('no pending approvals');
      for (const item of pending) io.stdout(`${item.id}  ${item.riskClass.padEnd(10)} ${item.tool}  requested ${item.requestedAt}  expires ${item.expiresAt}`);
      return APPROVE_EXIT.ok;
    }

    const id = args[0];
    if (!id || !ID.test(id)) {
      io.stderr(`usage: jace-commander ${command} <approval-id>`);
      return APPROVE_EXIT.usage;
    }
    // Decisions need a human at a terminal. Refuse before showing or sending anything.
    if (!io.isTty) {
      io.stderr(`jace-commander: ${command} requires an interactive terminal (stdin and stdout must be a TTY)`);
      return APPROVE_EXIT.notAllowed;
    }
    const shown = await approverCall(deps.decideSocket, { op: 'show', id });
    if (shown.ok !== true || typeof shown.approval !== 'object' || shown.approval === null) {
      io.stderr(`jace-commander: no such approval (${String(shown.code ?? 'unknown')})`);
      return APPROVE_EXIT.failed;
    }
    const approval = shown.approval as Record<string, unknown>;
    if (approval.status !== 'pending') {
      io.stderr(`jace-commander: approval ${id} is ${String(approval.status)}, not pending`);
      return APPROVE_EXIT.failed;
    }
    const hash = String(approval.invocationHash);
    io.stdout([
      `Approval ${id}`,
      `  tool:        ${String(approval.tool)}  (class ${String(approval.riskClass)})`,
      `  runtime:     ${String(approval.runtimeId)}`,
      `  requested:   ${String(approval.requestedAt)}   expires ${String(approval.expiresAt)}`,
      `  invocation:  ${hash}`,
      '  arguments:',
      ...displayArgs(approval.arguments).split('\n').map((line) => `    ${line}`),
      '',
    ].join('\n'));
    const prefix = hash.slice(0, 8);
    const answer = (await io.prompt(`Type ${prefix} to ${command} this exact action, anything else cancels: `)).trim();
    if (answer !== prefix) {
      io.stderr('cancelled; nothing was decided');
      return APPROVE_EXIT.failed;
    }
    const decided = await approverCall(deps.decideSocket, { op: 'decide', id, decision: command, confirmHash: hash, approverId });
    if (decided.ok !== true) {
      io.stderr(`jace-commander: decision refused (${String(decided.code ?? 'unknown')})`);
      return APPROVE_EXIT.failed;
    }
    io.stdout(`${command === 'approve' ? 'approved' : 'rejected'} ${id}. ${command === 'approve' ? 'Retry the identical tool call now; the approval is single-use.' : ''}`.trim());
    return APPROVE_EXIT.ok;
  } catch (error) {
    if (error instanceof ApproverUnavailable) {
      io.stderr(`jace-commander: ${error.message}`);
      return APPROVE_EXIT.unavailable;
    }
    throw error;
  }
}
