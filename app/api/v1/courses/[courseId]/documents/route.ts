import { after, connection, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { listCourseDocuments } from "@/lib/server/documents/listing";
import { MAX_DOCUMENT_BYTES } from "@/lib/server/documents/validation";
import { createCourseDocument } from "@/lib/server/documents/uploads";
import { HttpError, handleRoute, requireUuidParam } from "@/lib/server/http";
import { scheduleInlineIngestion } from "@/lib/server/inline-ingestion";
import { getSettings } from "@/lib/server/settings";

// Multipart overhead allowance on top of the 25 MiB file limit.
const MAX_REQUEST_BYTES = MAX_DOCUMENT_BYTES + 1024 * 1024;

export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/courses/[courseId]/documents">) {
  // Authenticated per-request data: never prerender.
  await connection();
  return handleRoute(async () => {
    const settings = getSettings();
    const user = await getCurrentUser(request, settings);
    const courseId = requireUuidParam((await ctx.params).courseId, "courseId");
    const documents = await listCourseDocuments({ settings, user, courseId });
    // Clients poll this while documents are pending. Kicking the inline indexer here picks up retries whose
    // backoff has elapsed and jobs left behind by a server restart, without a separate worker process.
    if (documents.some((document) => document.status === "queued" || document.status === "processing")) {
      after(() => scheduleInlineIngestion(settings) ?? undefined);
    }
    return Response.json(documents);
  });
}

export function POST(request: NextRequest, ctx: RouteContext<"/api/v1/courses/[courseId]/documents">) {
  return handleRoute(async () => {
    const settings = getSettings();
    const user = await getCurrentUser(request, settings);
    const courseId = requireUuidParam((await ctx.params).courseId, "courseId");

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_REQUEST_BYTES) throw new HttpError(413, "File exceeds the 25 MiB limit");

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new HttpError(422, "Request must be multipart/form-data with title and file fields");
    }
    const title = form.get("title");
    const file = form.get("file");
    if (typeof title !== "string") throw new HttpError(422, "title: Field required");
    if (!(file instanceof File)) throw new HttpError(422, "file: Field required");
    if (file.size > MAX_DOCUMENT_BYTES) throw new HttpError(413, "File exceeds the 25 MiB limit");

    const document = await createCourseDocument({
      settings,
      user,
      courseId,
      title,
      filename: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
    });
    after(() => scheduleInlineIngestion(settings) ?? undefined);
    return Response.json(document, { status: 201 });
  });
}
