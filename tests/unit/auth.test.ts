import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, test } from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { getCurrentUser, verifyAccessToken } from "../../lib/server/auth";
import { HttpError } from "../../lib/server/http";
import { makeSettings } from "../../lib/server/settings";
import { fakeFetch, json } from "../helpers/fake-fetch";

const SUPABASE_URL = "https://campus.example.supabase.co";
const USER_ID = randomUUID();

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let keys: JWTVerifyGetKey;
let jwks: { keys: object[] };

before(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("ES256")).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "campus-key", alg: "ES256", use: "sig" }] };
  keys = createLocalJWKSet(jwks as never);
});

async function makeToken(overrides: Record<string, unknown> = {}, options: { key?: CryptoKey; expiresIn?: string } = {}) {
  const claims = { role: "authenticated", email: "student@example.edu", ...overrides };
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "campus-key" })
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m");
  if (!("sub" in overrides)) jwt = jwt.setSubject(USER_ID);
  else if (overrides.sub !== undefined) jwt = jwt.setSubject(String(overrides.sub));
  if (!("iss" in overrides)) jwt = jwt.setIssuer(`${SUPABASE_URL}/auth/v1`);
  if (!("aud" in overrides)) jwt = jwt.setAudience("authenticated");
  return jwt.sign(options.key ?? privateKey);
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${error}`);
    assert.equal(error.status, status);
    return error;
  }
  assert.fail(`expected HTTP ${status}`);
}

describe("verifyAccessToken", () => {
  test("builds identity from a valid Supabase token", async () => {
    const user = await verifyAccessToken(await makeToken(), SUPABASE_URL, { keys });
    assert.equal(user.id, USER_ID);
    assert.equal(user.email, "student@example.edu");
  });

  test("accepts a trailing slash on the project URL", async () => {
    const user = await verifyAccessToken(await makeToken(), `${SUPABASE_URL}/`, { keys });
    assert.equal(user.id, USER_ID);
  });

  const invalidClaims: [string, Record<string, unknown>][] = [
    ["wrong issuer", { iss: "https://other.example/auth/v1" }],
    ["wrong audience", { aud: "anon" }],
    ["anon role", { role: "anon" }],
    ["non-UUID subject", { sub: "not-a-uuid" }],
    ["missing subject", { sub: undefined }],
  ];
  for (const [name, claims] of invalidClaims) {
    test(`rejects ${name} with 401`, async () => {
      const error = await expectStatus(verifyAccessToken(await makeToken(claims), SUPABASE_URL, { keys }), 401);
      assert.equal(error.detail, "Invalid or expired access token");
      assert.equal(error.headers["WWW-Authenticate"], "Bearer");
    });
  }

  test("rejects an expired token", async () => {
    const token = await makeToken({}, { expiresIn: "-1m" });
    await expectStatus(verifyAccessToken(token, SUPABASE_URL, { keys }), 401);
  });

  test("rejects a token signed by another key", async () => {
    await expectStatus(verifyAccessToken(await makeToken({}, { key: otherKey }), SUPABASE_URL, { keys }), 401);
  });

  test("rejects symmetric HS256 tokens", async () => {
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER_ID)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience("authenticated")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("shared-secret-shared-secret-1234"));
    await expectStatus(verifyAccessToken(token, SUPABASE_URL, { keys }), 401);
  });

  test("rejects malformed JWTs without a server error", async () => {
    await expectStatus(verifyAccessToken("malformed-token", SUPABASE_URL, { keys }), 401);
  });

  test("fetches keys from the project's JWKS endpoint", async () => {
    const fetchImpl = fakeFetch(() => json(jwks));
    const user = await verifyAccessToken(await makeToken(), SUPABASE_URL, { fetch: fetchImpl });
    assert.equal(user.id, USER_ID);
    assert.equal(fetchImpl.requests[0].url.toString(), `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
  });

  test("reports an unreachable JWKS endpoint as 503", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await expectStatus(verifyAccessToken(await makeToken(), SUPABASE_URL, { fetch: fetchImpl }), 503);
    assert.equal(error.detail, "Authentication keys are temporarily unavailable");
  });

  test("reports a failing JWKS endpoint as 503", async () => {
    const fetchImpl = fakeFetch(() => new Response("down", { status: 500 }));
    await expectStatus(verifyAccessToken(await makeToken(), SUPABASE_URL, { fetch: fetchImpl }), 503);
  });
});

describe("getCurrentUser", () => {
  const settings = makeSettings({ supabaseUrl: SUPABASE_URL });
  const request = (authorization?: string) =>
    new Request("http://localhost/api/v1/me", { headers: authorization ? { authorization } : {} });

  test("requires a bearer token", async () => {
    const error = await expectStatus(getCurrentUser(request(), settings, { keys }), 401);
    assert.equal(error.detail, "Authentication required");
    assert.equal(error.headers["WWW-Authenticate"], "Bearer");
    await expectStatus(getCurrentUser(request("Basic abc"), settings, { keys }), 401);
  });

  test("reports missing configuration as 503", async () => {
    const error = await expectStatus(getCurrentUser(request("Bearer x"), makeSettings(), { keys }), 503);
    assert.equal(error.detail, "Authentication is not configured");
  });

  test("returns the verified user with the raw access token", async () => {
    const token = await makeToken();
    const user = await getCurrentUser(request(`bearer ${token}`), settings, { keys });
    assert.deepEqual(user, { id: USER_ID, email: "student@example.edu", accessToken: token });
  });
});
