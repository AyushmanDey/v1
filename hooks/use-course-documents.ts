"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CourseDocument = {
  id: string;
  title: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  status: "queued" | "processing" | "ready" | "failed";
  created_at: string;
  updated_at: string;
  retrying: boolean;
  attempts: number | null;
  max_attempts: number | null;
  error: string | null;
  can_delete: boolean;
};

export type DocumentNotice = { id: string; kind: "success" | "error"; title: string; body: string };

const ACTIVE_POLL_MS = 2_500;
const IDLE_POLL_MS = 30_000;

const isPending = (document: Pick<CourseDocument, "status">) => document.status === "queued" || document.status === "processing";

function desktopNotify(title: string, body: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted" || !document.hidden) return;
  try {
    new Notification(title, { body, tag: title });
  } catch {
    // Some browsers only allow notifications from a service worker; the in-app notice still shows.
  }
}

/** Ask for desktop-notification permission. Call from a user gesture, such as an upload click. */
export function requestNotificationPermission() {
  if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
    void Notification.requestPermission().catch(() => undefined);
  }
}

/**
 * Loads a course's documents and polls while any are being indexed. When a document this session saw
 * pending becomes ready or fails, it raises an in-app notice (and a desktop notification when the tab is
 * in the background). Pending documents in other courses keep being watched after the user switches course.
 */
export function useCourseDocuments(courseId: string, accessToken: string | undefined) {
  const [documents, setDocuments] = useState<CourseDocument[]>([]);
  const [loadedCourseId, setLoadedCourseId] = useState("");
  const [error, setError] = useState("");
  const [notices, setNotices] = useState<DocumentNotice[]>([]);
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(new Set());
  const deleted = useRef(new Set<string>());
  const watching = useRef(new Map<string, { courseId: string; title: string }>());
  const currentCourse = useRef(courseId);
  const kick = useRef<() => void>(() => undefined);

  useEffect(() => {
    currentCourse.current = courseId;
  }, [courseId]);

  const dismiss = useCallback((id: string) => setNotices((current) => current.filter((notice) => notice.id !== id)), []);

  const notify = useCallback(
    (notice: Omit<DocumentNotice, "id">) => {
      const id = crypto.randomUUID();
      setNotices((current) => [...current.slice(-3), { ...notice, id }]);
      desktopNotify(notice.title, notice.body);
      if (notice.kind === "success") setTimeout(() => dismiss(id), 8_000);
    },
    [dismiss],
  );

  const fetchCourse = useCallback(
    async (targetCourseId: string): Promise<CourseDocument[] | null> => {
      if (!accessToken) return null;
      const response = await fetch(`/api/v1/courses/${targetCourseId}/documents`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.detail || `Could not load course materials (${response.status}).`);
      }
      // A poll that started before a delete finished must not bring the document back.
      return ((await response.json()) as CourseDocument[]).filter((document) => !deleted.current.has(document.id));
    },
    [accessToken],
  );

  const applyTransitions = useCallback(
    (targetCourseId: string, list: CourseDocument[]) => {
      const seen = new Set(list.map((document) => document.id));
      for (const document of list) {
        if (isPending(document)) {
          watching.current.set(document.id, { courseId: targetCourseId, title: document.title });
          continue;
        }
        if (!watching.current.has(document.id)) continue;
        watching.current.delete(document.id);
        if (document.status === "ready") {
          notify({ kind: "success", title: `“${document.title}” is ready`, body: "You can now ask questions about it." });
        } else {
          notify({ kind: "error", title: `“${document.title}” couldn't be indexed`, body: document.error ?? "Indexing failed." });
        }
      }
      // Documents removed from the course stop being watched.
      for (const [id, entry] of watching.current) {
        if (entry.courseId === targetCourseId && !seen.has(id)) watching.current.delete(id);
      }
    },
    [notify],
  );

  useEffect(() => {
    if (!accessToken || !courseId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      clearTimeout(timer);
      const courses = new Set([courseId, ...[...watching.current.values()].map((entry) => entry.courseId)]);
      for (const targetCourseId of courses) {
        try {
          const list = await fetchCourse(targetCourseId);
          if (cancelled || !list) return;
          applyTransitions(targetCourseId, list);
          if (targetCourseId === currentCourse.current) {
            setDocuments(list);
            setLoadedCourseId(targetCourseId);
            setError("");
          }
        } catch (cause) {
          if (cancelled) return;
          if (targetCourseId === currentCourse.current) {
            setError(cause instanceof Error ? cause.message : "Could not load course materials.");
            setLoadedCourseId(targetCourseId);
          }
        }
      }
      if (!cancelled) timer = setTimeout(tick, watching.current.size > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };

    kick.current = () => void tick();
    void tick();
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      kick.current = () => undefined;
    };
  }, [accessToken, courseId, fetchCourse, applyTransitions]);

  /** Start watching a just-uploaded document and refresh immediately. */
  const track = useCallback((document: Pick<CourseDocument, "id" | "title">, documentCourseId: string) => {
    watching.current.set(document.id, { courseId: documentCourseId, title: document.title });
    kick.current();
  }, []);

  /** Delete a document; throws with the server's message on failure. */
  const remove = useCallback(
    async (document: Pick<CourseDocument, "id" | "title">) => {
      if (!accessToken || !courseId) return;
      const response = await fetch(`/api/v1/courses/${courseId}/documents/${document.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      // 404 means it is already gone, which is the outcome the user wanted.
      if (!response.ok && response.status !== 404) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.detail || `Could not delete the material (${response.status}).`);
      }
      deleted.current.add(document.id);
      watching.current.delete(document.id);
      setDeletedIds(new Set(deleted.current));
      setDocuments((list) => list.filter((item) => item.id !== document.id));
      notify({ kind: "success", title: `“${document.title}” deleted`, body: "It will no longer be used to answer questions." });
      kick.current();
    },
    [accessToken, courseId, notify],
  );

  const current = loadedCourseId === courseId ? documents : [];
  return {
    documents: current,
    loading: Boolean(courseId) && loadedCourseId !== courseId,
    error: loadedCourseId === courseId ? error : "",
    readyCount: current.filter((document) => document.status === "ready").length,
    pendingCount: current.filter(isPending).length,
    notices,
    dismiss,
    track,
    remove,
    deletedIds,
  };
}
