import argparse
import hashlib
import logging
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlparse

import httpx
from pydantic import BaseModel, ValidationError

from app.core.settings import Settings, get_settings
from app.modules.documents.ingestion import (
    DocumentProcessingError,
    EmbeddingProvider,
    chunk_pages,
    extract_document,
    validate_embeddings,
)

logger = logging.getLogger("nexis.ingestion")
EMBEDDING_BATCH_SIZE = 48


class IngestionJob(BaseModel):
    job_id: str
    lease_token: str
    document_id: str
    attempt_count: int
    max_attempts: int
    title: str
    file_name: str
    mime_type: str
    storage_path: str
    size_bytes: int
    sha256: str


@dataclass
class SupabaseIngestionGateway:
    settings: Settings
    client: httpx.Client

    def __post_init__(self) -> None:
        if not self.settings.supabase_url or not self.settings.supabase_service_role_key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
        self.base_url = self.settings.supabase_url.rstrip("/")
        self.headers = {
            "apikey": self.settings.supabase_service_role_key,
            "Authorization": f"Bearer {self.settings.supabase_service_role_key}",
        }

    def claim(self) -> IngestionJob | None:
        response = self.client.post(
            f"{self.base_url}/rest/v1/rpc/claim_document_ingestion_job",
            json={},
            headers=self.headers,
        )
        response.raise_for_status()
        result = response.json()
        if not result:
            return None
        try:
            return IngestionJob.model_validate(result[0])
        except (IndexError, ValidationError) as error:
            raise RuntimeError("Claim function returned an invalid job") from error

    def download(self, job: IngestionJob) -> bytes:
        bucket = quote(self.settings.supabase_storage_bucket, safe="")
        path = quote(job.storage_path, safe="/")
        response = self.client.get(
            f"{self.base_url}/storage/v1/object/{bucket}/{path}",
            headers=self.headers,
        )
        response.raise_for_status()
        return response.content

    def complete(self, job: IngestionJob, chunks: list[dict[str, Any]]) -> None:
        response = self.client.post(
            f"{self.base_url}/rest/v1/rpc/complete_document_ingestion",
            json={
                "target_job_id": job.job_id,
                "target_lease_token": job.lease_token,
                "chunk_payloads": chunks,
            },
            headers=self.headers,
        )
        response.raise_for_status()

    def fail(self, job: IngestionJob, error_code: str) -> None:
        response = self.client.post(
            f"{self.base_url}/rest/v1/rpc/fail_document_ingestion",
            json={
                "target_job_id": job.job_id,
                "target_lease_token": job.lease_token,
                "error_message": error_code,
            },
            headers=self.headers,
        )
        response.raise_for_status()

    def renew(self, job: IngestionJob) -> bool:
        response = self.client.post(
            f"{self.base_url}/rest/v1/rpc/renew_document_ingestion_job",
            json={"target_job_id": job.job_id, "target_lease_token": job.lease_token},
            headers=self.headers,
        )
        response.raise_for_status()
        return response.json() is True


class OpenAICompatibleEmbeddingProvider:
    """Adapter for a configured endpoint with OpenAI-compatible embeddings JSON."""

    def __init__(self, settings: Settings, client: httpx.Client) -> None:
        endpoint = settings.ai_embedding_endpoint
        model = settings.ai_embedding_model
        if not endpoint or not model:
            raise RuntimeError("AI_EMBEDDING_ENDPOINT and AI_EMBEDDING_MODEL are required")
        parsed = urlparse(endpoint)
        if parsed.username or parsed.password:
            raise RuntimeError("Embedding endpoint credentials belong in AI_API_KEY")
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise RuntimeError("Embedding endpoint must use HTTPS")
        self.endpoint = endpoint
        self.model = model
        self.client = client
        self.headers = {"Content-Type": "application/json"}
        if settings.ai_api_key:
            self.headers["Authorization"] = f"Bearer {settings.ai_api_key}"

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for offset in range(0, len(texts), EMBEDDING_BATCH_SIZE):
            batch = texts[offset : offset + EMBEDDING_BATCH_SIZE]
            try:
                response = self.client.post(
                    self.endpoint,
                    json={"model": self.model, "input": batch},
                    headers=self.headers,
                )
                response.raise_for_status()
                payload = response.json()
                entries = payload["data"]
                if len(entries) != len(batch):
                    raise DocumentProcessingError("embedding_response_count_mismatch")
                ordered = sorted(entries, key=lambda entry: entry["index"])
                if [entry["index"] for entry in ordered] != list(range(len(batch))):
                    raise DocumentProcessingError("embedding_response_count_mismatch")
                vectors.extend(
                    [[float(value) for value in entry["embedding"]] for entry in ordered]
                )
            except DocumentProcessingError:
                raise
            except Exception as error:
                raise DocumentProcessingError("embedding_provider_failed") from error
        validate_embeddings(vectors, len(texts))
        return vectors


def process_job(
    job: IngestionJob,
    gateway: SupabaseIngestionGateway,
    embeddings: EmbeddingProvider,
) -> bool:
    try:
        data = gateway.download(job)
        if len(data) != job.size_bytes or hashlib.sha256(data).hexdigest() != job.sha256:
            raise DocumentProcessingError("stored_file_integrity_check_failed")
        if not gateway.renew(job):
            raise DocumentProcessingError("worker_lease_lost")
        pages = extract_document(job.file_name, job.mime_type, data)
        text_chunks = chunk_pages(pages)
        if not gateway.renew(job):
            raise DocumentProcessingError("worker_lease_lost")
        vectors: list[list[float]] = []
        for offset in range(0, len(text_chunks), EMBEDDING_BATCH_SIZE):
            vectors.extend(
                embeddings.embed(
                    [chunk.content for chunk in text_chunks[offset : offset + EMBEDDING_BATCH_SIZE]]
                )
            )
            if not gateway.renew(job):
                raise DocumentProcessingError("worker_lease_lost")
        validate_embeddings(vectors, len(text_chunks))
        payload = [
            {
                "chunk_index": chunk.chunk_index,
                "content": chunk.content,
                "embedding": vectors[index],
                "embedding_model": embeddings.model,
                "page_start": chunk.page_start,
                "page_end": chunk.page_end,
            }
            for index, chunk in enumerate(text_chunks)
        ]
        gateway.complete(job, payload)
        logger.info("document_ingestion_completed", extra={"job_id": job.job_id})
        return True
    except Exception as error:
        error_code = (
            error.code if isinstance(error, DocumentProcessingError) else "document_ingestion_failed"
        )
        logger.error(
            "document_ingestion_attempt_failed",
            extra={
                "job_id": job.job_id,
                "error_code": error_code,
                "error_type": type(error).__name__,
            },
        )
        try:
            gateway.fail(job, error_code)
        except Exception:
            logger.exception("document_ingestion_failure_update_failed", extra={"job_id": job.job_id})
        return False


def run_once(settings: Settings) -> bool:
    if not settings.ai_embedding_endpoint or not settings.ai_embedding_model:
        raise RuntimeError("Configure AI_EMBEDDING_ENDPOINT and AI_EMBEDDING_MODEL before starting the worker")
    timeout = httpx.Timeout(90.0, connect=10.0)
    with httpx.Client(timeout=timeout) as client:
        gateway = SupabaseIngestionGateway(settings, client)
        embeddings = OpenAICompatibleEmbeddingProvider(settings, client)
        job = gateway.claim()
        if job is None:
            return False
        return process_job(job, gateway, embeddings)


def run_forever(settings: Settings, poll_seconds: float = 2.0) -> None:
    while True:
        try:
            run_once(settings)
        except Exception:
            logger.exception("document_ingestion_worker_iteration_failed")
        time.sleep(poll_seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description="Process queued NEXIS course documents")
    parser.add_argument("--once", action="store_true", help="Claim at most one job and exit")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    if args.once:
        run_once(settings)
    else:
        run_forever(settings)


if __name__ == "__main__":
    main()
