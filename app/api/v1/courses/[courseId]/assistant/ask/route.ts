import type { NextRequest } from "next/server";
import { answerCourseQuestion, parseAskRequest } from "@/lib/server/assistant/rag";
import { getCurrentUser } from "@/lib/server/auth";
import { handleRoute, parseJsonBody, requireUuidParam } from "@/lib/server/http";
import { getSettings } from "@/lib/server/settings";

export const maxDuration = 120;

export function POST(request: NextRequest, ctx: RouteContext<"/api/v1/courses/[courseId]/assistant/ask">) {
  return handleRoute(async () => {
    const settings = getSettings();
    const user = await getCurrentUser(request, settings);
    const courseId = requireUuidParam((await ctx.params).courseId, "courseId");
    const question = parseAskRequest(await parseJsonBody(request));
    return Response.json(await answerCourseQuestion({ settings, user, courseId, question }));
  });
}
