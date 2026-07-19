"use client";

import React, { useCallback, useEffect, useState } from "react";

/* ────────────────────────────────────────────
   BriefModal

   Read-only viewer for the persistent project brief
   (.localforge/brief.md) served by GET /api/projects/:id/brief.
   While open it subscribes to the global orchestrator SSE stream
   (/api/agent/events) and refetches whenever a `brief_updated`
   event arrives for this project, so the viewer stays live while
   agents finish features.
   ──────────────────────────────────────────── */

export type BriefModalProps = {
  open: boolean;
  onClose: () => void;
  projectId: number;
};

type BriefResponse = {
  content: string | null;
  updatedAt: string | null;
};

/**
 * Very light markdown rendering — headings (#/##/###) and `- ` bullets get
 * minimal styling; everything else renders as-is in a mono, pre-wrap block.
 * Deliberately no markdown dependency.
 */
function renderBriefLines(content: string): React.ReactNode {
  return content.split("\n").map((line, i) => {
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      return (
        <div
          key={i}
          style={{
            fontWeight: 600,
            fontSize: level === 1 ? 14 : level === 2 ? 13 : 12.5,
            color: "var(--ink)",
            marginTop: i === 0 ? 0 : 10,
            marginBottom: 2,
          }}
        >
          {headingMatch[2]}
        </div>
      );
    }
    const bulletMatch = line.match(/^(\s*)-\s+(.*)$/);
    if (bulletMatch) {
      return (
        <div key={i} style={{ paddingLeft: 14 + bulletMatch[1].length * 6 }}>
          &bull; {bulletMatch[2]}
        </div>
      );
    }
    if (line.trim() === "") {
      return <div key={i} style={{ height: 8 }} />;
    }
    return <div key={i}>{line}</div>;
  });
}

export const BriefModal: React.FC<BriefModalProps> = ({
  open,
  onClose,
  projectId,
}) => {
  const [content, setContent] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBrief = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/brief`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BriefResponse;
      setContent(data.content);
      setUpdatedAt(data.updatedAt);
      setError(null);
    } catch {
      setError("Failed to load the project brief.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Initial fetch on open.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void fetchBrief();
  }, [open, fetchBrief]);

  // Escape to close (same pattern as the other forge modals).
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Live refresh: while the modal is open, listen on the global orchestrator
  // stream and refetch when the brief for this project changes.
  useEffect(() => {
    if (!open) return;
    const es = new EventSource("/api/agent/events");
    const onBriefUpdated = (raw: MessageEvent) => {
      try {
        const data = JSON.parse(raw.data) as {
          type?: string;
          projectId?: number;
        };
        if (data.type === "brief_updated" && data.projectId === projectId) {
          void fetchBrief();
        }
      } catch {
        /* malformed events ignored */
      }
    };
    es.addEventListener("brief_updated", onBriefUpdated as EventListener);
    return () => {
      es.removeEventListener("brief_updated", onBriefUpdated as EventListener);
      es.close();
    };
  }, [open, projectId, fetchBrief]);

  return (
    <div className={"modal-bg " + (open ? "open" : "")} onClick={onClose}>
      <div
        className="modal-panel"
        style={{ width: "min(640px, 90vw)" }}
        onClick={(e) => e.stopPropagation()}
        data-testid="brief-modal"
      >
        <h2>Project brief</h2>
        <p className="hint">
          {updatedAt
            ? `Last updated ${new Date(updatedAt).toLocaleString()}`
            : "Maintained by the agents as features complete."}
        </p>

        <div
          data-testid="brief-modal-content"
          style={{
            maxHeight: "55vh",
            overflowY: "auto",
            border: "1px solid var(--line-2)",
            borderRadius: 8,
            background: "var(--bg)",
            padding: "12px 14px",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            lineHeight: 1.6,
            color: "var(--ink-2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {loading ? (
            <span style={{ color: "var(--ink-3)" }}>Loading&hellip;</span>
          ) : error ? (
            <span style={{ color: "var(--ink-3)" }}>{error}</span>
          ) : content === null ? (
            <span style={{ color: "var(--ink-3)", fontStyle: "italic" }}>
              No brief yet &mdash; it will appear after the first completed
              feature.
            </span>
          ) : (
            renderBriefLines(content)
          )}
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
