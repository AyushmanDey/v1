import type { FetchLike } from "../../lib/server/http";

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  bytes: Uint8Array;
}

export type FakeHandler = (request: RecordedRequest) => Response | Promise<Response>;

/** A FetchLike that records every request and answers from a handler, like httpx.MockTransport. */
export function fakeFetch(handler: FakeHandler): FetchLike & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const recorded: RecordedRequest = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: new TextDecoder().decode(bytes),
      bytes,
    };
    requests.push(recorded);
    return handler(recorded);
  };
  return Object.assign(impl, { requests });
}

export const json = (body: unknown, status = 200) => Response.json(body, { status });
export const empty = (status: number) => new Response(null, { status });
