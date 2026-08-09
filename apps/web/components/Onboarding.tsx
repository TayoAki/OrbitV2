"use client";
import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useApp, useAppState } from "@/lib/react";
import { Icon } from "./icons";

const MODELS = ["claude-opus-4.8", "claude-sonnet-4.5", "claude-haiku-4.5"];
const STEPS = ["Workspace", "Repositories", "Agent", "Done"];

export function Onboarding() {
  const state = useAppState();
  const app = useApp();
  const router = useRouter();
  const ship = state.members["agt_ship"];

  const [step, setStep] = useState(0);
  const [orgName, setOrgName] = useState(state.org.name);
  const [userName, setUserName] = useState(state.members[state.currentUserId]?.name ?? "");
  const [repoIds, setRepoIds] = useState<Set<string>>(
    () => new Set(Object.values(state.repos).filter((r) => r.connected).map((r) => r.id)),
  );
  const [model, setModel] = useState(ship?.config?.model ?? MODELS[1]);
  const [autonomy, setAutonomy] = useState<"supervised" | "autonomous">(ship?.config?.autonomy ?? "supervised");

  const repos = Object.values(state.repos);
  const toggleRepo = (id: string) =>
    setRepoIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const canNext = step === 0 ? orgName.trim().length > 1 : step === 1 ? repoIds.size > 0 : true;
  const modelChoices = MODELS.includes(model) ? MODELS : [model, ...MODELS];

  const finish = () => {
    app.completeOnboarding({
      orgName: orgName.trim(),
      userName: userName.trim() || undefined,
      repoIds: [...repoIds],
      agent: { model, autonomy },
    });
    router.replace("/inbox");
  };

  return (
    <div className="ob-wrap">
      <div className="ob-card">
        <div className="ob-head">
          <span className="rail-logo">{orgName.trim().charAt(0) || "A"}</span>
          <div className="ob-steps">
            {STEPS.map((s, i) => (
              <React.Fragment key={s}>
                <span className={`ob-step ${i === step ? "on" : ""} ${i < step ? "done" : ""}`}>
                  <span className="ob-dot">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>
                  <span className="ob-step-label">{s}</span>
                </span>
                {i < STEPS.length - 1 && <span className={`ob-bar ${i < step ? "done" : ""}`} />}
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="ob-body">
          {step === 0 && (
            <>
              <h1 className="ob-title">Name your workspace</h1>
              <p className="ob-sub">This is where your team and agents collaborate.</p>
              <div className="field">
                <label>Workspace name</label>
                <input autoFocus value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Eng" />
              </div>
              <div className="field">
                <label>Your name</label>
                <input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Dana Kim" />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h1 className="ob-title">Connect repositories</h1>
              <p className="ob-sub">Pick the repos your agents can work in. Their open runs will fill your inbox.</p>
              <div className="stack">
                {repos.map((r) => {
                  const on = repoIds.has(r.id);
                  return (
                    <button key={r.id} className={`ob-repo ${on ? "on" : ""}`} onClick={() => toggleRepo(r.id)}>
                      <span className={`ob-check ${on ? "on" : ""}`}>{on && <Icon name="check" size={13} />}</span>
                      <span className="conn-logo"><Icon name="github" size={18} /></span>
                      <span className="ob-repo-main">
                        <span className="ob-repo-slug">{r.slug}</span>
                        <span className="ob-repo-branch">default branch {r.defaultBranch}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h1 className="ob-title">Configure your agent</h1>
              <p className="ob-sub">{ship?.name} is an ACP agent with a shell + editor over MCP. You can change this anytime.</p>
              <div className="ae-grid">
                <div className="field">
                  <label>Model</label>
                  <select value={model} onChange={(e) => setModel(e.target.value)}>
                    {modelChoices.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Autonomy</label>
                  <div className="seg">
                    {(["supervised", "autonomous"] as const).map((a) => (
                      <button key={a} className={autonomy === a ? "on" : ""} onClick={() => setAutonomy(a)}>{a}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="field-note">
                <Icon name="key" size={14} /> The agent&rsquo;s signing key never enters the sandbox. Each run gets a short-lived, repo-scoped token.
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h1 className="ob-title">You&rsquo;re all set</h1>
              <p className="ob-sub">Here&rsquo;s your workspace. You can change any of this later.</p>
              <div className="stack">
                <div className="ob-summary"><span className="muted">Workspace</span><b>{orgName}</b></div>
                <div className="ob-summary"><span className="muted">Repositories</span><b>{repoIds.size} connected</b></div>
                <div className="ob-summary"><span className="muted">Agent</span><b>{ship?.name} · {model} · {autonomy}</b></div>
              </div>
            </>
          )}
        </div>

        <div className="ob-foot">
          {step > 0 ? (
            <button className="btn" onClick={() => setStep((s) => s - 1)}>Back</button>
          ) : (
            <span />
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn btn-brand" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              Continue <Icon name="arrowRight" size={15} />
            </button>
          ) : (
            <button className="btn btn-brand" onClick={finish}>
              Go to inbox <Icon name="arrowRight" size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
