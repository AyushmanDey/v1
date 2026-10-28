import logging
from uuid import UUID

import httpx
from fastapi import HTTPException, status
from pydantic import ValidationError

from app.core.auth import AuthenticatedUser
from app.core.settings import Settings
from app.modules.courses.schemas import CourseCreate, CourseSummary

logger = logging.getLogger(__name__)


def list_user_courses(
    *, settings: Settings, user: AuthenticatedUser, client: httpx.Client
) -> list[CourseSummary]:
    base_url, anon_key = _require_supabase(settings)
    try:
        response = client.get(
            f"{base_url}/rest/v1/courses",
            params={"select": "id,name,code,created_at", "order": "name.asc"},
            headers=_headers(user, anon_key),
        )
        _raise_for_supabase(response, user_id=user.id)
        rows = response.json()
        if not isinstance(rows, list):
            raise ValueError("Course query did not return a list")
        return [CourseSummary.model_validate(row) for row in rows]
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="Course service is unavailable") from error
    except (ValueError, ValidationError, TypeError) as error:
        raise HTTPException(status_code=502, detail="Course service returned invalid data") from error


def create_user_course(
    *,
    settings: Settings,
    user: AuthenticatedUser,
    course: CourseCreate,
    client: httpx.Client,
) -> CourseSummary:
    base_url, anon_key = _require_supabase(settings)
    payload = {"owner_id": str(user.id), "name": course.name, "code": course.code}
    try:
        response = client.post(
            f"{base_url}/rest/v1/courses",
            params={"select": "id,name,code,created_at"},
            json=payload,
            headers={
                **_headers(user, anon_key),
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            },
        )
        _raise_for_supabase(response, user_id=user.id)
        rows = response.json()
        if not isinstance(rows, list) or len(rows) != 1:
            raise ValueError("Course creation did not return one course")
        return CourseSummary.model_validate(rows[0])
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="Course service is unavailable") from error
    except (ValueError, ValidationError, TypeError) as error:
        raise HTTPException(status_code=502, detail="Course service returned invalid data") from error


def _require_supabase(settings: Settings) -> tuple[str, str]:
    if not settings.supabase_url or not settings.supabase_anon_key:
        raise HTTPException(status_code=503, detail="Course service is not configured")
    return settings.supabase_url.rstrip("/"), settings.supabase_anon_key


def _headers(user: AuthenticatedUser, anon_key: str) -> dict[str, str]:
    if not user.access_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return {"apikey": anon_key, "Authorization": f"Bearer {user.access_token}"}


def _raise_for_supabase(response: httpx.Response, *, user_id: UUID) -> None:
    if response.status_code in (401, 403):
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        error_code = payload.get("code") if isinstance(payload, dict) else None
        error_message = payload.get("message") if isinstance(payload, dict) else None
        logger.warning(
            "supabase_course_request_rejected status=%s code=%s user_id=%s message=%s",
            response.status_code,
            error_code or "unknown",
            user_id,
            error_message or "unknown",
        )
        if response.status_code == 401:
            raise HTTPException(
                status_code=401,
                detail="Your sign-in to Supabase is invalid or expired. Sign in again.",
            )
        raise HTTPException(
            status_code=403,
            detail="Supabase denied this course request. Check the course access policy.",
        )
    if response.is_error:
        raise HTTPException(status_code=502, detail="Course data request failed")
