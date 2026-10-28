import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { deleteCourseDocument } from "@/lib/server/documents/deletion";
import { handleRoute, requireUuidParam } from "@/lib/server/http";
import { getSettings } from "@/lib/server/settings";

export function DELETE(request: NextRequest, ctx: RouteContext<"/api/v1/courses/[courseId]/documents/[documentId]">) {
  return handleRoute(async () => {
    const settings = getSettings();
    const user = await getCurrentUser(request, settings);
    const params = await ctx.params;
    const courseId = requireUuidParam(params.courseId, "courseId");
    const documentId = requireUuidParam(params.documentId, "documentId");
    return Response.json(await deleteCourseDocument({ settings, user, courseId, documentId }));
  });
}
