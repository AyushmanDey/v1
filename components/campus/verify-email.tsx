"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, GraduationCap, LoaderCircle, MailCheck } from "lucide-react";

const RESEND_COOLDOWN_SECONDS = 60;

/** Map Supabase Auth errors from code verification and resends to plain guidance. */
export function describeCodeError(error: { message?: string; code?: string; status?: number } | null | undefined): string {
  if (!error) return "";
  const code = error.code ?? "";
  if (code === "otp_expired" || /expired or is invalid/i.test(error.message ?? "")) {
    return "That code is incorrect or has expired. Check the newest email, or send a new code.";
  }
  if (code === "over_email_send_rate_limit" || error.status === 429) {
    return "Too many emails were sent. Wait a minute, then send a new code.";
  }
  return error.message || "Something went wrong. Try again.";
}

/** Explain sign-up failures; Supabase does not create the account when the code email cannot be sent. */
export function describeSignUpError(error: { message?: string; code?: string; status?: number }): string {
  if (/sending confirmation email/i.test(error.message ?? "")) {
    return "We couldn't send the verification email, so your account wasn't created. Please try again in a few minutes.";
  }
  if (error.code === "over_email_send_rate_limit" || error.status === 429) {
    return "Too many sign-up emails were sent recently. Wait a few minutes, then try again.";
  }
  if (error.code === "email_address_invalid") return "That email address can't receive mail. Check it and try again.";
  return error.message || "Could not create the account. Try again.";
}

export function VerifyEmail({
  email,
  onVerify,
  onResend,
  onBack,
}: {
  email: string;
  onVerify: (code: string) => Promise<string | null>;
  onResend: () => Promise<string | null>;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || code.length < 6) return;
    setBusy(true); setError(""); setNotice("");
    const failure = await onVerify(code);
    // On success the auth listener swaps this screen for the workspace.
    if (failure) { setError(failure); setBusy(false); }
  }

  async function resend() {
    if (busy || cooldown > 0) return;
    setBusy(true); setError(""); setNotice("");
    const failure = await onResend();
    if (failure) setError(failure);
    else { setNotice("A new code is on its way. Only the newest code works."); setCode(""); setCooldown(RESEND_COOLDOWN_SECONDS); }
    setBusy(false);
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f8fa] px-6 py-12">
      <form onSubmit={submit} className="w-full max-w-[390px]">
        <div className="mb-8 flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-white"><GraduationCap /></div><span className="font-bold">NEXIS <span className="text-xs font-medium tracking-widest text-slate-400">CAMPUS AI</span></span></div>
        <div className="mb-5 grid size-12 place-items-center rounded-2xl bg-indigo-50 text-indigo-600"><MailCheck size={24} /></div>
        <h2 className="text-3xl font-semibold tracking-tight">Check your email</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">We sent a verification code to <strong className="font-semibold text-slate-700">{email}</strong>. Enter it to finish creating your account.</p>
        <label className="mt-8 block text-xs font-semibold text-slate-700" htmlFor="verification-code">Verification code</label>
        <input
          id="verification-code"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 10))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
          minLength={6}
          maxLength={10}
          pattern="[0-9]{6,10}"
          placeholder="12345678"
          className="mt-2 h-12 w-full rounded-xl border border-slate-200 bg-white px-3 text-center font-mono text-xl tracking-[.4em] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        />
        {error && <p role="alert" className="mt-3 text-xs text-rose-600">{error}</p>}
        {notice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-xs leading-5 text-emerald-800">{notice}</p>}
        <button disabled={busy || code.length < 6} className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">{busy && <LoaderCircle size={16} className="animate-spin" />} Verify and continue</button>
        <button type="button" onClick={resend} disabled={busy || cooldown > 0} className="mt-3 w-full rounded-lg py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:text-slate-400">{cooldown > 0 ? `Send a new code in ${cooldown}s` : "Send a new code"}</button>
        <button type="button" onClick={onBack} className="mt-2 flex w-full items-center justify-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700"><ArrowLeft size={13} /> Use a different email</button>
        <p className="mt-5 text-center text-xs leading-5 text-slate-400">Didn&apos;t get it? Check your spam folder. Codes expire after a while; send a new one if needed.</p>
      </form>
    </main>
  );
}
