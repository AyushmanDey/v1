"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { requestNotificationPermission, useCourseDocuments } from "@/hooks/use-course-documents";
import { CourseMaterials, DocumentNotices } from "@/components/campus/course-materials";
import { VerifyEmail, describeCodeError, describeSignUpError } from "@/components/campus/verify-email";
import type { Session } from "@supabase/supabase-js";
import { ArrowRight, ArrowUp, ArrowUpRight, BookOpen, Check, ChevronDown, CircleHelp, FileText, LoaderCircle, LogOut, MessageSquareText, Sparkles, Upload } from "lucide-react";

type Citation = { source_id: string; chunk_id: string; document_id: string; title: string; file_name: string; page_start: number | null; page_end: number | null; chunk_index: number; similarity: number; url: string; excerpt: string };
type Answer = { answer: string; insufficient_evidence: boolean; citations: Citation[] };
type Message = { id: string; role: "user" | "assistant"; text: string; result?: Answer };
type Course = { id: string; name: string; code: string; created_at: string };
type CreatedDocument = { id: string; title: string; file_name: string; status: string };
const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export function CampusChat({ confirmationExpired = false }: { confirmationExpired?: boolean }) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [showExpiredConfirmation, setShowExpiredConfirmation] = useState(confirmationExpired);
  // Email address waiting for its sign-up verification code (set after sign-up, never by a normal sign-in).
  const [pendingVerification, setPendingVerification] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const [coursesLoading, setCoursesLoading] = useState(false);
  const [coursesError, setCoursesError] = useState("");
  const [showCourseForm, setShowCourseForm] = useState(false);
  const [newCourseName, setNewCourseName] = useState("");
  const [newCourseCode, setNewCourseCode] = useState("");
  const [courseBusy, setCourseBusy] = useState(false);
  const [courseFormError, setCourseFormError] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadedDocument, setUploadedDocument] = useState<CreatedDocument | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const materials = useCourseDocuments(courseId, session?.access_token);
  const canAsk = materials.readyCount > 0;
  const askHint = materials.loading ? "" : !courseId ? "Create a course to start asking questions." : materials.pendingCount > 0 && !canAsk ? "Your materials are being indexed. You'll be notified when you can ask questions." : !canAsk ? "Add course material to start asking questions." : "";

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetch(`/api/v1/courses`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.detail || `Could not load courses (${response.status}).`);
        }
        return response.json() as Promise<Course[]>;
      })
      .then((nextCourses) => {
        if (cancelled) return;
        setCourses(nextCourses);
        setCourseId((current) => nextCourses.some((course) => course.id === current) ? current : nextCourses[0]?.id || "");
      })
      .catch((cause) => {
        if (!cancelled) setCoursesError(cause instanceof Error ? cause.message : "Could not load courses.");
      })
      .finally(() => { if (!cancelled) setCoursesLoading(false); });
    return () => { cancelled = true; };
  }, [session]);

  // Keep the newest message (or the "drafting an answer" indicator) in view.
  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTo({ top: conversation.scrollHeight, behavior: "smooth" });
  }, [messages.length, busy]);

  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setAuthBusy(true); setAuthError(""); setAuthNotice("");
    try {
      if (authMode === "signin") {
        // Sign-in is password only; it never sends a code. An account that never finished sign-up
        // is taken to the code screen, where the student can request a new code if they need one.
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInError?.code === "email_not_confirmed") { setPassword(""); setPendingVerification(email.trim()); }
        else if (signInError) setAuthError(signInError.message);
      } else {
        // With "Confirm email" on, Supabase sends the sign-up code and returns no session yet.
        const { data, error: signUpError } = await supabase.auth.signUp({ email: email.trim(), password });
        if (signUpError) setAuthError(describeSignUpError(signUpError));
        else if (!data.session && data.user?.identities?.length === 0) {
          // Supabase answers a sign-up for an existing account without sending anything (to avoid revealing
          // which emails are registered), so don't send the student to a code screen that will never get a code.
          setAuthMode("signin");
          setAuthNotice("An account with this email already exists. Sign in with your password.");
        }
        else if (!data.session) { setPassword(""); setPendingVerification(email.trim()); }
      }
    } finally { setAuthBusy(false); }
  }

  async function verifySignupCode(code: string): Promise<string | null> {
    if (!supabase) return "Sign-in is not configured.";
    const { error: verifyError } = await supabase.auth.verifyOtp({ email: pendingVerification, token: code, type: "email" });
    if (verifyError) return describeCodeError(verifyError);
    // The account exists now: next time the form should offer sign-in, not sign-up.
    setPendingVerification(""); setAuthMode("signin");
    return null;
  }

  async function resendSignupCode(): Promise<string | null> {
    if (!supabase) return "Sign-in is not configured.";
    const { error: resendError } = await supabase.auth.resend({ type: "signup", email: pendingVerification });
    return resendError ? describeCodeError(resendError) : null;
  }

  async function resendConfirmation() {
    if (!supabase || !email.trim() || authBusy) return;
    setAuthBusy(true); setAuthError(""); setAuthNotice("");
    try {
      const { error: resendError } = await supabase.auth.resend({ type: "signup", email: email.trim() });
      if (resendError) setAuthError(resendError.message);
      else {
        setShowExpiredConfirmation(false);
        setAuthNotice("If this address has a pending signup, a new confirmation email has been sent. Use the newest link.");
      }
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Could not send a confirmation email.");
    } finally { setAuthBusy(false); }
  }

  async function createCourse(event: FormEvent) {
    event.preventDefault();
    if (!session || courseBusy) return;
    setCourseBusy(true); setCourseFormError(""); setCoursesError("");
    try {
      const response = await fetch(`/api/v1/courses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ name: newCourseName, code: newCourseCode }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.detail || `Could not create course (${response.status}).`);
      const course = body as Course;
      setCourses((current) => [...current.filter((existing) => existing.id !== course.id), course].sort((a, b) => a.name.localeCompare(b.name)));
      setCourseId(course.id); setNewCourseName(""); setNewCourseCode(""); setShowCourseForm(false);
      setMessages([]);
    } catch (cause) { setCourseFormError(cause instanceof Error ? cause.message : "Could not create course."); }
    finally { setCourseBusy(false); }
  }

  async function uploadCourseDocument(event: FormEvent) {
    event.preventDefault();
    if (!session || !courseId || !uploadFile || uploadBusy) return;
    requestNotificationPermission();
    setUploadBusy(true); setUploadError(""); setUploadedDocument(null);
    const form = new FormData();
    form.append("title", uploadTitle.trim() || uploadFile.name);
    form.append("file", uploadFile);
    try {
      const response = await fetch(`/api/v1/courses/${courseId}/documents`, {
        method: "POST", headers: { Authorization: `Bearer ${session.access_token}` }, body: form,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.detail || `Could not upload document (${response.status}).`);
      setUploadedDocument(body as CreatedDocument); setUploadFile(null); setUploadTitle("");
      materials.track(body as CreatedDocument, courseId);
      if (fileInput.current) fileInput.current.value = "";
    } catch (cause) { setUploadError(cause instanceof Error ? cause.message : "Could not upload document."); }
    finally { setUploadBusy(false); }
  }

  async function signOut() {
    await supabase?.auth.signOut();
    setMessages([]);
  }

  async function ask(event?: FormEvent) {
    event?.preventDefault();
    const question = draft.trim();
    if (!question || busy || !session || !canAsk) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(courseId.trim())) {
      setError("Enter a valid course UUID to continue."); return;
    }
    setError(""); setDraft(""); setBusy(true);
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", text: question };
    setMessages((current) => [...current, userMessage]);
    try {
      const response = await fetch(`/api/v1/courses/${courseId.trim()}/assistant/ask`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ question }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(response.status === 401 ? "Your sign-in has expired. Sign in again." : response.status === 403 ? "You do not have access to this course." : data?.detail || `The assistant request failed (${response.status}).`);
      }
      const result = await response.json() as Answer;
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", text: result.answer, result }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the assistant API.");
      setMessages((current) => current.filter((message) => message.id !== userMessage.id));
      setDraft(question);
    } finally { setBusy(false); }
  }

  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(); }
  }

  if (!configured) return <SetupScreen />;
  if (!ready) return <div className="grid min-h-screen place-items-center bg-background"><LoaderCircle className="animate-spin text-muted-foreground" aria-label="Loading" /></div>;
  if (!session && pendingVerification) return <VerifyEmail email={pendingVerification} onVerify={verifySignupCode} onResend={resendSignupCode} onBack={() => { setPendingVerification(""); setAuthMode("signup"); setAuthError(""); setAuthNotice(""); }} />;
  if (!session) return <SignIn email={email} setEmail={setEmail} password={password} setPassword={setPassword} mode={authMode} setMode={setAuthMode} busy={authBusy} error={authError} notice={authNotice} confirmationExpired={showExpiredConfirmation} canResendConfirmation={false} onResend={resendConfirmation} onSubmit={authenticate} />;

  const activeCourse = courses.find((course) => course.id === courseId);
  const userInitial = (session.user.email || "S").slice(0, 1).toUpperCase();

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <DocumentNotices notices={materials.notices} onDismiss={materials.dismiss} />

      <aside className="hidden w-[248px] shrink-0 flex-col border-r border-border px-4 py-7 md:flex">
        <div className="px-3"><BrandLogo className="h-9 w-auto" /></div>
        <nav aria-label="Workspace" className="mt-12">
          <p className="mb-2 px-3 text-xs font-medium text-muted-foreground">Workspace</p>
          <div aria-current="page" className="flex h-10 items-center gap-3 rounded-full border border-border bg-card px-4 text-sm font-medium"><MessageSquareText size={16} aria-hidden="true" /> Course assistant</div>
          <div className="mt-1 flex h-10 items-center gap-3 px-4 text-sm text-muted-foreground"><BookOpen size={16} aria-hidden="true" /> Study guide <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-[11px]">Soon</span></div>
          <div className="flex h-10 items-center gap-3 px-4 text-sm text-muted-foreground"><Sparkles size={16} aria-hidden="true" /> Build with AI <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-[11px]">Soon</span></div>
        </nav>
        <div className="mt-auto px-3">
          <p className="flex items-center gap-2 text-xs font-medium"><span className="size-2 rounded-full bg-lime ring-1 ring-foreground/20" aria-hidden="true" /> Private course workspace</p>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">Answers use only the course materials you’re allowed to access.</p>
          <p className="mt-4 truncate border-t border-border pt-4 text-xs text-muted-foreground" title={session.user.email ?? undefined}>{session.user.email}</p>
        </div>
      </aside>

      <main className="flex h-dvh min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-5 pr-16 md:px-8 md:pr-20">
          <div className="flex min-w-0 items-center gap-4">
            <div className="shrink-0 md:hidden"><BrandLogo className="h-7 w-auto" /></div>
            <div className="hidden min-w-0 sm:block">
              <p className="text-xs text-muted-foreground">Course assistant{activeCourse ? ` · ${activeCourse.code}` : ""}</p>
              <h1 className="headline truncate text-xl leading-tight">{activeCourse ? activeCourse.name : "Your courses"}</h1>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <p className="hidden items-center gap-2 text-xs text-muted-foreground lg:flex"><span className="size-2 rounded-full bg-lime ring-1 ring-foreground/20" aria-hidden="true" /> Connected</p>
            <span className="ml-2 grid size-8 place-items-center rounded-full bg-foreground text-xs font-semibold text-background" aria-hidden="true">{userInitial}</span>
            <button onClick={signOut} title="Sign out" aria-label="Sign out" className="grid size-9 place-items-center rounded-full text-muted-foreground transition hover:bg-secondary hover:text-foreground"><LogOut size={17} aria-hidden="true" /></button>
          </div>
        </header>

        <section className="mx-auto flex min-h-0 w-full max-w-[1040px] flex-1 flex-col px-4 pb-5 md:px-8">
          {/* Course controls scroll on their own so the conversation and question box always keep their space. */}
          <div className="max-h-[34%] shrink-0 overflow-y-auto pb-1 sm:max-h-[45%]">
            <div className="flex flex-wrap items-center gap-2.5 py-4">
              <label className="sr-only" htmlFor="course-id">Course</label>
              <div className="relative min-w-[220px] flex-1">
                <select id="course-id" value={courseId} onChange={(event) => { setCourseId(event.target.value); setMessages([]); setUploadedDocument(null); }} disabled={coursesLoading || courses.length === 0} className="field h-10 appearance-none rounded-full pl-4 pr-10 text-sm">
                  {courses.length === 0 ? <option value="">{coursesLoading ? "Loading courses…" : "Create a course to get started"}</option> : courses.map((course) => <option key={course.id} value={course.id}>{course.code} · {course.name}</option>)}
                </select>
                <ChevronDown size={16} aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
              </div>
              <button onClick={() => { setShowCourseForm((value) => !value); setCourseFormError(""); }} className="btn-secondary h-10 px-4 text-sm">{showCourseForm ? "Cancel" : "New course"}</button>
              <button onClick={() => { setShowUpload((value) => !value); setUploadError(""); }} disabled={!courseId} className="btn-primary h-10 px-5 text-sm"><Upload size={15} aria-hidden="true" /> Add course material</button>
              <button onClick={() => setShowSetup((value) => !value)} title="Course help" aria-label="Course help" className="grid size-10 place-items-center rounded-full text-muted-foreground transition hover:bg-secondary hover:text-foreground"><CircleHelp size={17} aria-hidden="true" /></button>
            </div>
            {coursesError && <p role="alert" className="mb-3 rounded-2xl bg-red-tint px-4 py-3 text-sm text-danger">{coursesError}</p>}
            {showSetup && <div className="mb-3 rounded-2xl border border-border bg-card p-5 text-sm leading-6"><p className="font-semibold">Course access</p><p className="mt-1 text-ink-2">Courses you own or have been added to appear here. Creating a course makes you its instructor.</p></div>}
            {showCourseForm && <form onSubmit={createCourse} className="mb-3 grid gap-4 rounded-2xl border border-border bg-card p-5 sm:grid-cols-[1fr_200px_auto] sm:items-end">
              <label className="text-[13px] font-semibold">Course name<input required maxLength={200} value={newCourseName} onChange={(event) => setNewCourseName(event.target.value)} placeholder="Introduction to Biology" className="field mt-2 h-11 rounded-full px-4 text-sm font-normal"/></label>
              <label className="text-[13px] font-semibold">Course code<input required maxLength={40} value={newCourseCode} onChange={(event) => setNewCourseCode(event.target.value)} placeholder="BIO-101" className="field mt-2 h-11 rounded-full px-4 text-sm font-normal"/></label>
              <button disabled={courseBusy} className="btn-primary h-11 px-6 text-sm">{courseBusy ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : null} Create course</button>
              {courseFormError && <p role="alert" className="text-sm text-danger sm:col-span-3">{courseFormError}</p>}
            </form>}
            {showUpload && <form onSubmit={uploadCourseDocument} className="mb-3 grid gap-4 rounded-2xl border border-border bg-card p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="text-[13px] font-semibold">Document title<input maxLength={200} value={uploadTitle} onChange={(event) => setUploadTitle(event.target.value)} placeholder={uploadFile?.name || "Lecture notes"} className="field mt-2 h-11 rounded-full px-4 text-sm font-normal"/></label>
              <label className="text-[13px] font-semibold">Course file<input ref={fileInput} required type="file" accept=".pdf,.txt,.docx,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => setUploadFile(event.target.files?.[0] || null)} className="field mt-2 block h-11 rounded-full px-1.5 py-1.5 text-sm font-normal file:mr-3 file:h-full file:cursor-pointer file:rounded-full file:border-0 file:bg-secondary file:px-4 file:text-[13px] file:font-semibold file:text-foreground"/></label>
              <button disabled={!uploadFile || uploadBusy} className="btn-primary h-11 px-6 text-sm">{uploadBusy ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : null} Upload</button>
              {uploadError && <p role="alert" className="text-sm text-danger sm:col-span-3">{uploadError}</p>}
              {uploadedDocument && <p className="flex items-start gap-2 text-sm sm:col-span-3"><Check size={16} className="mt-0.5 shrink-0" aria-hidden="true" /><span>“{uploadedDocument.title}” uploaded. Indexing now; you’ll get a notification when it’s ready for questions.</span></p>}
              <p className="text-xs text-muted-foreground sm:col-span-3">PDF, TXT, or DOCX · up to 25 MiB · stored in private course storage</p>
            </form>}
            {courseId && <CourseMaterials documents={materials.documents} loading={materials.loading} error={materials.error} readyCount={materials.readyCount} pendingCount={materials.pendingCount} onDelete={async (document) => { await materials.remove(document); if (uploadedDocument?.id === document.id) setUploadedDocument(null); }} />}
          </div>

          <div ref={conversationRef} data-testid="conversation" className={`min-h-0 flex-1 overflow-y-auto py-8 ${courseId ? "mt-3 border-t border-border" : ""}`}><div className="flex min-h-full flex-col justify-end">
            {messages.length === 0 ? (
              <div className="mx-auto mb-8 w-full max-w-[640px] text-center">
                <p className="eyebrow">Your learning companion</p>
                <h2 className="headline mt-4 text-[32px] leading-[1.08] md:text-[34px]">What are you <em>working on?</em></h2>
                <p className="mx-auto mt-4 max-w-md text-[15px] leading-7 text-ink-2">Ask a question about your course. NEXIS answers from your campus materials and shows where it found each answer.</p>
                <div className="mt-8 grid gap-3 text-left sm:grid-cols-2">
                  {["Summarize the key ideas from this week", "Explain a concept from my lecture notes"].map((suggestion) => <button key={suggestion} disabled={!canAsk} onClick={() => setDraft(suggestion)} className="group rounded-2xl border border-border bg-card p-5 text-left text-sm leading-6 transition hover:border-foreground/40 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-border">{suggestion}<span className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">Ask the course assistant <ArrowRight size={13} aria-hidden="true" className="transition group-hover:translate-x-0.5" /></span></button>)}
                </div>
              </div>
            ) : (
              <div className="mx-auto w-full max-w-[720px] space-y-8">
                {messages.map((message) => message.role === "user" ? (
                  <div key={message.id} className="flex justify-end"><div className="max-w-[85%] rounded-[20px] rounded-br-md bg-foreground px-4 py-3 text-[15px] leading-6 text-background">{message.text}</div></div>
                ) : (
                  <div key={message.id} className="min-w-0">
                    <p className="mb-2.5 flex items-center gap-2 text-xs font-semibold"><span className="h-[2px] w-[14px] rounded-full bg-red" aria-hidden="true" /> NEXIS assistant</p>
                    <p className="whitespace-pre-wrap text-[15px] leading-7">{message.text}</p>
                    {message.result?.citations.some((citation) => materials.deletedIds.has(citation.document_id)) && <div className="mt-4 rounded-2xl border border-border bg-secondary px-4 py-3 text-sm leading-6 text-ink-2">This answer used course material that has since been deleted. Ask again to get an answer from the current materials.</div>}
                    {message.result?.insufficient_evidence && <div className="mt-4 rounded-2xl border border-notice-border bg-notice px-4 py-3 text-sm leading-6 text-notice-ink">The course materials didn’t provide enough evidence for a confident answer. Try a narrower question or check with your instructor.</div>}
                    {Boolean(message.result?.citations.length) && <div className="mt-5">
                      <p className="mb-2.5 flex items-center gap-2 text-xs font-semibold text-muted-foreground"><FileText size={14} aria-hidden="true" /> Sources ({message.result!.citations.length})</p>
                      <div className="grid gap-2.5">
                        {message.result!.citations.map((citation) => materials.deletedIds.has(citation.document_id) ? (
                          <div key={citation.chunk_id} className="rounded-xl border border-dashed border-border px-4 py-3"><div className="flex items-center gap-2"><FileText size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-muted-foreground line-through">{citation.title || citation.file_name}</span><span className="shrink-0 text-xs font-medium text-muted-foreground">Source deleted</span></div></div>
                        ) : (
                          <a key={citation.chunk_id} href={citation.url} target="_blank" rel="noreferrer" className="group block rounded-xl border border-border bg-card px-4 py-3.5 transition hover:border-foreground/40">
                            <div className="flex items-center gap-2"><FileText size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{citation.title || citation.file_name}</span><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{citation.page_start ? `p. ${citation.page_start}${citation.page_end && citation.page_end !== citation.page_start ? `–${citation.page_end}` : ""}` : `Excerpt ${citation.chunk_index + 1}`}</span></div>
                            <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-ink-2">“{citation.excerpt}”</p>
                            <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><span className="tabular-nums">{Math.round(citation.similarity * 100)}% match</span> · <span className="font-medium text-foreground group-hover:underline">View source</span><ArrowUpRight size={12} aria-hidden="true" /></p>
                          </a>
                        ))}
                      </div>
                    </div>}
                  </div>
                ))}
              </div>
            )}
            {busy && <p className="mx-auto mt-6 flex w-full max-w-[720px] items-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> Searching course materials and drafting a cited answer…</p>}
          </div></div>

          <div className="mx-auto w-full max-w-[760px] shrink-0">
            <form onSubmit={ask} className="rounded-[22px] border border-border bg-card p-2 shadow-[0_6px_24px_rgba(17,17,17,0.06)] transition focus-within:border-foreground/40">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={handleKey} rows={2} maxLength={1000} disabled={!canAsk} placeholder={canAsk ? "Ask about a concept, reading, or lecture…" : askHint || "Loading course materials…"} className="w-full resize-none bg-transparent px-3 pt-2 text-[15px] leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed" />
              <div className="flex items-center justify-between gap-3 px-1 pb-1"><span className="truncate text-[11px] text-muted-foreground">Shift + Enter for a new line · answers include sources</span><button disabled={!draft.trim() || busy || !canAsk} aria-label="Send question" className="btn-primary size-10 shrink-0"><ArrowUp size={18} aria-hidden="true" /></button></div>
            </form>
            {error && <p role="alert" className="mt-2 rounded-2xl bg-red-tint px-4 py-2.5 text-sm text-danger">{error}</p>}
            <p className="mt-3 text-center text-[11px] text-muted-foreground">AI can make mistakes. Verify important details with the cited course materials.</p>
          </div>
        </section>
      </main>
    </div>
  );
}

/** The official NEXIS lockup: black on paper, white on black. Never redrawn or recoloured. */
function BrandLogo({ className, onDark = false }: { className?: string; onDark?: boolean }) {
  if (onDark) return <Image src="/nexis-logo-dark.png" alt="NEXIS School of Business" width={628} height={218} priority className={className} />;
  return <>
    <Image src="/nexis-logo-light.png" alt="NEXIS School of Business" width={628} height={218} priority className={`${className ?? ""} dark:hidden`} />
    <Image src="/nexis-logo-dark.png" alt="" width={628} height={218} className={`${className ?? ""} hidden dark:block`} />
  </>;
}

function SignIn({ email, setEmail, password, setPassword, mode, setMode, busy, error, notice, confirmationExpired, canResendConfirmation, onResend, onSubmit }: { email: string; setEmail: (v: string) => void; password: string; setPassword: (v: string) => void; mode: "signin" | "signup"; setMode: (v: "signin" | "signup") => void; busy: boolean; error: string; notice: string; confirmationExpired: boolean; canResendConfirmation: boolean; onResend: () => void; onSubmit: (event: FormEvent) => void }) {
  return (
    <main className="grid min-h-screen bg-background md:grid-cols-2">
      <section className="hidden flex-col justify-between border-r border-transparent bg-[#111111] p-12 text-white md:flex lg:p-16 dark:border-border">
        <div><BrandLogo onDark className="h-10 w-auto" /></div>
        <div className="max-w-[520px]">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-lime">Campus AI</p>
          <p className="headline mt-6 text-[52px] leading-[1.04] text-white lg:text-[60px]">Your courses, answered <em>with sources.</em></p>
          <p className="mt-7 max-w-md text-[17px] font-light leading-7 text-white/75">Ask about the materials your instructors share. Every answer shows the page it came from.</p>
        </div>
        <p className="text-xs text-white/60">NEXIS School of Business · Campus learning workspace</p>
      </section>
      <section className="flex items-center justify-center px-6 py-14">
        <form onSubmit={onSubmit} className="w-full max-w-[400px]">
          <div className="mb-12 md:hidden"><BrandLogo className="h-9 w-auto" /></div>
          <p className="eyebrow">{mode === "signin" ? "Welcome back" : "Campus learning"}</p>
          <h1 className="headline mt-4 text-[38px] leading-[1.08]">{mode === "signin" ? <>Sign in to <em>NEXIS</em></> : <>Create your <em>account</em></>}</h1>
          <p className="mt-3 text-[15px] text-ink-2">Use your campus email to continue.</p>
          {confirmationExpired && <div role="alert" className="mt-6 rounded-2xl border border-notice-border bg-notice p-4 text-sm leading-6 text-notice-ink">That confirmation link has expired. Enter the same email below and request a new link.</div>}
          <label className="mt-9 block text-[13px] font-semibold" htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="field mt-2 h-12 rounded-full px-5 text-[15px]" placeholder="you@university.edu" />
          <label className="mt-5 block text-[13px] font-semibold" htmlFor="password">Password</label>
          <input id="password" type="password" minLength={8} autoComplete={mode === "signin" ? "current-password" : "new-password"} required value={password} onChange={(e) => setPassword(e.target.value)} className="field mt-2 h-12 rounded-full px-5 text-[15px]" placeholder={mode === "signin" ? "Your password" : "At least 8 characters"} />
          {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
          {notice && <p role="status" className="mt-4 rounded-2xl border border-border bg-card p-4 text-sm leading-6">{notice}</p>}
          <button disabled={busy} className="btn-primary mt-7 h-12 w-full text-[15px]">{busy && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}{mode === "signin" ? "Sign in" : "Create account"}{!busy && <ArrowRight size={17} aria-hidden="true" />}</button>
          {(confirmationExpired || canResendConfirmation) && <button type="button" onClick={onResend} disabled={busy || !email.trim()} className="mt-3 w-full rounded-full py-2.5 text-sm font-semibold transition hover:bg-secondary disabled:cursor-not-allowed disabled:text-muted-foreground">{busy ? "Sending confirmation email…" : "Resend confirmation email"}</button>}
          <button type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="mt-4 w-full rounded-full py-2.5 text-center text-sm font-semibold transition hover:bg-secondary">{mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}</button>
          <p className="mt-8 text-center text-xs leading-5 text-muted-foreground">Your course access is checked by the NEXIS server.</p>
        </form>
      </section>
    </main>
  );
}

function SetupScreen() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-5">
      <section className="w-full max-w-xl rounded-2xl border border-border bg-card p-7 md:p-10">
        <div className="flex items-center justify-between gap-4"><BrandLogo className="h-9 w-auto" /><p className="text-xs text-muted-foreground">Local pilot setup</p></div>
        <p className="eyebrow mt-10">Setup</p>
        <h1 className="headline mt-3 text-[30px] leading-tight">Connect your <em>Supabase project</em></h1>
        <p className="mt-3 text-[15px] leading-7 text-ink-2">The workspace is ready. Add the public Supabase project URL and anon key to the frontend environment so campus users can sign in.</p>
        <ol className="mt-6 space-y-3 text-sm leading-6">
          <li className="flex gap-3"><span className="w-5 shrink-0 font-semibold tabular-nums text-red">1.</span><span>Open <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">.env.local</code> in the project root.</span></li>
          <li className="flex gap-3"><span className="w-5 shrink-0 font-semibold tabular-nums text-red">2.</span><span>Set <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>.</span></li>
          <li className="flex gap-3"><span className="w-5 shrink-0 font-semibold tabular-nums text-red">3.</span><span>Restart the Next dev server. Never place a service role key in these variables.</span></li>
        </ol>
        <p className="mt-7 rounded-2xl border border-notice-border bg-notice p-4 text-sm leading-6 text-notice-ink">Use only the public anon key in the browser. The API keeps its privileged credentials server-side.</p>
      </section>
    </main>
  );
}
