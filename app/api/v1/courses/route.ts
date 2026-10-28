import { connection } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { createUserCourse, listUserCourses, parseCourseCreate } from "@/lib/server/courses";
import { handleRoute, parseJsonBody } from "@/lib/server/http";
import { getSettings } from "@/lib/server/settings";

export async function GET(request: Request) {
  // Authenticated per-request data: never prerender.
  await connection();
  return handleRoute(async () => {
    const settings = getSettings();
    const user = await getCurrentUser(request, settings);
    return Response.json(await listUserCourses({ settings, user }));
  });
}

export function POST(request: Request) {
  return handleRoute(async () => {
    const settings = getSettings();
    const user = await getCurrentUser(request, settings);
    const course = parseCourseCreate(await parseJsonBody(request));
    return Response.json(await createUserCourse({ settings, user, course }), { status: 201 });
  });
}
