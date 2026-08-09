"use client";
import React, { useState } from "react";
import { useApp, useAppState } from "@/lib/react";
import { Icon } from "./icons";

// The product's own sign-in screen. The provider buttons SIMULATE an OAuth
// handshake (a real app redirects to the provider) — no credentials are ever
// collected here. On sign-in the auth gate routes to onboarding or the console.
export function Login() {
  const app = useApp();
  const state = useAppState();
  const [email, setEmail] = useState("");
  const org = state.org.name.replace(/ Eng$/, "");

  const signIn = (method: string) => app.login(method);

  return (
    <div className="auth-wrap">
      <aside className="auth-showcase">
        <div className="show-top">
          <span className="rail-logo show-logo">{org.charAt(0)}</span>
          <span className="show-word">{org}</span>
        </div>
        <div className="show-mid">
          <h2 className="show-h">The supervision layer for your AI coding agents.</h2>
          <ul className="show-list">
            <li><Icon name="check" size={16} /> Triage every agent run in one inbox</li>
            <li><Icon name="check" size={16} /> Approve &amp; merge with full context</li>
            <li><Icon name="check" size={16} /> Chat and @mention agents to start work</li>
          </ul>
          <div className="show-card">
            <span className="row-icon warn"><Icon name="ready" size={15} /></span>
            <div className="show-card-main">
              <div className="show-card-title">Stream chat responses instead of one blob</div>
              <div className="show-card-meta">#841 · api · @shipbot</div>
            </div>
            <span className="chip warn">NEEDS APPROVAL</span>
          </div>
        </div>
        <div className="show-foot">Decentralized coordination, identity &amp; audit over centralized execution.</div>
      </aside>

      <main className="auth-panel">
        <div className="auth-card">
          <div className="auth-brand">
            <span className="rail-logo">{org.charAt(0)}</span>
            <span>{org}</span>
          </div>
          <h1 className="auth-title">Sign in</h1>
          <p className="auth-sub">Welcome back. Pick how you&rsquo;d like to continue.</p>

          <button className="btn btn-github auth-btn" onClick={() => signIn("github")}>
            <Icon name="github" size={18} /> Continue with GitHub
          </button>
          <button className="btn btn-nostr auth-btn" onClick={() => signIn("nostr")}>
            <Icon name="key" size={16} /> Continue with a Nostr key
          </button>

          <div className="auth-or"><span>or</span></div>

          <form
            className="auth-email"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) signIn("email");
            }}
          >
            <div className="auth-input">
              <Icon name="mail" size={16} className="muted" />
              <input
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-label="Work email"
              />
            </div>
            <button className="btn auth-btn" type="submit" disabled={!email.trim()}>
              Send magic link
            </button>
          </form>

          <p className="auth-legal">
            By continuing you agree to the Terms and Privacy Policy. This is a product demo —
            no real credentials are collected.
          </p>
        </div>
      </main>
    </div>
  );
}
