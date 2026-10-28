from dataclasses import dataclass, field
from functools import lru_cache
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import (
    InvalidTokenError,
    PyJWKClient,
    PyJWKClientConnectionError,
    PyJWKClientError,
)
from jwt.exceptions import MissingCryptographyError

from app.core.settings import Settings, get_settings

bearer_scheme = HTTPBearer(auto_error=False)
ALLOWED_ALGORITHMS = ["ES256", "RS256", "EdDSA"]


@dataclass(frozen=True)
class AuthenticatedUser:
    id: UUID
    email: str | None
    access_token: str | None = field(default=None, repr=False)


@lru_cache(maxsize=8)
def _jwks_client(jwks_url: str) -> PyJWKClient:
    return PyJWKClient(jwks_url)


def verify_access_token(
    token: str,
    supabase_url: str,
    *,
    jwks_client: PyJWKClient | None = None,
) -> AuthenticatedUser:
    """Verify a Supabase asymmetric access token and return its user identity."""
    project_url = supabase_url.rstrip("/")
    client = jwks_client or _jwks_client(
        f"{project_url}/auth/v1/.well-known/jwks.json"
    )

    try:
        signing_key = client.get_signing_key_from_jwt(token).key
    except MissingCryptographyError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="JWT verification support is unavailable",
        ) from error
    except PyJWKClientConnectionError:
        raise
    except InvalidTokenError as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from error
    except PyJWKClientError as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from error

    try:
        claims = jwt.decode(
            token,
            signing_key,
            algorithms=ALLOWED_ALGORITHMS,
            audience="authenticated",
            issuer=f"{project_url}/auth/v1",
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
        if claims.get("role") != "authenticated":
            raise InvalidTokenError("Token is not an authenticated user token")
        return AuthenticatedUser(
            id=UUID(claims["sub"]),
            email=claims.get("email"),
        )
    except (InvalidTokenError, ValueError, KeyError) as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from error


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    settings: Settings = Depends(get_settings),
) -> AuthenticatedUser:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not settings.supabase_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured",
        )
    try:
        user = verify_access_token(credentials.credentials, settings.supabase_url)
        return AuthenticatedUser(
            id=user.id,
            email=user.email,
            access_token=credentials.credentials,
        )
    except PyJWKClientConnectionError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication keys are temporarily unavailable",
        ) from error
