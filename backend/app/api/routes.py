from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, File, Form, UploadFile

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.settings import Settings, get_settings
from app.modules.campus_assistant.rag import answer_course_question
from app.modules.campus_assistant.schemas import AskRequest, AskResponse
from app.modules.courses.schemas import CourseCreate, CourseSummary
from app.modules.courses.service import create_user_course, list_user_courses
from app.modules.documents.uploads import (
    MAX_DOCUMENT_BYTES,
    CreatedDocument,
    create_course_document,
)

router = APIRouter()


@router.get("/health", tags=["operations"])
def health_check() -> dict[str, str]:
    """Report that the API process is accepting requests."""
    return {"status": "ok"}


@router.get("/me", tags=["authentication"])
def current_user(
    user: AuthenticatedUser = Depends(get_current_user),
) -> dict[str, str | None]:
    return {"id": str(user.id), "email": user.email}


@router.get("/courses", response_model=list[CourseSummary], tags=["courses"])
def get_courses(
    user: AuthenticatedUser = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> list[CourseSummary]:
    with httpx.Client(timeout=httpx.Timeout(15.0, connect=5.0)) as client:
        return list_user_courses(settings=settings, user=user, client=client)


@router.post("/courses", status_code=201, response_model=CourseSummary, tags=["courses"])
def post_course(
    request: CourseCreate,
    user: AuthenticatedUser = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> CourseSummary:
    with httpx.Client(timeout=httpx.Timeout(15.0, connect=5.0)) as client:
        return create_user_course(
            settings=settings, user=user, course=request, client=client
        )


@router.post(
    "/courses/{course_id}/documents",
    status_code=201,
    response_model=CreatedDocument,
    tags=["documents"],
)
def upload_course_document(
    course_id: UUID,
    title: str = Form(...),
    file: UploadFile = File(...),
    user: AuthenticatedUser = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> CreatedDocument:
    try:
        data = file.file.read(MAX_DOCUMENT_BYTES + 1)
    finally:
        file.file.close()
    with httpx.Client(timeout=httpx.Timeout(30.0)) as client:
        return create_course_document(
            settings=settings,
            user=user,
            course_id=course_id,
            title=title,
            filename=file.filename or "",
            data=data,
            client=client,
        )


@router.post(
    "/courses/{course_id}/assistant/ask",
    response_model=AskResponse,
    tags=["campus assistant"],
)
def ask_course_question(
    course_id: UUID,
    request: AskRequest,
    user: AuthenticatedUser = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> AskResponse:
    with httpx.Client(timeout=httpx.Timeout(90.0, connect=10.0)) as client:
        return answer_course_question(
            settings=settings,
            user=user,
            course_id=course_id,
            question=request.question,
            client=client,
        )
