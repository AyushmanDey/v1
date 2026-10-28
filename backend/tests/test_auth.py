from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import jwt
import pytest
from fastapi import HTTPException
from jwt.exceptions import MissingCryptographyError

from app.core.auth import verify_access_token

SUPABASE_URL = "https://campus.example.supabase.co"
USER_ID = uuid4()


class StaticSigningKey:
    key = "verified-public-key"


class StaticJwksClient:
    def get_signing_key_from_jwt(self, token: str) -> StaticSigningKey:
        return StaticSigningKey()


def make_claims(**overrides: object) -> dict[str, object]:
    now = datetime.now(UTC)
    claims: dict[str, object] = {
        "sub": str(USER_ID),
        "iss": f"{SUPABASE_URL}/auth/v1",
        "aud": "authenticated",
        "role": "authenticated",
        "iat": now,
        "exp": now + timedelta(minutes=5),
        "email": "student@example.edu",
    }
    claims.update(overrides)
    return claims


def test_builds_identity_from_claims_accepted_by_jwt_decoder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decode_calls: dict[str, object] = {}

    def decode(token: str, key: object, **options: object) -> dict[str, object]:
        decode_calls.update(options)
        assert token == "valid-token"
        assert key == "verified-public-key"
        return make_claims()

    monkeypatch.setattr(jwt, "decode", decode)
    user = verify_access_token(
        "valid-token", SUPABASE_URL, jwks_client=StaticJwksClient()
    )

    assert user.id == UUID(str(USER_ID))
    assert user.email == "student@example.edu"
    assert decode_calls["algorithms"] == ["ES256", "RS256", "EdDSA"]
    assert decode_calls["audience"] == "authenticated"
    assert decode_calls["issuer"] == f"{SUPABASE_URL}/auth/v1"


@pytest.mark.parametrize(
    "claim_overrides",
    [
        {"iss": "https://other.example/auth/v1"},
        {"aud": "anon"},
        {"role": "anon"},
        {"sub": "not-a-uuid"},
        {"exp": datetime.now(UTC) - timedelta(minutes=1)},
    ],
)
def test_rejects_invalid_claims_reported_by_jwt_decoder(
    monkeypatch: pytest.MonkeyPatch, claim_overrides: dict[str, object]
) -> None:
    def decode(token: str, key: object, **options: object) -> dict[str, object]:
        claims = make_claims(**claim_overrides)
        if claims["iss"] != options["issuer"]:
            raise jwt.InvalidIssuerError("issuer mismatch")
        if claims["aud"] != options["audience"]:
            raise jwt.InvalidAudienceError("audience mismatch")
        if claims["exp"] <= datetime.now(UTC):  # type: ignore[operator]
            raise jwt.ExpiredSignatureError("token expired")
        return claims

    monkeypatch.setattr(jwt, "decode", decode)

    with pytest.raises(HTTPException) as error:
        verify_access_token(
            "invalid-token", SUPABASE_URL, jwks_client=StaticJwksClient()
        )

    assert error.value.status_code == 401


def test_rejects_token_when_jwt_library_reports_bad_signature(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reject_signature(*args: object, **kwargs: object) -> None:
        raise jwt.InvalidSignatureError("signature mismatch")

    monkeypatch.setattr(jwt, "decode", reject_signature)

    with pytest.raises(HTTPException) as error:
        verify_access_token(
            "bad-signature-token", SUPABASE_URL, jwks_client=StaticJwksClient()
        )

    assert error.value.status_code == 401


def test_rejects_malformed_jwt_without_server_error() -> None:
    class MalformedJwksClient:
        def get_signing_key_from_jwt(self, token: str) -> StaticSigningKey:
            raise jwt.DecodeError("Not enough segments")

    with pytest.raises(HTTPException) as error:
        verify_access_token(
            "malformed-token", SUPABASE_URL, jwks_client=MalformedJwksClient()
        )

    assert error.value.status_code == 401


def test_reports_missing_crypto_support_as_service_unavailable() -> None:
    class CryptoUnavailableJwksClient:
        def get_signing_key_from_jwt(self, token: str) -> StaticSigningKey:
            raise MissingCryptographyError("cryptography is unavailable")

    with pytest.raises(HTTPException) as error:
        verify_access_token(
            "valid-token", SUPABASE_URL, jwks_client=CryptoUnavailableJwksClient()
        )

    assert error.value.status_code == 503
