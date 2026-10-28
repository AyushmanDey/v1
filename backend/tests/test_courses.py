import json
from datetime import datetime, timezone
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app.core.auth import AuthenticatedUser
from app.core.settings import Settings
from app.modules.courses.schemas import CourseCreate
from app.modules.courses.service import create_user_course, list_user_courses

USER_ID = uuid4()
COURSE_ID = uuid4()
COURSE_ROW = {
    "id": str(COURSE_ID),
    "name": "Foundations of Biology",
    "code": "BIO-101",
    "created_at": datetime.now(timezone.utc).isoformat(),
}


def _settings() -> Settings:
    return Settings(
        supabase_url="https://campus.example.supabase.co",
        supabase_anon_key="publishable-test-key",
    )


def _user() -> AuthenticatedUser:
    return AuthenticatedUser(USER_ID, "student@example.edu", "student-jwt")


def test_list_courses_uses_user_token_and_returns_rls_visible_courses() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.headers["authorization"] == "Bearer student-jwt"
        assert request.headers["apikey"] == "publishable-test-key"
        assert request.url.params["select"] == "id,name,code,created_at"
        return httpx.Response(200, json=[COURSE_ROW])

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        courses = list_user_courses(settings=_settings(), user=_user(), client=client)

    assert len(courses) == 1
    assert courses[0].id == COURSE_ID
    assert courses[0].code == "BIO-101"


def test_create_course_derives_owner_from_authenticated_user() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.headers["authorization"] == "Bearer student-jwt"
        assert request.headers["prefer"] == "return=representation"
        payload = json.loads(request.content)
        assert payload == {
            "owner_id": str(USER_ID),
            "name": "Foundations of Biology",
            "code": "BIO-101",
        }
        return httpx.Response(201, json=[COURSE_ROW])

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        course = create_user_course(
            settings=_settings(),
            user=_user(),
            course=CourseCreate(name=" Foundations of Biology ", code=" BIO-101 "),
            client=client,
        )

    assert course.id == COURSE_ID


def test_create_course_does_not_allow_blank_fields() -> None:
    with pytest.raises(ValueError):
        CourseCreate(name="  ", code="BIO-101")


def test_supabase_rls_denial_is_reported_as_forbidden() -> None:
    with httpx.Client(
        transport=httpx.MockTransport(lambda _: httpx.Response(403))
    ) as client:
        with pytest.raises(HTTPException) as error:
            list_user_courses(settings=_settings(), user=_user(), client=client)

    assert error.value.status_code == 403
