import hashlib
import json
from uuid import uuid4

import httpx
import pytest

from app.core.settings import Settings
from app.modules.documents.ingestion import (
    DocumentProcessingError,
    ExtractedPage,
    chunk_pages,
    validate_embeddings,
)
from app.workers.ingestion import (
    IngestionJob,
    OpenAICompatibleEmbeddingProvider,
    SupabaseIngestionGateway,
    process_job,
)

TEXT_DATA = b"NEXIS campus notes. " * 160


def make_job(data: bytes = TEXT_DATA) -> IngestionJob:
    return IngestionJob(
        job_id=str(uuid4()),
        lease_token=str(uuid4()),
        document_id=str(uuid4()),
        attempt_count=1,
        max_attempts=5,
        title="Course notes",
        file_name="notes.txt",
        mime_type="text/plain",
        storage_path="course-id/document-id/notes.txt",
        size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
    )


class FakeGateway:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.completed: list[dict[str, object]] | None = None
        self.failure: str | None = None

    def download(self, job: IngestionJob) -> bytes:
        return self.data

    def renew(self, job: IngestionJob) -> bool:
        return True

    def complete(self, job: IngestionJob, chunks: list[dict[str, object]]) -> None:
        self.completed = chunks

    def fail(self, job: IngestionJob, error_code: str) -> None:
        self.failure = error_code


class FakeEmbeddings:
    model = "test-embedding-model"

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.25, 0.75] for _ in texts]


def test_chunks_keep_page_references_and_overlap() -> None:
    chunks = chunk_pages([ExtractedPage(number=3, text="campus " * 500)])

    assert len(chunks) > 1
    assert [chunk.chunk_index for chunk in chunks] == list(range(len(chunks)))
    assert all(chunk.page_start == 3 and chunk.page_end == 3 for chunk in chunks)
    assert set(chunks[0].content.split()) & set(chunks[1].content.split())


def test_rejects_embedding_vectors_with_inconsistent_dimensions() -> None:
    with pytest.raises(DocumentProcessingError, match="embedding_vector_invalid"):
        validate_embeddings([[0.1, 0.2], [0.3]], 2)


def test_worker_persists_chunks_only_after_integrity_check() -> None:
    gateway = FakeGateway(TEXT_DATA)
    success = process_job(make_job(), gateway, FakeEmbeddings())  # type: ignore[arg-type]

    assert success is True
    assert gateway.failure is None
    assert gateway.completed
    assert gateway.completed[0]["embedding_model"] == "test-embedding-model"
    assert gateway.completed[0]["page_start"] is None


def test_worker_retries_integrity_failure_without_embedding() -> None:
    gateway = FakeGateway(b"different file")
    job = make_job()
    success = process_job(job, gateway, FakeEmbeddings())  # type: ignore[arg-type]

    assert success is False
    assert gateway.completed is None
    assert gateway.failure == "stored_file_integrity_check_failed"


def test_embedding_adapter_sends_configured_model_and_parses_results() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": index, "embedding": [float(index), 1.0]}
                    for index, _ in enumerate(body["input"])
                ]
            },
        )

    settings = Settings(
        ai_embedding_endpoint="https://embeddings.example/v1/embeddings",
        ai_embedding_model="campus-model",
        ai_api_key="test-key",
    )
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        provider = OpenAICompatibleEmbeddingProvider(settings, client)
        vectors = provider.embed(["first", "second"])

    assert vectors == [[0.0, 1.0], [1.0, 1.0]]
    assert seen[0].headers["authorization"] == "Bearer test-key"
    assert json.loads(seen[0].content)["model"] == "campus-model"


def test_gateway_claim_uses_service_role_and_parses_job() -> None:
    payload = make_job().model_dump()

    def handle(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/rpc/claim_document_ingestion_job")
        assert request.headers["authorization"] == "Bearer server-secret"
        return httpx.Response(200, json=[payload])

    settings = Settings(
        supabase_url="https://campus.example.supabase.co",
        supabase_service_role_key="server-secret",
    )
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        gateway = SupabaseIngestionGateway(settings, client)
        job = gateway.claim()

    assert job is not None
    assert job.sha256 == payload["sha256"]
