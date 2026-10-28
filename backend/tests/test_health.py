from app.api.routes import health_check
from app.main import app


def test_health_endpoint_reports_api_status() -> None:
    assert health_check() == {"status": "ok"}


def test_course_document_upload_route_is_registered() -> None:
    assert "/api/v1/courses/{course_id}/documents" in app.openapi()["paths"]


def test_campus_question_route_is_registered() -> None:
    assert "/api/v1/courses/{course_id}/assistant/ask" in app.openapi()["paths"]


def test_course_discovery_and_creation_routes_are_registered() -> None:
    paths = app.openapi()["paths"]
    assert "/api/v1/courses" in paths
    assert "get" in paths["/api/v1/courses"]
    assert "post" in paths["/api/v1/courses"]


def test_local_frontend_origin_is_in_cors_allowlist() -> None:
    cors = next(middleware for middleware in app.user_middleware if middleware.cls.__name__ == "CORSMiddleware")
    assert "http://127.0.0.1:3000" in cors.kwargs["allow_origins"]
    assert "Authorization" in cors.kwargs["allow_headers"]
