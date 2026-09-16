import type {
  CancellationProviderCapability,
  ProviderBootstrapDescriptorV1,
  ProviderFailureV1,
  ProviderHealthV1,
  ProviderSessionEpoch,
  ProviderVerifyInputV1,
  VerifiedCancellationPrincipalV1
} from "./provider.js";

export interface ProviderLifecycleSnapshot {
  state: ProviderHealthV1["state"];
  activeGeneration?: number;
  previousGeneration?: Readonly<{
    generation: number;
    overlapEndsAt: string;
  }>;
  revokedGenerations: ReadonlySet<number>;
  sessionEpochBindingHash: string;
}

/**
 * Synchronous provider-side read lease. While held, lifecycle mutation must
 * remain pending so the caller can finish its synchronous SQLite transaction.
 */
export interface ProviderLifecycleGuard {
  readonly snapshot: ProviderLifecycleSnapshot;
  release(): void;
}

export interface ProtectedCancellationProviderSession {
  readonly providerId: string;
  readonly adapterId: string;
  readonly sessionEpoch: ProviderSessionEpoch;
  health(): Promise<ProviderHealthV1>;
  verify(input: ProviderVerifyInputV1): Promise<VerifiedCancellationPrincipalV1 | ProviderFailureV1>;
  acquireLifecycleGuard(): ProviderLifecycleGuard | undefined;
  snapshot(): ProviderLifecycleSnapshot;
  beginRotation(): Promise<
    Readonly<{
      oldGeneration: number;
      activeGeneration: number;
      activatedAt: string;
      overlapEndsAt: string;
    }>
  >;
  revoke(generation: number | "all"): Promise<void>;
  closeAndZeroize(deadlineMs: 5000): Promise<Readonly<{ closed: true; zeroizationConfirmed: true }>>;
}

export interface ProtectedCancellationProviderAdapter {
  readonly adapterId: string;
  readonly testOnly: boolean;
  open(descriptor: ProviderBootstrapDescriptorV1): Promise<ProtectedCancellationProviderSession>;
}

class OpaqueCancellationProviderCapability {
  toJSON(): never {
    throw new TypeError("CancellationProviderCapability is process-local and cannot be serialized");
  }
}

const capabilityAdapters = new WeakMap<object, ProtectedCancellationProviderAdapter>();

/** Internal deployment seam. This module is intentionally absent from package exports. */
export function createProtectedCancellationProviderCapability(
  adapter: ProtectedCancellationProviderAdapter
): CancellationProviderCapability {
  const capability = Object.freeze(new OpaqueCancellationProviderCapability());
  capabilityAdapters.set(capability, adapter);
  return capability as unknown as CancellationProviderCapability;
}

export function resolveProtectedCancellationProviderAdapter(
  capability: CancellationProviderCapability
): ProtectedCancellationProviderAdapter | undefined {
  return typeof capability === "object" && capability !== null ? capabilityAdapters.get(capability) : undefined;
}
