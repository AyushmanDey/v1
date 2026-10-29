/** Course discovery and creation for the campus pilot. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthenticatedUser } from "./auth";
import { HttpError, UpstreamConnectionError, isUuid, readJson, trimTrailingSlash, upstreamFetch, type FetchLike } from "./http";
import type { Settings } from "./settings";

export interface CourseSummary {
  id: string;
  name: string;
  code: string;
  created_at: string;
}

const requiredText = (max: number) =>
  z.string().trim().min(1, "Value cannot be blank").max(max);

export const courseCreateSchema = z.object({
  name: requiredText(200),
  code: requiredText(40),
});
export type CourseCreate = z.infer<typeof courseCreateSchema>;

const courseSummarySchema = z.object({
  id: z.string().refine(isUuid),
  name: z.string(),
  code: z.string(),
  created_at: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
});

export function parseCourseCreate(body: unknown): CourseCreate {
  const parsed = courseCreateSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(422, `${issue.path.join(".") || "body"}: ${issue.message}`);
  }
  return parsed.data;
}

function requireSupabase(settings: Settings): [string, string] {
  if (!settings.supabaseUrl || !settings.supabaseAnonKey) {
    throw new HttpError(503, "Course service is not configured");
  }
  return [trimTrailingSlash(settings.supabaseUrl), settings.supabaseAnonKey];
}

function userHeaders(user: AuthenticatedUser, anonKey: string): Record<string, string> {
  if (!user.accessToken) throw new HttpError(401, "Authentication required");
  return { apikey: anonKey, Authorization: `Bearer ${user.accessToken}` };
}

async function raiseForSupabase(response: Response, userId: string): Promise<void> {
  if (response.status === 401 || response.status === 403) {
    const payload = (await readJson(response).catch(() => null)) as { code?: string; message?: string } | null;
    console.warn(
      `supabase_course_request_rejected status=${response.status} code=${payload?.code ?? "unknown"} user_id=${userId} message=${payload?.message ?? "unknown"}`,
    );
    if (response.status === 401) {
      throw new HttpError(401, "Your sign-in to Supabase is invalid or expired. Sign in again.");
    }
    throw new HttpError(403, "Supabase denied this course request. Check the course access policy.");
  }
  if (!response.ok) throw new HttpError(502, "Course data request failed");
}

async function courseRequest<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof UpstreamConnectionError) throw new HttpError(503, "Course service is unavailable");
    throw new HttpError(502, "Course service returned invalid data");
  }
}

export async function listUserCourses(opts: {
  settings: Settings;
  user: AuthenticatedUser;
  fetch?: FetchLike;
}): Promise<CourseSummary[]> {
  const [baseUrl, anonKey] = requireSupabase(opts.settings);
  const headers = userHeaders(opts.user, anonKey);
  return courseRequest(async () => {
    const params = new URLSearchParams({ select: "id,name,code,created_at", order: "name.asc" });
    const response = await upstreamFetch(opts.fetch ?? fetch, `${baseUrl}/rest/v1/courses?${params}`, {
      headers,
      timeoutMs: 15_000,
    });
    await raiseForSupabase(response, opts.user.id);
    const rows = await readJson(response);
    if (!Array.isArray(rows)) throw new Error("Course query did not return a list");
    return rows.map((row) => courseSummarySchema.parse(row));
  });
}

export async function createUserCourse(opts: {
  settings: Settings;
  user: AuthenticatedUser;
  course: CourseCreate;
  fetch?: FetchLike;
}): Promise<CourseSummary> {
  const [baseUrl, anonKey] = requireSupabase(opts.settings);
  const headers = userHeaders(opts.user, anonKey);
  const fetchImpl = opts.fetch ?? fetch;
  const courseId = randomUUID();
  const payload = { id: courseId, owner_id: opts.user.id, name: opts.course.name, code: opts.course.code };
  return courseRequest(async () => {
    // Insert without RETURNING: Postgres would check the new row against the SELECT policy, whose
    // course-access function cannot see the row yet and rejects the insert. Read it back instead.
    const inserted = await upstreamFetch(fetchImpl, `${baseUrl}/rest/v1/courses`, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
      timeoutMs: 15_000,
    });
    await raiseForSupabase(inserted, opts.user.id);
    const params = new URLSearchParams({ id: `eq.${courseId}`, select: "id,name,code,created_at" });
    const response = await upstreamFetch(fetchImpl, `${baseUrl}/rest/v1/courses?${params}`, { headers, timeoutMs: 15_000 });
    await raiseForSupabase(response, opts.user.id);
    const rows = await readJson(response);
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Course creation did not return one course");
    return courseSummarySchema.parse(rows[0]);
  });
}
