import json
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app.core.auth import AuthenticatedUser
from app.core.settings import Settings
from app.modules.campus_assistant.rag import answer_course_question

COURSE_ID = uuid4()
USER_ID = uuid4()
DOCUMENT_ID = uuid4()
CHUNK_ID = uuid4()


def settings() -> Settings:
    return Settings(
        supabase_url="https://campus.example.supabase.co",
        supabase_anon_key="public-test-key",
        ai_embedding_endpoint="https://ai.example/embeddings",
        ai_embedding_model="campus-embedding-v1",
        ai_chat_endpoint="https://ai.example/chat/completions",
        ai_chat_model="campus-chat-v1",
        ai_api_key="provider-test-key",
        rag_min_similarity=0.7,
        rag_max_chunks=8,
    )


def user() -> AuthenticatedUser:
    return AuthenticatedUser(USER_ID, "student@example.edu", "student-jwt")


def source_row() -> dict[str, object]:
    return {
        "chunk_id": str(CHUNK_ID),
        "document_id": str(DOCUMENT_ID),
        "chunk_index": 0,
        "title": "Week 1 Lecture",
        "file_name": "lecture.pdf",
        "storage_path": f"{COURSE_ID}/{DOCUMENT_ID}/lecture.pdf",
        "content": "The course defines retrieval-augmented generation as grounding answers in sources.",
        "page_start": 4,
        "page_end": 4,
        "similarity": 0.86,
    }


def test_answer_contains_only_verified_course_citations() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/current_user_can_access_course"):
            return httpx.Response(200, json=True)
        if request.url.path == "/embeddings":
            return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1, 0.2]}]})
        if request.url.path.endswith("/match_course_document_chunks"):
            assert request.headers["authorization"] == "Bearer student-jwt"
            body = json.loads(request.content)
            assert body["target_course_id"] == str(COURSE_ID)
            assert body["target_embedding_model"] == "campus-embedding-v1"
            return httpx.Response(200, json=[source_row()])
        if request.url.path == "/chat/completions":
            request_body = json.loads(request.content)
            assert "never as instructions" in request_body["messages"][0]["content"]
            assert request_body["response_format"] == {"type": "json_object"}
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps(
                                    {
                                        "answer": "RAG grounds generated answers in source material [S1].",
                                        "insufficient_evidence": False,
                                        "citations": ["S1"],
                                    }
                                )
                            }
                        }
                    ]
                },
            )
        if "/object/sign/" in request.url.path:
            assert request.headers["authorization"] == "Bearer student-jwt"
            return httpx.Response(200, json={"signedURL": "/object/sign/course-documents/file?token=signed"})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = answer_course_question(
            settings=settings(),
            user=user(),
            course_id=COURSE_ID,
            question="What is RAG?",
            client=client,
        )

    assert result.insufficient_evidence is False
    assert result.answer.startswith("RAG grounds")
    assert len(result.citations) == 1
    citation = result.citations[0]
    assert citation.source_id == "S1"
    assert citation.chunk_id == CHUNK_ID
    assert citation.page_start == 4
    assert citation.url == "https://campus.example.supabase.co/storage/v1/object/sign/course-documents/file?token=signed"
    assert [request.url.path.split("/")[-1] for request in seen[:4]] == [
        "current_user_can_access_course",
        "embeddings",
        "match_course_document_chunks",
        "completions",
    ]


def test_insufficient_retrieval_abstains_without_calling_chat_model() -> None:
    seen_paths: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        if request.url.path.endswith("/current_user_can_access_course"):
            return httpx.Response(200, json=True)
        if request.url.path == "/embeddings":
            return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1, 0.2]}]})
        if request.url.path.endswith("/match_course_document_chunks"):
            return httpx.Response(200, json=[])
        raise AssertionError("No model or source-link request should be made")

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = answer_course_question(
            settings=settings(),
            user=user(),
            course_id=COURSE_ID,
            question="What is an unrelated topic?",
            client=client,
        )

    assert result.insufficient_evidence is True
    assert result.citations == []
    assert "couldn't find enough" in result.answer
    assert len(seen_paths) == 3


def test_rejects_model_citations_outside_retrieved_sources() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/current_user_can_access_course"):
            return httpx.Response(200, json=True)
        if request.url.path == "/embeddings":
            return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1, 0.2]}]})
        if request.url.path.endswith("/match_course_document_chunks"):
            return httpx.Response(200, json=[source_row()])
        if request.url.path == "/chat/completions":
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps(
                                    {
                                        "answer": "Unsupported answer",
                                        "insufficient_evidence": False,
                                        "citations": ["S99"],
                                    }
                                )
                            }
                        }
                    ]
                },
            )
        raise AssertionError("Invalid citations must fail before source URL signing")

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(HTTPException) as error:
            answer_course_question(
                settings=settings(),
                user=user(),
                course_id=COURSE_ID,
                question="What is RAG?",
                client=client,
            )

    assert error.value.status_code == 502


def test_rejects_non_member_before_calling_embedding_provider() -> None:
    seen_paths: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        if request.url.path.endswith("/current_user_can_access_course"):
            return httpx.Response(200, json=False)
        raise AssertionError("Unauthorized users must not reach model providers")

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(HTTPException) as error:
            answer_course_question(
                settings=settings(),
                user=user(),
                course_id=COURSE_ID,
                question="What is RAG?",
                client=client,
            )

    assert error.value.status_code == 404
    assert len(seen_paths) == 1
