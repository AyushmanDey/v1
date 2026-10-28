import { connection } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { handleRoute } from "@/lib/server/http";
import { getSettings } from "@/lib/server/settings";

export async function GET(request: Request) {
  // Authenticated per-request data: never prerender.
  await connection();
  return handleRoute(async () => {
    const user = await getCurrentUser(request, getSettings());
    return Response.json({ id: user.id, email: user.email });
  });
}
