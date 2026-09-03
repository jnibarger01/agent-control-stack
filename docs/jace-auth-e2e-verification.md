# Jace Auth ↔ ACS OAuth E2E Verification

Date: 2026-08-24
ACS branch: feat/jace-auth-integration
ACS checkpoint: d296648
Jace Auth scope-alignment commit: d7e63b7

## Configuration

Jace Auth issuer:
- http://localhost:8811

ACS OAuth configuration:
- ACS_OAUTH_ISSUER=http://localhost:8811
- ACS_OAUTH_AUDIENCE=http://localhost:8811/resources/agent-control-stack
- ACS_OAUTH_JWKS_URI=http://localhost:8811/jwks

ACS isolated gateway:
- http://127.0.0.1:3010

## Positive proof

A Jace Auth client_credentials token with:
- issuer: http://localhost:8811
- audience: http://localhost:8811/resources/agent-control-stack
- scope: acs:work:read

was accepted by the ACS MCP initialize endpoint with HTTP 200.

## Negative proofs

- Missing bearer token -> HTTP 401 invalid_token.
- acs:work:read token calling approve_work_item -> HTTP 403 insufficient_scope; required acs:work:approve.
- acs:work:read token calling create_work_item -> HTTP 403 insufficient_scope; required acs:work:create.
- Jace Auth request for an unregistered resource -> invalid_target.
- Tampered Jace Auth token signature -> ACS HTTP 401 invalid_token.

## Validation

ACS baseline:
- Vitest: 742 passed, 18 skipped.
- AgentOS: 48 passed.
- Public-site build: PASS.
- Public-site safety verification: PASS.
- Typecheck: PASS.

Jace Auth:
- 29/29 tests passed in sanitized environment.
- Typecheck: PASS.
- diff check: PASS.

## Conclusion

PASS.

Jace Auth successfully acts as the OAuth/OIDC authorization server for ACS while ACS retains resource-server enforcement of issuer, audience, JWKS signature validation, and granular acs:work:* authorization scopes.
