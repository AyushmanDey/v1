"use client";

import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, Clock, FileText, LoaderCircle, RotateCw, Trash2, X } from "lucide-react";
import type { CourseDocument, DocumentNotice } from "@/hooks/use-course-documents";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const pill = "flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold";

function StatusBadge({ document }: { document: CourseDocument }) {
  if (document.status === "ready") {
    return <span className={`${pill} bg-secondary text-foreground`}><span className="size-2 rounded-full bg-lime ring-1 ring-foreground/25" aria-hidden="true" /> Ready</span>;
  }
  if (document.status === "failed") {
    return <span className={`${pill} bg-red-tint text-danger`}><AlertTriangle size={12} aria-hidden="true" /> Failed</span>;
  }
  if (document.retrying) {
    const attempt = document.attempts && document.max_attempts ? ` (attempt ${document.attempts + 1} of ${document.max_attempts})` : "";
    return <span className={`${pill} border border-notice-border bg-notice text-notice-ink`}><RotateCw size={12} aria-hidden="true" /> Retrying{attempt}</span>;
  }
  if (document.status === "processing") {
    return <span className={`${pill} bg-secondary text-foreground`}><LoaderCircle size={12} className="animate-spin" aria-hidden="true" /> Indexing…</span>;
  }
  return <span className={`${pill} bg-secondary text-muted-foreground`}><Clock size={12} aria-hidden="true" /> Queued</span>;
}

function DeleteControl({ document, onDelete }: { document: CourseDocument; onDelete: (document: CourseDocument) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  async function confirm() {
    setBusy(true); setFailure("");
    try {
      await onDelete(document);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Could not delete the material.");
      setBusy(false); setConfirming(false);
    }
  }
  if (confirming) {
    return <div className="flex shrink-0 items-center gap-1.5">
      <span className="text-xs text-ink-2">Delete?</span>
      <button type="button" onClick={confirm} disabled={busy} aria-label={`Confirm delete ${document.title}`} className="btn-primary h-7 gap-1.5 px-3 text-xs">{busy && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />} Delete</button>
      <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="h-7 rounded-full px-3 text-xs font-semibold text-muted-foreground transition hover:bg-secondary hover:text-foreground">Cancel</button>
    </div>;
  }
  return <>
    {failure && <span role="alert" className="max-w-[180px] truncate text-xs text-danger" title={failure}>{failure}</span>}
    <button type="button" onClick={() => setConfirming(true)} aria-label={`Delete ${document.title}`} title="Delete material" className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-red-tint hover:text-danger"><Trash2 size={15} aria-hidden="true" /></button>
  </>;
}

export function CourseMaterials({ documents, loading, error, readyCount, pendingCount, onDelete }: { documents: CourseDocument[]; loading: boolean; error: string; readyCount: number; pendingCount: number; onDelete: (document: CourseDocument) => Promise<void> }) {
  const [collapsed, setCollapsed] = useState(false);
  const summary = [readyCount ? `${readyCount} ready` : "", pendingCount ? `${pendingCount} indexing` : "", documents.length - readyCount - pendingCount ? `${documents.length - readyCount - pendingCount} failed` : ""].filter(Boolean).join(" · ");
  return (
    <section aria-label="Course materials" className="rounded-2xl border border-border bg-card">
      <div className={`flex items-center gap-2.5 px-5 py-3 ${collapsed ? "" : "border-b border-border"}`}>
        <FileText size={16} className="text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Course materials{documents.length ? ` (${documents.length})` : ""}</h2>
        {summary && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{summary}</span>}
        <button type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed} aria-controls="course-materials-list" className={`${summary ? "" : "ml-auto "}flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground`}>{collapsed ? "Show" : "Hide"}<ChevronDown size={14} aria-hidden="true" className={`transition ${collapsed ? "" : "rotate-180"}`} /></button>
      </div>
      {collapsed ? null : <div id="course-materials-list">{loading ? (
        <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> Loading materials…</p>
      ) : error ? (
        <p role="alert" className="px-5 py-4 text-sm text-danger">{error}</p>
      ) : documents.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-2">No materials yet. Add a PDF, DOCX, or TXT file to start asking questions.</p>
      ) : (
        <ul className="max-h-52 divide-y divide-border overflow-y-auto">
          {documents.map((document) => (
            <li key={document.id} className="px-5 py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{document.title}</p>
                  <p className="truncate text-xs tabular-nums text-muted-foreground">{document.file_name} · {formatSize(document.size_bytes)}</p>
                </div>
                <StatusBadge document={document} />
                {document.can_delete && <DeleteControl document={document} onDelete={onDelete} />}
              </div>
              {document.error && <p className="mt-1.5 text-xs leading-5 text-danger">{document.error}{document.status === "failed" ? " You can upload the file again." : " Retrying automatically."}</p>}
            </li>
          ))}
        </ul>
      )}</div>}
    </section>
  );
}

/** Floating notices sit below the header on the right, clear of the question box. */
export function DocumentNotices({ notices, onDismiss }: { notices: DocumentNotice[]; onDismiss: (id: string) => void }) {
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 top-20 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2 md:right-6">
      {notices.map((notice) => (
        <div key={notice.id} className="pointer-events-auto flex gap-3 rounded-2xl border border-border bg-popover p-4 shadow-[0_10px_30px_rgba(17,17,17,0.12)]">
          {notice.kind === "success"
            ? <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-lime text-[#111111]"><Check size={14} strokeWidth={2.5} aria-hidden="true" /></span>
            : <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-red-tint text-danger"><AlertTriangle size={13} aria-hidden="true" /></span>}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{notice.title}</p>
            <p className="mt-0.5 text-[13px] leading-5 text-ink-2">{notice.body}</p>
          </div>
          <button type="button" onClick={() => onDismiss(notice.id)} aria-label="Dismiss notification" className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-secondary hover:text-foreground"><X size={14} aria-hidden="true" /></button>
        </div>
      ))}
    </div>
  );
}
