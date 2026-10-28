"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, FileText, LoaderCircle, RotateCw, Trash2, X } from "lucide-react";
import type { CourseDocument, DocumentNotice } from "@/hooks/use-course-documents";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ document }: { document: CourseDocument }) {
  if (document.status === "ready") {
    return <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700"><CheckCircle2 size={11} /> Ready</span>;
  }
  if (document.status === "failed") {
    return <span className="flex shrink-0 items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700"><AlertTriangle size={11} /> Failed</span>;
  }
  if (document.retrying) {
    const attempt = document.attempts && document.max_attempts ? ` (attempt ${document.attempts + 1} of ${document.max_attempts})` : "";
    return <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800"><RotateCw size={11} /> Retrying{attempt}</span>;
  }
  if (document.status === "processing") {
    return <span className="flex shrink-0 items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700"><LoaderCircle size={11} className="animate-spin" /> Indexing…</span>;
  }
  return <span className="flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600"><Clock size={11} /> Queued</span>;
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
      <span className="text-[11px] text-slate-600">Delete?</span>
      <button type="button" onClick={confirm} disabled={busy} aria-label={`Confirm delete ${document.title}`} className="flex items-center gap-1 rounded-md bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-700 disabled:opacity-60">{busy && <LoaderCircle size={11} className="animate-spin" />} Delete</button>
      <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="rounded-md px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100">Cancel</button>
    </div>;
  }
  return <>
    {failure && <span role="alert" className="max-w-[180px] truncate text-[11px] text-rose-700" title={failure}>{failure}</span>}
    <button type="button" onClick={() => setConfirming(true)} aria-label={`Delete ${document.title}`} title="Delete material" className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={14} /></button>
  </>;
}

export function CourseMaterials({ documents, loading, error, readyCount, pendingCount, onDelete }: { documents: CourseDocument[]; loading: boolean; error: string; readyCount: number; pendingCount: number; onDelete: (document: CourseDocument) => Promise<void> }) {
  const summary = [readyCount ? `${readyCount} ready` : "", pendingCount ? `${pendingCount} indexing` : "", documents.length - readyCount - pendingCount ? `${documents.length - readyCount - pendingCount} failed` : ""].filter(Boolean).join(" · ");
  return (
    <section aria-label="Course materials" className="mt-3 rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
        <FileText size={14} className="text-indigo-500" />
        <h2 className="text-xs font-semibold text-slate-700">Course materials{documents.length ? ` (${documents.length})` : ""}</h2>
        {summary && <span className="ml-auto text-[11px] text-slate-400">{summary}</span>}
      </div>
      {loading ? (
        <p className="flex items-center gap-2 px-4 py-3 text-xs text-slate-400"><LoaderCircle size={13} className="animate-spin" /> Loading materials…</p>
      ) : error ? (
        <p role="alert" className="px-4 py-3 text-xs text-rose-700">{error}</p>
      ) : documents.length === 0 ? (
        <p className="px-4 py-3 text-xs text-slate-500">No materials yet. Add a PDF, DOCX, or TXT file to start asking questions.</p>
      ) : (
        <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto">
          {documents.map((document) => (
            <li key={document.id} className="px-4 py-2.5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-slate-800">{document.title}</p>
                  <p className="truncate text-[11px] text-slate-400">{document.file_name} · {formatSize(document.size_bytes)}</p>
                </div>
                <StatusBadge document={document} />
                {document.can_delete && <DeleteControl document={document} onDelete={onDelete} />}
              </div>
              {document.error && <p className="mt-1 text-[11px] leading-4 text-rose-700">{document.error}{document.status === "failed" ? " You can upload the file again." : " Retrying automatically."}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DocumentNotices({ notices, onDismiss }: { notices: DocumentNotice[]; onDismiss: (id: string) => void }) {
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {notices.map((notice) => (
        <div key={notice.id} className={`pointer-events-auto flex gap-3 rounded-xl border bg-white p-3.5 shadow-lg ${notice.kind === "success" ? "border-emerald-200" : "border-rose-200"}`}>
          {notice.kind === "success" ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" /> : <AlertTriangle size={18} className="mt-0.5 shrink-0 text-rose-600" />}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-slate-800">{notice.title}</p>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">{notice.body}</p>
          </div>
          <button type="button" onClick={() => onDismiss(notice.id)} aria-label="Dismiss notification" className="h-fit rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
