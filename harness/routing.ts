/** Input contract for the model-routing implementation delivered in phase 4. */
export interface RoutingRequest {
  taskClass: string;
  attempt: number;
  lastFailure: string | null;
}

/** Fail-closed route signature. The tested implementation is added in phase 4. */
export type Route = (request: RoutingRequest) => string;
