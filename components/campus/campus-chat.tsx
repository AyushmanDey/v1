"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { requestNotificationPermission, useCourseDocuments } from "@/hooks/use-course-documents";
import { CourseMaterials, DocumentNotices } from "@/components/campus/course-materials";
import { VerifyEmail, describeCodeError, describeSignUpError } from "@/components/campus/verify-email";
import type { Session } from "@supabase/supabase-js";
import { ArrowUp, BookOpen, Check, CircleHelp, FileText, GraduationCap, LoaderCircle, LockKeyhole, LogOut, MessageSquareText, Sparkles, Wifi } from "lucide-react";

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
  if (!ready) return <div className="grid min-h-screen place-items-center bg-[#f7f8fa]"><LoaderCircle className="animate-spin text-indigo-600" /></div>;
  if (!session && pendingVerification) return <VerifyEmail email={pendingVerification} onVerify={verifySignupCode} onResend={resendSignupCode} onBack={() => { setPendingVerification(""); setAuthMode("signup"); setAuthError(""); setAuthNotice(""); }} />;
  if (!session) return <SignIn email={email} setEmail={setEmail} password={password} setPassword={setPassword} mode={authMode} setMode={setAuthMode} busy={authBusy} error={authError} notice={authNotice} confirmationExpired={showExpiredConfirmation} canResendConfirmation={false} onResend={resendConfirmation} onSubmit={authenticate} />;

  return <div className="flex h-dvh overflow-hidden bg-[#f7f8fa] text-[#172033]">
    <DocumentNotices notices={materials.notices} onDismiss={materials.dismiss} />
    <aside className="hidden w-[260px] shrink-0 flex-col border-r border-slate-200 bg-white px-5 py-6 md:flex">
      <div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-white shadow-sm"><GraduationCap size={22} /></div><div><div className="text-[17px] font-bold tracking-tight">NEXIS</div><div className="text-[11px] font-medium tracking-[.14em] text-slate-400">CAMPUS AI</div></div></div>
      <div className="mt-10"><p className="mb-3 px-2 text-[10px] font-bold uppercase tracking-[.16em] text-slate-400">Workspace</p><div className="flex items-center gap-3 rounded-xl bg-indigo-50 px-3 py-3 text-sm font-semibold text-indigo-700"><MessageSquareText size={17} /> Course assistant</div><div className="mt-2 flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-500"><BookOpen size={17} /> Study guide <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[10px]">Soon</span></div><div className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-500"><Sparkles size={17} /> Build with AI <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[10px]">Soon</span></div></div>
      <div className="mt-auto rounded-2xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-center gap-2 text-xs font-semibold"><span className="size-2 rounded-full bg-emerald-500" /> Private course workspace</div><p className="mt-2 text-[11px] leading-5 text-slate-500">Answers use course materials you’re authorized to access.</p></div>
    </aside>
    <main className="flex h-dvh min-w-0 flex-1 flex-col">
      <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 md:px-9"><div><div className="text-sm font-semibold">Campus assistant</div><div className="mt-0.5 text-xs text-slate-500">Ask questions grounded in your course materials</div></div><div className="flex items-center gap-3"><div className="hidden items-center gap-2 rounded-full border border-slate-200 px-3 py-1.5 text-[11px] font-medium text-slate-500 sm:flex"><Wifi size={13} className="text-emerald-500" /> Connected</div><div className="flex size-8 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{(session.user.email || "S").slice(0,1).toUpperCase()}</div><button onClick={signOut} title="Sign out" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><LogOut size={17} /></button></div></header>
      <section className="mx-auto flex min-h-0 w-full max-w-[1000px] flex-1 flex-col px-4 pb-5 md:px-9">
        {/* Course controls scroll on their own so the conversation and question box always keep their space. */}
        <div className="max-h-[45%] shrink-0 overflow-y-auto">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 py-4">
          <label className="text-xs font-semibold text-slate-500" htmlFor="course-id">Course</label>
          <select id="course-id" value={courseId} onChange={(event) => { setCourseId(event.target.value); setMessages([]); setUploadedDocument(null); }} disabled={coursesLoading || courses.length === 0} className="h-9 min-w-[220px] flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:text-slate-400">
            {courses.length === 0 ? <option value="">{coursesLoading ? "Loading courses…" : "Create a course to get started"}</option> : courses.map((course) => <option key={course.id} value={course.id}>{course.code} · {course.name}</option>)}
          </select>
          <button onClick={() => { setShowCourseForm((value) => !value); setCourseFormError(""); }} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:border-indigo-200 hover:text-indigo-700">{showCourseForm ? "Cancel" : "New course"}</button>
          <button onClick={() => { setShowUpload((value) => !value); setUploadError(""); }} disabled={!courseId} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"><FileText size={14}/> Add course material</button>
          <button onClick={() => setShowSetup((value) => !value)} title="Course help" className="rounded-lg p-2 text-slate-400 hover:bg-white"><CircleHelp size={16}/></button>
        </div>
        {coursesError && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{coursesError}</p>}
        {showSetup && <div className="mt-3 rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-xs leading-5 text-indigo-900"><strong>Course access</strong><p className="mt-1">Courses you own or have been added to appear here. Creating a course makes you its instructor.</p></div>}
        {showCourseForm && <form onSubmit={createCourse} className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-[1fr_180px_auto] sm:items-end">
          <label className="text-xs font-semibold text-slate-600">Course name<input required maxLength={200} value={newCourseName} onChange={(event) => setNewCourseName(event.target.value)} placeholder="Introduction to Biology" className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm font-normal outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"/></label>
          <label className="text-xs font-semibold text-slate-600">Course code<input required maxLength={40} value={newCourseCode} onChange={(event) => setNewCourseCode(event.target.value)} placeholder="BIO-101" className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm font-normal outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"/></label>
          <button disabled={courseBusy} className="flex h-10 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">{courseBusy ? <LoaderCircle size={14} className="animate-spin"/> : null} Create course</button>
          {courseFormError && <p role="alert" className="text-xs text-rose-700 sm:col-span-3">{courseFormError}</p>}
        </form>}
        {showUpload && <form onSubmit={uploadCourseDocument} className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="text-xs font-semibold text-slate-600">Document title<input maxLength={200} value={uploadTitle} onChange={(event) => setUploadTitle(event.target.value)} placeholder={uploadFile?.name || "Lecture notes"} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm font-normal outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"/></label>
          <label className="text-xs font-semibold text-slate-600">Course file<input ref={fileInput} required type="file" accept=".pdf,.txt,.docx,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => setUploadFile(event.target.files?.[0] || null)} className="mt-1.5 block h-10 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-normal file:mr-2 file:rounded-md file:border-0 file:bg-indigo-50 file:px-2 file:py-1 file:text-xs file:font-semibold file:text-indigo-700"/></label>
          <button disabled={!uploadFile || uploadBusy} className="flex h-10 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300">{uploadBusy ? <LoaderCircle size={14} className="animate-spin"/> : null} Upload</button>
          {uploadError && <p role="alert" className="text-xs text-rose-700 sm:col-span-3">{uploadError}</p>}
          {uploadedDocument && <p className="text-xs text-emerald-700 sm:col-span-3"><Check size={14} className="mr-1 inline"/>“{uploadedDocument.title}” uploaded. Indexing now; you’ll get a notification when it’s ready for questions.</p>}
          <p className="text-[11px] text-slate-400 sm:col-span-3">PDF, TXT, or DOCX · up to 25 MiB · stored in private course storage</p>
        </form>}
        {courseId && <CourseMaterials documents={materials.documents} loading={materials.loading} error={materials.error} readyCount={materials.readyCount} pendingCount={materials.pendingCount} onDelete={async (document) => { await materials.remove(document); if (uploadedDocument?.id === document.id) setUploadedDocument(null); }} />}
        </div>
        <div ref={conversationRef} data-testid="conversation" className="min-h-0 flex-1 overflow-y-auto py-7"><div className="flex min-h-full flex-col justify-end">
          {messages.length === 0 ? <div className="mx-auto mb-10 w-full max-w-[650px] text-center"><div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-indigo-100 text-indigo-700"><Sparkles size={25}/></div><p className="text-xs font-bold uppercase tracking-[.18em] text-indigo-600">Your learning companion</p><h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 md:text-[38px]">What are you working on?</h1><p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-500">Ask a question about your course. NEXIS will answer from your campus materials and show where it found the information.</p><div className="mt-7 grid gap-3 text-left sm:grid-cols-2">{["Summarize the key ideas from this week", "Explain a concept from my lecture notes"].map((suggestion) => <button key={suggestion} disabled={!canAsk} onClick={() => setDraft(suggestion)} className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-[0_1px_2px_#0f172a08] transition hover:border-indigo-200 hover:bg-indigo-50/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-slate-200 disabled:hover:bg-white">{suggestion}<span className="mt-2 block text-xs text-slate-400">Ask the course assistant →</span></button>)}</div></div> : <div className="mx-auto w-full max-w-[700px] space-y-7">{messages.map((message) => <div key={message.id} className={message.role === "user" ? "flex justify-end" : "flex gap-3"}>{message.role === "user" ? <div className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-4 py-3 text-sm leading-6 text-white">{message.text}</div> : <div className="min-w-0 flex-1"><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-600"><span className="grid size-7 place-items-center rounded-lg bg-indigo-100 text-indigo-700"><Sparkles size={15}/></span> NEXIS assistant</div><p className="whitespace-pre-wrap text-sm leading-7 text-slate-700">{message.text}</p>{message.result?.citations.some((citation) => materials.deletedIds.has(citation.document_id)) && <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">This answer used course material that has since been deleted. Ask again to get an answer from the current materials.</div>}{message.result?.insufficient_evidence && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">The course materials didn’t provide enough evidence for a confident answer. Try a narrower question or check with your instructor.</div>}{Boolean(message.result?.citations.length) && <div className="mt-5"><div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.13em] text-slate-400"><FileText size={13}/> Sources ({message.result!.citations.length})</div><div className="grid gap-2">{message.result!.citations.map((citation) => materials.deletedIds.has(citation.document_id) ? <div key={citation.chunk_id} className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-3.5"><div className="flex items-center gap-2"><FileText size={15} className="shrink-0 text-slate-300"/><span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-400 line-through">{citation.title || citation.file_name}</span><span className="shrink-0 text-[10px] font-semibold text-slate-500">Source deleted</span></div></div> : <a key={citation.chunk_id} href={citation.url} target="_blank" rel="noreferrer" className="group rounded-xl border border-slate-200 bg-white p-3.5 transition hover:border-indigo-200 hover:shadow-sm"><div className="flex items-center gap-2"><FileText size={15} className="shrink-0 text-indigo-500"/><span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800">{citation.title || citation.file_name}</span><span className="shrink-0 text-[10px] text-slate-400">{citation.page_start ? `p. ${citation.page_start}${citation.page_end && citation.page_end !== citation.page_start ? `–${citation.page_end}` : ""}` : `Excerpt ${citation.chunk_index + 1}`}</span></div><p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">“{citation.excerpt}”</p><div className="mt-2 text-[10px] text-slate-400">{Math.round(citation.similarity * 100)}% match · View source ↗</div></a>)}</div></div>}</div>}</div>)}</div>}
          {busy && <div className="mx-auto mt-6 flex w-full max-w-[700px] items-center gap-2 text-xs text-slate-500"><LoaderCircle size={15} className="animate-spin text-indigo-600"/> Searching course materials and drafting a cited answer…</div>}
        </div></div>
        <div className="mx-auto w-full max-w-[700px] shrink-0"><form onSubmit={ask} className="rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_8px_28px_#0f172a0a]"><textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={handleKey} rows={2} maxLength={1000} disabled={!canAsk} placeholder={canAsk ? "Ask about a concept, reading, or lecture…" : askHint || "Loading course materials…"} className="w-full resize-none bg-transparent px-3 pt-2 text-sm leading-6 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed"/><div className="flex items-center justify-between px-1 pb-1"><span className="text-[10px] text-slate-400">Shift + Enter for a new line · answers include sources</span><button disabled={!draft.trim() || busy || !canAsk} aria-label="Send question" className="grid size-9 place-items-center rounded-xl bg-indigo-600 text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200"><ArrowUp size={18}/></button></div></form>{error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}<p className="mt-3 text-center text-[10px] text-slate-400">AI can make mistakes. Verify important details with the cited course materials.</p></div>
      </section>
    </main>
  </div>;
}

function SignIn({ email, setEmail, password, setPassword, mode, setMode, busy, error, notice, confirmationExpired, canResendConfirmation, onResend, onSubmit }: { email: string; setEmail: (v: string) => void; password: string; setPassword: (v: string) => void; mode: "signin" | "signup"; setMode: (v: "signin" | "signup") => void; busy: boolean; error: string; notice: string; confirmationExpired: boolean; canResendConfirmation: boolean; onResend: () => void; onSubmit: (event: FormEvent) => void }) {
  return <main className="grid min-h-screen bg-[#f7f8fa] md:grid-cols-[1fr_1fr]"><section className="relative hidden flex-col justify-between overflow-hidden bg-[#10152b] p-12 text-white md:flex"><div className="absolute -right-24 top-20 size-96 rounded-full bg-indigo-500/20 blur-3xl"/><div className="relative flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-indigo-500"><GraduationCap size={22}/></div><div><div className="font-bold">NEXIS</div><div className="text-[10px] tracking-[.16em] text-indigo-200">CAMPUS AI</div></div></div><div className="relative max-w-lg"><div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-indigo-100"><Sparkles size={14}/> Learning, grounded in your campus</div><h1 className="text-5xl font-semibold leading-[1.12] tracking-tight">Your courses.<br/>A clearer path<br/><span className="text-indigo-300">forward.</span></h1><p className="mt-6 max-w-md text-sm leading-6 text-slate-300">Get useful answers from the materials your instructors share, with sources you can check.</p></div><p className="relative text-xs text-slate-400">A focused workspace for campus learning.</p></section><section className="flex items-center justify-center px-6 py-12"><form onSubmit={onSubmit} className="w-full max-w-[390px]"><div className="mb-10 flex items-center gap-3 md:hidden"><div className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-white"><GraduationCap/></div><span className="font-bold">NEXIS <span className="text-xs font-medium tracking-widest text-slate-400">CAMPUS AI</span></span></div><p className="text-xs font-bold uppercase tracking-[.16em] text-indigo-600">Campus learning</p><h2 className="mt-2 text-3xl font-semibold tracking-tight">{mode === "signin" ? "Sign in to NEXIS" : "Create your account"}</h2><p className="mt-2 text-sm text-slate-500">Use your campus email to continue.</p>{confirmationExpired && <div role="alert" className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">That confirmation link has expired. Enter the same email below and request a new link.</div>}<label className="mt-8 block text-xs font-semibold text-slate-700" htmlFor="email">Email</label><input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" placeholder="you@university.edu"/><label className="mt-5 block text-xs font-semibold text-slate-700" htmlFor="password">Password</label><input id="password" type="password" minLength={8} autoComplete={mode === "signin" ? "current-password" : "new-password"} required value={password} onChange={(e) => setPassword(e.target.value)} className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" placeholder={mode === "signin" ? "Your password" : "At least 8 characters"}/>{error && <p role="alert" className="mt-3 text-xs text-rose-600">{error}</p>}{notice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-xs leading-5 text-emerald-800">{notice}</p>}<button disabled={busy} className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">{busy ? <LoaderCircle size={16} className="animate-spin"/> : <LockKeyhole size={15}/>} {mode === "signin" ? "Sign in" : "Create account"}</button>{(confirmationExpired || canResendConfirmation) && <button type="button" onClick={onResend} disabled={busy || !email.trim()} className="mt-3 w-full rounded-lg py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:text-slate-400">{busy ? "Sending confirmation email…" : "Resend confirmation email"}</button>}<button type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="mt-2 w-full text-center text-xs font-semibold text-indigo-700 hover:text-indigo-900">{mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}</button><p className="mt-5 text-center text-xs leading-5 text-slate-400">Your course access is checked by the NEXIS server.</p></form></section></main>;
}

function SetupScreen() {
  return <main className="grid min-h-screen place-items-center bg-[#f7f8fa] p-5"><section className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-7 shadow-sm md:p-9"><div className="flex items-center gap-3"><div className="grid size-11 place-items-center rounded-xl bg-indigo-600 text-white"><GraduationCap/></div><div><strong className="text-lg">NEXIS Campus AI</strong><p className="text-xs text-slate-500">Local pilot setup</p></div></div><h1 className="mt-8 text-2xl font-semibold tracking-tight">Connect your Supabase project</h1><p className="mt-2 text-sm leading-6 text-slate-600">The chat UI is ready. Add the public Supabase project URL and anon key to the frontend environment so campus users can sign in.</p><ol className="mt-5 space-y-3 text-sm text-slate-700"><li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-indigo-50 text-xs font-bold text-indigo-700">1</span>Open <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">.env.local</code> in the project root.</li><li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-indigo-50 text-xs font-bold text-indigo-700">2</span>Set <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>.</li><li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-indigo-50 text-xs font-bold text-indigo-700">3</span>Restart the Next dev server. Never place a service role key in these variables.</li></ol><div className="mt-6 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900"><CircleHelp size={15} className="mt-0.5 shrink-0"/>Use only the public anon key in the browser. The API keeps its privileged credentials server-side.</div></section></main>;
}

