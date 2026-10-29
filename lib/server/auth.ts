import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { HttpError, isUuid, normalizeUuid, trimTrailingSlash, type FetchLike } from "./http";
import type { Settings } from "./settings";

export const ALLOWED_ALGORITHMS = ["ES256", "RS256", "EdDSA"];

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  accessToken: string | null;
}

const BEARER_CHALLENGE = { "WWW-Authenticate": "Bearer" };
const jwksCache = new Map<string, JWTVerifyGetKey>();

function invalidToken(): HttpError {
  return new HttpError(401, "Invalid or expired access token", BEARER_CHALLENGE);
}

function remoteJwks(jwksUrl: string, fetchImpl?: FetchLike): JWTVerifyGetKey {
  if (fetchImpl) return createRemoteJWKSet(new URL(jwksUrl), { [customFetch]: fetchImpl });
  let keys = jwksCache.get(jwksUrl);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwksUrl));
    if (jwksCache.size >= 8) jwksCache.clear();
    jwksCache.set(jwksUrl, keys);
  }
  return keys;
}

/** True when a JWKS lookup failed because the key server could not be reached or read. */
function isKeyAvailabilityError(error: unknown): boolean {
  if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) return true;
  if (error instanceof joseErrors.JOSEError) return error.code === joseErrors.JOSEError.code;
  return true;
}

/** Verify a Supabase asymmetric access token and return its user identity. */
export async function verifyAccessToken(
  token: string,
  supabaseUrl: string,
  options: { keys?: JWTVerifyGetKey; fetch?: FetchLike } = {},
): Promise<AuthenticatedUser> {
  const projectUrl = trimTrailingSlash(supabaseUrl);
  const keys = options.keys ?? remoteJwks(`${projectUrl}/auth/v1/.well-known/jwks.json`, options.fetch);

  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ALLOWED_ALGORITHMS,
      audience: "authenticated",
      issuer: `${projectUrl}/auth/v1`,
      requiredClaims: ["exp", "iss", "aud", "sub"],
    }));
  } catch (error) {
    if (isKeyAvailabilityError(error)) {
      throw new HttpError(503, "Authentication keys are temporarily unavailable");
    }
    throw invalidToken();
  }

  if (payload.role !== "authenticated" || !isUuid(payload.sub)) throw invalidToken();
  return {
    id: normalizeUuid(payload.sub),
    email: typeof payload.email === "string" ? payload.email : null,
    accessToken: null,
  };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  const token = rest.join(" ");
  if (scheme.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export async function getCurrentUser(
  request: Request,
  settings: Settings,
  options: { keys?: JWTVerifyGetKey; fetch?: FetchLike } = {},
): Promise<AuthenticatedUser> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Authentication required", BEARER_CHALLENGE);
  if (!settings.supabaseUrl) throw new HttpError(503, "Authentication is not configured");
  const user = await verifyAccessToken(token, settings.supabaseUrl, options);
  return { ...user, accessToken: token };
}
