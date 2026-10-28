import json
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app.core.auth import AuthenticatedUser
from app.core.settings import Settings
from app.modules.documents.uploads import create_course_document, validate_document

SUPABASE_URL = "https://campus.example.supabase.co"
SUPABASE_KEY = "public-test-key"
COURSE_ID = uuid4()
USER_ID = uuid4()


def get_settings() -> Settings:
    return Settings(
        supabase_url=SUPABASE_URL,
        supabase_anon_key=SUPABASE_KEY,
    )


def get_user() -> AuthenticatedUser:
    return AuthenticatedUser(id=USER_ID, email="staff@example.edu", access_token="user-jwt")


def test_validates_pdf_content_and_sanitizes_path() -> None:
    file_name, mime_type = validate_document(r"C:\fakepath\lecture.pdf", b"%PDF-1.7 sample")

    assert file_name == "lecture.pdf"
    assert mime_type == "application/pdf"


def test_rejects_mismatched_file_extension() -> None:
    with pytest.raises(HTTPException) as error:
        validate_document("lecture.pdf", b"not a pdf")

    assert error.value.status_code == 415


def test_upload_registers_metadata_using_user_jwt() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.startswith("/storage/v1/object/"):
            return httpx.Response(200, json={"Key": "stored"})
        return httpx.Response(201)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = create_course_document(
            settings=get_settings(),
            user=get_user(),
            course_id=COURSE_ID,
            title="Week 1 lecture",
            filename="lecture.pdf",
            data=b"%PDF-1.7 sample",
            client=client,
        )

    assert result.course_id == COURSE_ID
    assert result.status == "queued"
    assert "sha256" not in result.model_dump()
    assert len(seen) == 2
    assert seen[0].method == "POST"
    assert seen[0].headers["authorization"] == "Bearer user-jwt"
    assert seen[0].headers["apikey"] == SUPABASE_KEY
    assert str(COURSE_ID) in str(seen[0].url)
    assert seen[1].url.path.endswith("/rest/v1/course_documents")
    metadata = json.loads(seen[1].content)
    assert metadata["id"] == str(result.id)
    assert metadata["created_by"] == str(USER_ID)
    assert metadata["sha256"]


def test_metadata_failure_cleans_up_uploaded_object() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST" and request.url.path.startswith("/storage/"):
            return httpx.Response(200)
        if request.method == "POST":
            return httpx.Response(403, json={"message": "row-level security"})
        return httpx.Response(200, json=[])

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(HTTPException) as error:
            create_course_document(
                settings=get_settings(),
                user=get_user(),
                course_id=COURSE_ID,
                title="Week 1 lecture",
                filename="lecture.pdf",
                data=b"%PDF-1.7 sample",
                client=client,
            )
    assert error.value.status_code == 403

    assert [request.method for request in seen] == ["POST", "POST", "DELETE"]
    cleanup = json.loads(seen[2].content)
    assert cleanup["prefixes"][0].startswith(f"{COURSE_ID}/")


def test_upload_refuses_to_call_supabase_without_configuration() -> None:
    with httpx.Client(
        transport=httpx.MockTransport(lambda _: httpx.Response(200))
    ) as client:
        with pytest.raises(HTTPException) as error:
            create_course_document(
                settings=Settings(),
                user=get_user(),
                course_id=COURSE_ID,
                title="Week 1 lecture",
                filename="lecture.pdf",
                data=b"%PDF-1.7 sample",
                client=client,
            )
    assert error.value.status_code == 503
