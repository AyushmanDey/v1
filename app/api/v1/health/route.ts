/** Report that the API process is accepting requests. */
export function GET() {
  return Response.json({ status: "ok" });
}
