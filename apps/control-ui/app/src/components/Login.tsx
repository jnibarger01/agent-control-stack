import { useState, type FormEvent } from "react";
import { endpoints } from "../api/endpoints";
import { describeError, isAcsApiError } from "../api/errors";
import { queryCache } from "../state/query";
import { sessionStore } from "../state/session";
import { useAction } from "./Dialog";

/**
 * Sign-in posts the operator token once to /session/login and immediately
 * discards it: the gateway answers with an HttpOnly cookie, so the token is
 * never stored, logged, or kept in component state after submit.
 */
export function Login() {
  const [token, setToken] = useState("");
  const login = useAction((value: string) => endpoints.login(value));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = token;
    setToken("");
    const outcome = await login.run(value);
    if (outcome?.ok) {
      queryCache.clear();
      sessionStore.markAuthenticated();
    }
  };
  const error = login.error;
  return (
    <main className="login" id="main-content">
      <form className="card card-body" onSubmit={(event) => void submit(event)}>
        <div>
          <h1>ACS Mission Control</h1>
          <p className="muted">
            Sign in with an operator token. It is exchanged for a session cookie and not stored by this page.
          </p>
        </div>
        <label className="field">
          <span>Operator token</span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-describedby={error ? "login-error" : undefined}
            aria-invalid={error !== undefined}
          />
        </label>
        {error !== undefined && (
          <div className="banner" data-tone="danger" role="alert" id="login-error">
            <p>
              {isAcsApiError(error) && error.kind === "unauthorized" ? "Token not accepted." : describeError(error)}
            </p>
          </div>
        )}
        <button className="btn" data-variant="primary" type="submit" disabled={login.pending || token.length === 0}>
          {login.pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
