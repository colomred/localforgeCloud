"use client";

import React, { useState, useCallback } from "react";
import { Robot } from "@/components/forge/robot";
import { StopIcon, PlayIcon } from "@/components/forge/icons";

/* ──────────────────── Types ──────────────────── */

export type AgentSlotData = {
  slotIndex: number;
  running: boolean;
  sessionId?: number;
  featureId?: number;
  featureTitle?: string;
};

export type LogLine = {
  prompt: string; // "$" or ">"
  text: string;
  cls: string; // "cmd", "dim", "grn", "red", "yel", or ""
};

/**
 * Live pipeline state for a running forge-engine session, accumulated from
 * phase/step/plan/budget SSE events by project-view. Absent for pi-engine
 * sessions (which emit no pipeline events) and idle pods.
 */
export type PipelineState = {
  phase?: string;
  stepIndex?: number;
  stepCount?: number;
  stepTitle?: string;
  passedSteps?: number;
  budget?: { usedTokens: number; limitTokens: number; handoff?: boolean };
};

export type AgentPodData = AgentSlotData & {
  logs: LogLine[];
  progress: number;
  mood: string;
  /** Cosmetic alias assigned at session start; falls back to "Agent N". */
  name?: string;
  /** Structured pipeline state (forge engine only). */
  pipeline?: PipelineState;
};

export type AgentPodsProps = {
  projectId: number;
  slots: AgentPodData[];
  maxConcurrentAgents: number;
  onStartAgent: (slotIndex: number) => void;
  onStopAgent: (sessionId: number) => void;
  onExpandAgent: (sessionId: number) => void;
};

/* ──────────────────── Expand icon (inline) ──────────────────── */

const ExpandIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    fill="none"
  >
    <polyline points="15,3 21,3 21,9" />
    <polyline points="9,21 3,21 3,15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);

/* ──────────────────── Pipeline helpers ──────────────────── */

/**
 * Derive the pod's live status line from the pipeline phase. Returns null
 * when there is no pipeline state (pi-engine sessions fall back to mood).
 */
function pipelineStatusLine(p?: PipelineState): string | null {
  if (!p?.phase) return null;
  const stepPart =
    p.stepIndex != null
      ? `Step ${p.stepIndex + 1}${p.stepCount ? `/${p.stepCount}` : ""}`
      : null;
  switch (p.phase) {
    case "scaffold":
      return "Scaffolding…";
    case "plan":
      return "Planning…";
    case "step":
      return stepPart ? `${stepPart} — implementing` : "Implementing…";
    case "verify":
      return stepPart ? `${stepPart} — verifying` : "Verifying…";
    case "fix":
      return stepPart ? `${stepPart} — fixing` : "Fixing…";
    case "smoke":
      return "Smoke test";
    case "summarize":
      return "Updating brief";
    default:
      return null;
  }
}

/** Real progress (passed steps / step count) or null when unknown. */
function pipelineProgress(p?: PipelineState): number | null {
  if (!p?.stepCount || p.stepCount <= 0) return null;
  return Math.round(((p.passedSteps ?? 0) / p.stepCount) * 100);
}

/* ──────────────────── ContextMeter sub-component ──────────────────── */

function contextPct(budget: NonNullable<PipelineState["budget"]>): number {
  if (budget.limitTokens <= 0) return 0;
  return Math.min(
    100,
    Math.max(0, Math.round((budget.usedTokens / budget.limitTokens) * 100)),
  );
}

/**
 * Slim context-budget meter. Neutral below 60%, amber 60-80%, red above 80%.
 * When mounted for a handoff snapshot (parent keys the component on the
 * handoff event) a transient ring flashes via the lf-ctx-flash keyframes.
 */
function ContextMeter({
  budget,
}: {
  budget: NonNullable<PipelineState["budget"]>;
}) {
  const pct = contextPct(budget);
  const fill =
    pct > 80 ? "var(--bad)" : pct >= 60 ? "var(--warn)" : "var(--ink-3)";
  return (
    <div
      data-testid="agent-pod-context-meter"
      data-ctx-pct={pct}
      title={`context: ${budget.usedTokens.toLocaleString()} / ${budget.limitTokens.toLocaleString()} tokens`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginTop: 6,
        borderRadius: 4,
        animation: budget.handoff ? "lf-ctx-flash 1.4s ease-out" : undefined,
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9.5,
          letterSpacing: "0.04em",
          color: pct >= 60 ? fill : "var(--ink-3)",
          flexShrink: 0,
        }}
      >
        ctx {pct}%
      </span>
      <div
        style={{
          flex: 1,
          height: 3,
          background: "var(--bg-2)",
          border: "1px solid var(--line)",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: fill,
            transition: "width .6s ease, background .3s ease",
          }}
        />
      </div>
    </div>
  );
}

/* ──────────────────── PodLog sub-component ──────────────────── */

function PodLog({ logs }: { logs: LogLine[] }) {
  const last = logs.slice(-4);
  return (
    <div className="pod-log">
      {last.map((l, i) => (
        <div key={i} className="log-line">
          <span className="log-prompt">{l.prompt}</span>
          <span className={l.cls}>
            {l.text}
            {i === last.length - 1 && <span className="cursor-blink" />}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ──────────────────── AgentPods component ──────────────────── */

export function AgentPods({
  projectId,
  slots,
  maxConcurrentAgents,
  onStartAgent,
  onStopAgent,
  onExpandAgent,
}: AgentPodsProps) {
  const liveCount = slots.filter((s) => s.running).length;

  // Track which pods have a drag-over state
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, slotIndex: number) => {
      e.preventDefault();
      setDragOverSlot(slotIndex);
    },
    [],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOverSlot(null);
    },
    [],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>, slotIndex: number) => {
      e.preventDefault();
      setDragOverSlot(null);
      onStartAgent(slotIndex);
    },
    [onStartAgent],
  );

  return (
    <section className="pods-section">
      {/* Transient ring flash for the context meter on budget handoff */}
      <style>{`@keyframes lf-ctx-flash { 0% { box-shadow: 0 0 0 2px var(--warn); } 100% { box-shadow: 0 0 0 6px rgba(0,0,0,0); } }`}</style>
      {/* Header */}
      <div className="pods-head">
        <h2 className="pods-title">
          <span className="em">Agents</span> at work{" "}
          <span
            className="hand"
            style={{ fontSize: 16, color: "var(--ink-3)", marginLeft: 4 }}
          >
            &middot; up to {maxConcurrentAgents} in parallel
          </span>
        </h2>
        <div className="pods-meta">{liveCount}/{maxConcurrentAgents} running</div>
      </div>

      {/* N-column grid — matches configured concurrency, falling back to
          the slot count so in-flight agents still render if the user just
          lowered the limit. */}
      <div
        className="pods"
        style={{
          gridTemplateColumns: `repeat(${Math.max(
            1,
            slots.length,
          )}, minmax(0, 1fr))`,
        }}
      >
        {slots.map((slot) => {
          const isDragOver = dragOverSlot === slot.slotIndex;
          const statusLine = pipelineStatusLine(slot.pipeline);
          const realProgress = pipelineProgress(slot.pipeline);
          const progress = realProgress ?? slot.progress;
          const budget = slot.pipeline?.budget;
          const podClass = [
            "pod",
            slot.running ? "running" : "",
            !slot.running ? "idle" : "",
            isDragOver ? "drag-over" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <div
              key={slot.slotIndex}
              className={podClass}
              onDragOver={(e) => handleDragOver(e, slot.slotIndex)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, slot.slotIndex)}
            >
              {slot.running ? (
                /* ─── Running pod ─── */
                <>
                  {/* Head */}
                  <div className="pod-head">
                    <div className="pod-avatar">
                      <Robot
                        seed={slot.slotIndex}
                        size={48}
                        running={true}
                      />
                    </div>
                    <div className="pod-id">
                      <div className="pod-name">
                        {slot.name ?? `Agent ${slot.slotIndex + 1}`}
                      </div>
                      <div className="pod-state live">
                        {statusLine ?? slot.mood}
                      </div>
                    </div>
                    <span className="pod-status live">
                      <span className="bullet" />
                      live
                    </span>
                  </div>

                  {/* Body */}
                  <div className="pod-body">
                    <div className="pod-tag">working on</div>
                    <div className="pod-task">
                      {slot.featureTitle ?? "Unnamed feature"}
                    </div>
                    <div className="pod-meta">
                      {slot.featureId != null && (
                        <span>#{slot.featureId}</span>
                      )}
                      {slot.pipeline?.stepTitle && (
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            minWidth: 0,
                          }}
                          title={slot.pipeline.stepTitle}
                        >
                          {slot.pipeline.stepTitle}
                        </span>
                      )}
                    </div>
                    <div className="pod-progress">
                      <div
                        style={{ width: `${Math.min(progress, 100)}%` }}
                      />
                    </div>
                    {budget && (
                      <ContextMeter
                        // Remount on a handoff snapshot so the ring flash
                        // animation re-runs for every handoff event.
                        key={
                          budget.handoff
                            ? `handoff-${budget.usedTokens}`
                            : "ctx"
                        }
                        budget={budget}
                      />
                    )}
                  </div>

                  {/* Terminal log */}
                  <PodLog logs={slot.logs} />

                  {/* Actions */}
                  <div className="pod-actions">
                    <button
                      className="btn xs danger"
                      onClick={() =>
                        slot.sessionId != null &&
                        onStopAgent(slot.sessionId)
                      }
                      title="Stop agent"
                    >
                      <StopIcon size={12} />
                      stop
                    </button>
                    <button
                      className="btn xs ghost"
                      onClick={() =>
                        slot.sessionId != null &&
                        onExpandAgent(slot.sessionId)
                      }
                      title="Expand logs"
                    >
                      <ExpandIcon size={12} />
                      expand
                    </button>
                    <span className="spacer" />
                    <span className="tag">
                      {realProgress != null &&
                      slot.pipeline?.stepCount != null
                        ? `${slot.pipeline.passedSteps ?? 0}/${slot.pipeline.stepCount} steps`
                        : `${Math.round(progress)}%`}
                    </span>
                  </div>
                </>
              ) : (
                /* ─── Idle pod ─── */
                <>
                  {/* Head */}
                  <div className="pod-head">
                    <div className="pod-avatar">
                      <Robot seed={slot.slotIndex} size={48} />
                    </div>
                    <div className="pod-id">
                      <div className="pod-name">
                        {slot.name ?? `Agent ${slot.slotIndex + 1}`}
                      </div>
                      <div className="pod-state">idle</div>
                    </div>
                    <span className="pod-status idle">idle</span>
                  </div>

                  {/* Body (centered idle state) */}
                  <div className="pod-body">
                    <Robot
                      seed={slot.slotIndex}
                      size={36}
                      style={{ opacity: 0.55 }}
                    />
                    <div className="pod-task">zzz... nothing assigned</div>
                    <div className="drop-hint">drop a card here</div>
                  </div>

                  {/* Actions */}
                  <div className="pod-actions">
                    <button
                      className="btn sm primary"
                      onClick={() => onStartAgent(slot.slotIndex)}
                    >
                      <PlayIcon size={12} />
                      assign next
                    </button>
                    <span className="spacer" />
                    <span className="tag">
                      slot {slot.slotIndex + 1}
                    </span>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
