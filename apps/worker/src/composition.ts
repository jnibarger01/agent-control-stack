import {
  ClaudeEngineAdapter,
  EngineAdapterRegistry,
  GeminiEngineAdapter,
  GrokEngineAdapter,
  OpenCodeEngineAdapter,
  PiEngineAdapter
} from "@agent-control-stack/engine-adapter";
import type { EngineIsolationAuthorityVerifier } from "@agent-control-stack/sandbox";
import { routeAndPersistActor, type ActorRoutingInput } from "@agent-control-stack/actor-router";
import {
  ExecutionController,
  type ExecutionControllerInput,
  type ExecutionControllerStore
} from "@agent-control-stack/execution-controller";
import { ResultValidator } from "@agent-control-stack/result-validation";
import type { RegistryAgentDetail, SqliteWorkItemStore } from "@agent-control-stack/work-items";
import type { WorkspaceManager } from "@agent-control-stack/workspace-manager";

/** This P0 composition is intentionally simulation-only. */
export const executionMode = "dry_run" as const;

export interface GovernedExecutionCompositionOptions {
  store: SqliteWorkItemStore;
  workspaceManager: WorkspaceManager;
  authorityVerifier: EngineIsolationAuthorityVerifier;
  validator?: ResultValidator;
}

export interface GovernedExecutionComposition {
  readonly registry: EngineAdapterRegistry;
  routeActor(input: {
    agents: RegistryAgentDetail[];
    routing: ActorRoutingInput & { workItemId: string; idempotencyKey: string; attemptId?: string };
  }): string;
  controllerFor(actorId: string, input: ExecutionControllerInput): ExecutionController;
}

/**
 * Composition root for the governed path:
 * authoritative routing -> selected adapter -> execution controller ->
 * independent validation and durable store/audit transitions.
 *
 * Publication is deliberately not invoked here. The controller result is
 * the only hand-off in dry_run; a future publication caller must still pass
 * the validator and lease checks at its own boundary.
 */
export function createGovernedExecutionComposition(
  options: GovernedExecutionCompositionOptions
): GovernedExecutionComposition {
  const adapterOptions = {
    authorityVerifier: options.authorityVerifier,
    binaryPath: "acs-provider-disabled-in-dry-run"
  };
  const registry = new EngineAdapterRegistry([
    new ClaudeEngineAdapter(adapterOptions),
    new GeminiEngineAdapter(adapterOptions),
    new GrokEngineAdapter(adapterOptions),
    new OpenCodeEngineAdapter(adapterOptions),
    new PiEngineAdapter(adapterOptions)
  ]);

  return {
    registry,
    routeActor({ agents, routing }) {
      const routed = routeAndPersistActor(agents, routing, options.store, { via: "domain_service" });
      if (!routed.decision.selected) {
        throw new Error("governed execution refused: no eligible actor");
      }
      if (!registry.get(routed.decision.selected)) {
        throw new Error(`governed execution refused: no adapter for actor ${routed.decision.selected}`);
      }
      return routed.decision.selected;
    },
    controllerFor(actorId, input) {
      if (executionMode !== "dry_run") {
        throw new Error("live execution is disabled by the P0 execution boundary");
      }
      const engine = registry.get(actorId);
      if (!engine) throw new Error(`governed execution refused: no adapter for actor ${actorId}`);
      return new ExecutionController({
        store: options.store as unknown as ExecutionControllerStore,
        workspaceManager: options.workspaceManager,
        engine,
        input,
        validator: options.validator ?? new ResultValidator(),
        buildValidationInput: ({ outcome, workspace }) => ({
          workspacePath: workspace.hostPath,
          outcome
        })
      });
    }
  };
}
