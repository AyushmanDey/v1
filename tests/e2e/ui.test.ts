/**
 * Browser test of the campus chat UI against `next dev`, using system Chrome via playwright-core.
 * Covers sign-in, course creation, document upload, and a cited answer from the same-origin API.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { AI_API_KEY, ANON_KEY, EMBEDDING_MODEL, MockServices, SERVICE_ROLE_KEY } from "./mock-services";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.CHROME_PATH ?? (existsSync(CHROME) ? CHROME : undefined);
const mock = new MockServices();
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let appUrl = "";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

before(async () => {
  if (!executablePath) return;
  await mock.start();
  mock.addUser("student@campus.edu", "correct-horse-battery");
  const port = await freePort();
  appUrl = `http://localhost:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(port)], {
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: mock.url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      AI_API_KEY,
      AI_EMBEDDING_ENDPOINT: `${mock.url}/v1/embeddings`,
      AI_EMBEDDING_MODEL: EMBEDDING_MODEL,
      AI_CHAT_ENDPOINT: `${mock.url}/v1/chat/completions`,
      AI_CHAT_MODEL: "mock-chat-1",
      RAG_MIN_SIMILARITY: "0.2",
      RAG_MAX_CHUNKS: "4",
      RAG_RELEVANCE_MARGIN: "1",
      AI_KEEP_ALIVE: "",
      AI_CHAT_REASONING_EFFORT: "",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_DIST_DIR: ".next-ui-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout!.on("data", (chunk) => (output += chunk));
  server.stderr!.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${appUrl}/api/v1/health`)).ok) break;
    } catch {
      // starting
    }
    if (Date.now() > deadline || server.exitCode !== null) throw new Error(`next dev failed to start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  browser = await chromium.launch({ executablePath, headless: true });
});

async function assertComposerVisible(page: import("playwright-core").Page, label: string) {
  const viewport = page.viewportSize()!;
  const pageScroll = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  assert.ok(pageScroll <= 1, `${label}: the page itself does not scroll (overflow ${pageScroll}px)`);
  const box = await page.locator("textarea").boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, `${label}: the question box is fully on screen (${JSON.stringify(box)})`);
}

after(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
  await mock.stop();
});

test("a student signs in, creates a course, uploads material and gets a cited answer", { skip: !executablePath && "Chrome not found (set CHROME_PATH)", timeout: 180_000 }, async () => {
  const page = await browser!.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto(appUrl);

  await page.getByRole("heading", { name: "Sign in to NEXIS" }).waitFor({ timeout: 60_000 });
  await page.getByLabel("Email").fill("student@campus.edu");
  await page.getByLabel("Password").fill("wrong-password-123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Invalid login credentials" }).waitFor();

  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "What are you working on?" }).waitFor({ timeout: 30_000 });
  await page.getByRole("option", { name: "Create a course to get started" }).waitFor({ state: "attached" });

  await page.getByRole("button", { name: "New course" }).click();
  await page.getByLabel("Course name").fill("Cell Biology");
  await page.getByLabel("Course code").fill("BIO-210");
  await page.getByRole("button", { name: "Create course" }).click();
  await page.getByRole("option", { name: "BIO-210 · Cell Biology" }).waitFor({ state: "attached" });
  assert.equal(mock.courses.length, 1);

  // With no materials the question box is disabled and says why.
  const materials = page.getByRole("region", { name: "Course materials" });
  await materials.getByText("No materials yet.").waitFor();
  const questionBox = page.locator("textarea");
  assert.equal(await questionBox.isDisabled(), true);
  assert.equal(await questionBox.getAttribute("placeholder"), "Add course material to start asking questions.");

  const uploadFile = async (title: string, name: string, text: string) => {
    await page.getByLabel("Document title").fill(title);
    await page.getByLabel("Course file").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await page.getByText(`“${title}” uploaded. Indexing now`).waitFor();
  };
  await page.getByRole("button", { name: "Add course material" }).click();
  await uploadFile("Organelles handout", "organelles.txt", "The Golgi apparatus modifies, sorts and packages proteins for secretion.");

  // A notification announces that the material is ready, and the list shows its status.
  const notices = page.getByRole("status").filter({ hasText: "is ready" });
  await notices.getByText("“Organelles handout” is ready").waitFor({ timeout: 20_000 });
  await notices.getByText("You can now ask questions about it.").waitFor();
  await materials.getByText("Ready", { exact: true }).waitFor();
  assert.equal(await questionBox.isDisabled(), false);

  // A second material: a corrupt PDF fails after its retries and raises an error notification.
  await page.getByLabel("Document title").fill("Broken scan");
  await page.getByLabel("Course file").setInputFiles({ name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 not really a pdf") });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await page.getByText("“Broken scan” couldn't be indexed").waitFor({ timeout: 30_000 });
  await materials.getByText("Failed", { exact: true }).waitFor();
  await materials.getByText(/The file couldn't be read\..*upload the file again/).waitFor();
  await materials.getByText("Course materials (2)").waitFor();
  await page.getByRole("button", { name: "Dismiss notification" }).last().click();

  await page.getByPlaceholder("Ask about a concept, reading, or lecture…").fill("What does the Golgi apparatus do with proteins?");
  await page.keyboard.press("Enter");
  await page.getByText("Sources (1)").waitFor({ timeout: 30_000 });
  await page.getByText(/From the course materials: The Golgi apparatus modifies/).waitFor();
  const link = page.locator('a[href*="/storage/v1/object/sign/course-documents/"]');
  assert.equal(await link.count(), 1);
  assert.match((await link.textContent()) ?? "", /Organelles handout/);

  // A long conversation scrolls inside its own panel: the page never scrolls and the question box stays on screen.
  for (let index = 0; index < 4; index++) {
    await questionBox.fill(`What does the Golgi apparatus do? (${index})`);
    await page.keyboard.press("Enter");
    await page.getByText("Sources (1)").nth(index + 1).waitFor({ timeout: 30_000 });
  }
  await assertComposerVisible(page, "desktop");
  const conversation = page.getByTestId("conversation");
  const scroll = await conversation.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }));
  assert.ok(scroll.height > scroll.client, "the conversation overflows its panel");
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="conversation"]')!;
    return element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
  }, undefined, { timeout: 5_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertComposerVisible(page, "phone");
  await page.setViewportSize({ width: 1280, height: 720 });

  // Delete the material: confirm, get a notification, and see the old citation marked as deleted.
  await page.getByRole("button", { name: "Delete Organelles handout" }).click();
  await page.getByRole("button", { name: "Confirm delete Organelles handout" }).click();
  await page.getByRole("status").getByText("“Organelles handout” deleted").waitFor();
  await materials.getByText("Course materials (1)").waitFor();
  assert.equal(await materials.getByText("Organelles handout").count(), 0);
  await page.getByText("Source deleted").first().waitFor();
  await page.getByText("This answer used course material that has since been deleted.").first().waitFor();
  assert.equal(await page.locator('a[href*="/storage/v1/object/sign/course-documents/"]').count(), 0, "no link to the deleted file remains");
  assert.equal(await page.getByText("“The Golgi apparatus modifies").count(), 0, "its excerpt is no longer shown");
  assert.equal(mock.documents.some((document) => document.title === "Organelles handout"), false);
  assert.equal(mock.chunks.some((chunk) => chunk.content.includes("Golgi")), false);
  // Only the failed file is left, so asking is disabled again.
  assert.equal(await questionBox.isDisabled(), true);

  await page.getByTitle("Sign out").click();
  await page.getByRole("heading", { name: "Sign in to NEXIS" }).waitFor();
  assert.deepEqual(consoleErrors, []);
});

test("sign-up requires the emailed code; sign-in never sends one", { skip: !executablePath && "Chrome not found (set CHROME_PATH)", timeout: 120_000 }, async () => {
  const context = await browser!.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const email = "new.student@campus.edu";
  const sent = () => mock.emailsSent.filter((item) => item.email === email).length;

  await page.goto(appUrl);
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("a-strong-password");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("heading", { name: "Check your email" }).waitFor();
  await page.getByText(email).waitFor();
  assert.equal(sent(), 1, "sign-up sends exactly one code");
  assert.equal(mock.users.find((user) => user.email === email)?.confirmed, false);

  // Resend is rate-limited in the UI, a wrong code is refused, and the right code signs the student in.
  assert.equal(await page.getByRole("button", { name: /Send a new code in \d+s/ }).isDisabled(), true);
  await page.getByLabel("Verification code").fill("00000000");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.getByRole("alert").filter({ hasText: "That code is incorrect or has expired" }).waitFor();
  await page.getByLabel("Verification code").fill(mock.signupCodes.get(email)!);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.getByRole("heading", { name: "What are you working on?" }).waitFor({ timeout: 30_000 });
  assert.equal(mock.users.find((user) => user.email === email)?.confirmed, true);

  // Signing out and back in uses only the password: no new email.
  await page.getByTitle("Sign out").click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("a-strong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "What are you working on?" }).waitFor({ timeout: 30_000 });
  assert.equal(sent(), 1, "sign-in did not send a code");
  await page.getByTitle("Sign out").click();

  // An account that never entered its code is sent to the code screen on sign-in, without a new email;
  // the student can ask for a new code there.
  const unfinished = "unfinished@campus.edu";
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByLabel("Email").fill(unfinished);
  await page.getByLabel("Password").fill("another-password");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("heading", { name: "Check your email" }).waitFor();
  await page.getByRole("button", { name: "Use a different email" }).click();
  await page.getByRole("button", { name: "Already have an account? Sign in" }).click();
  await page.getByLabel("Email").fill(unfinished);
  await page.getByLabel("Password").fill("another-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Check your email" }).waitFor();
  assert.equal(mock.emailsSent.filter((item) => item.email === unfinished).length, 1, "sign-in did not send another code");
  assert.deepEqual(errors, []);
  await context.close();
});

test("sign-up explains email failures and existing accounts instead of stranding the student", { skip: !executablePath && "Chrome not found (set CHROME_PATH)", timeout: 120_000 }, async () => {
  const context = await browser!.newContext();
  const page = await context.newPage();
  await page.goto(appUrl);
  const signUp = async (email: string) => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("a-strong-password");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
  };
  await page.getByRole("button", { name: "New here? Create an account" }).click();

  mock.failEmailSends = true;
  try {
    await signUp("smtp.broken@campus.edu");
    await page.getByRole("alert").filter({ hasText: "We couldn't send the verification email, so your account wasn't created." }).waitFor();
    assert.equal(mock.users.some((user) => user.email === "smtp.broken@campus.edu"), false);
  } finally {
    mock.failEmailSends = false;
  }
  // Once email works again, the same form succeeds and shows the code screen.
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("heading", { name: "Check your email" }).waitFor();
  await page.getByRole("button", { name: "Use a different email" }).click();

  // An address that already has a confirmed account gets pointed to sign-in.
  await signUp("student@campus.edu");
  await page.getByRole("status").filter({ hasText: "An account with this email already exists. Sign in with your password." }).waitFor();
  await page.getByRole("heading", { name: "Sign in to NEXIS" }).waitFor();
  assert.equal(mock.emailsSent.some((item) => item.email === "student@campus.edu"), false);
  await context.close();
});
