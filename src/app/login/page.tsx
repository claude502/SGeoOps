"use client";

import { FormEvent, useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [invalidCredentials, setInvalidCredentials] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setInvalidCredentials(false);

    try {
      const result = await authClient.signIn.email({
        email,
        password,
        callbackURL: "/",
      });

      if (result.error) {
        setInvalidCredentials(true);
      } else {
        window.location.assign("/");
      }
    } catch {
      setInvalidCredentials(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">GEO Ops</div>
        <h1 id="login-title">Sign in</h1>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={submitting}
              required
            />
          </div>

          <div className="login-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              aria-describedby={
                invalidCredentials ? "login-error" : undefined
              }
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              required
            />
          </div>

          {invalidCredentials ? (
            <p className="login-error" id="login-error" role="alert">
              Invalid email or password.
            </p>
          ) : null}

          <button
            className="button button-primary login-submit"
            type="submit"
            disabled={submitting}
          >
            {submitting ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
