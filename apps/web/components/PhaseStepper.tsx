"use client";
import React from "react";
import type { RunState, RunPhase } from "@/lib/types";
import { selectRunPhase, selectLoops } from "@/lib/selectors";

const SPINE: { key: RunPhase; label: string }[] = [
  { key: "FEATURE", label: "Feature" },
  { key: "PLANNING", label: "Planning" },
  { key: "BUILD", label: "Build" },
  { key: "TESTING", label: "Testing" },
  { key: "PR", label: "PR" },
  { key: "REVIEW", label: "Review" },
  { key: "HUMAN", label: "Human" },
  { key: "MERGED", label: "Merged" },
];

// The diagram's spine, with the two self-correction loops surfaced as counters.
export function PhaseStepper({ run }: { run: RunState }) {
  const phase = selectRunPhase(run);
  const loops = selectLoops(run);
  const blocked = phase === "BLOCKED";
  const idx = SPINE.findIndex((p) => p.key === phase);

  return (
    <div className="phasebar">
      <div className="phase-track">
        {SPINE.map((p, i) => {
          const done = !blocked && i < idx;
          const cur = !blocked && i === idx;
          const sub =
            p.key === "TESTING" && loops.testing.attempts > 0
              ? `${loops.testing.attempts} attempt${loops.testing.attempts === 1 ? "" : "s"}`
              : p.key === "REVIEW" && loops.review.rounds > 0
                ? `${loops.review.rounds}/${loops.review.maxRounds}${loops.review.lastScore != null ? ` · ${loops.review.lastScore}/5` : ""}`
                : null;
          return (
            <React.Fragment key={p.key}>
              <div className={`phase-node ${done ? "done" : ""} ${cur ? "cur" : ""}`}>
                <span className="phase-dot" />
                <span className="phase-lbl">{p.label}</span>
                {sub && <span className="phase-sub">{sub}</span>}
              </div>
              {i < SPINE.length - 1 && <span className={`phase-conn ${done ? "done" : ""}`} />}
            </React.Fragment>
          );
        })}
      </div>
      {blocked && <div className="phase-blocked">Stopped — needs a human</div>}
    </div>
  );
}
