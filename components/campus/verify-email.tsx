"use client";

import { FormEvent, useEffect, useState } from "react";
import Image from "next/image";
import { ArrowLeft, LoaderCircle } from "lucide-react";

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
    <main className="grid min-h-screen place-items-center bg-background px-6 py-14">
      <form onSubmit={submit} className="w-full max-w-[400px]">
        <div className="mb-12"><Image src="/nexis-logo-light.png" alt="NEXIS School of Business" width={628} height={218} priority className="h-9 w-auto dark:hidden" /><Image src="/nexis-logo-dark.png" alt="" width={628} height={218} className="hidden h-9 w-auto dark:block" /></div>
        <p className="eyebrow">Verify your email</p>
        <h1 className="headline mt-4 text-[38px] leading-[1.08]">Check your <em>email</em></h1>
        <p className="mt-3 text-[15px] leading-7 text-ink-2">We sent a verification code to <strong className="font-semibold text-foreground">{email}</strong>. Enter it to finish creating your account.</p>
        <label className="mt-9 block text-[13px] font-semibold" htmlFor="verification-code">Verification code</label>
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
          placeholder="Enter code"
          className="field mt-2 h-14 rounded-full px-5 text-center text-2xl font-medium tabular-nums tracking-[.35em] placeholder:text-base placeholder:font-normal placeholder:tracking-normal"
        />
        {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
        {notice && <p role="status" className="mt-4 rounded-2xl border border-border bg-card p-4 text-sm leading-6">{notice}</p>}
        <button disabled={busy || code.length < 6} className="btn-primary mt-7 h-12 w-full text-[15px]">{busy && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />} Verify and continue</button>
        <button type="button" onClick={resend} disabled={busy || cooldown > 0} className="mt-3 w-full rounded-full py-2.5 text-sm font-semibold tabular-nums transition hover:bg-secondary disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent">{cooldown > 0 ? `Send a new code in ${cooldown}s` : "Send a new code"}</button>
        <button type="button" onClick={onBack} className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-full py-2.5 text-sm text-muted-foreground transition hover:bg-secondary hover:text-foreground"><ArrowLeft size={14} aria-hidden="true" /> Use a different email</button>
        <p className="mt-8 text-center text-xs leading-5 text-muted-foreground">Didn&apos;t get it? Check your spam folder. Codes expire after a while; send a new one if needed.</p>
      </form>
    </main>
  );
}
