import hashlib
import io
import logging
from uuid import UUID, uuid4
from zipfile import BadZipFile, ZipFile

import httpx
from fastapi import HTTPException, status
from pydantic import BaseModel

from app.core.auth import AuthenticatedUser
from app.core.settings import Settings

logger = logging.getLogger(__name__)
MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
MAX_DOCX_EXPANDED_BYTES = 100 * 1024 * 1024
MAX_DOCX_MEMBERS = 10_000
ALLOWED_EXTENSIONS = {".pdf", ".txt", ".docx"}
MIME_TYPES = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


class CreatedDocument(BaseModel):
    id: UUID
    course_id: UUID
    title: str
    file_name: str
    mime_type: str
    size_bytes: int
    status: str


def validate_document(filename: str, data: bytes) -> tuple[str, str]:
    """Return a safe display filename and detected MIME type."""
    normalized_name = (filename or "").replace("\\", "/").split("/")[-1].strip()
    if (
        not normalized_name
        or len(normalized_name) > 255
        or any(ord(char) < 32 or ord(char) == 127 for char in normalized_name)
    ):
        raise HTTPException(status_code=422, detail="Invalid file name")
    if not data:
        raise HTTPException(status_code=422, detail="The uploaded file is empty")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds the 25 MiB limit")

    extension = _extension(normalized_name)
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Only PDF, TXT, and DOCX files are supported")

    if extension == ".pdf" and not data.startswith(b"%PDF-"):
        raise HTTPException(status_code=415, detail="File content does not match PDF format")
    if extension == ".txt":
        try:
            data.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise HTTPException(status_code=415, detail="Text files must use UTF-8 encoding") from error
        if b"\x00" in data:
            raise HTTPException(status_code=415, detail="Text file contains binary data")
    if extension == ".docx":
        _validate_docx(data)

    return normalized_name, MIME_TYPES[extension]


def _extension(filename: str) -> str:
    return filename[filename.rfind("."):].lower() if "." in filename else ""


def _validate_docx(data: bytes) -> None:
    try:
        with ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            if (
                len(members) > MAX_DOCX_MEMBERS
                or "[Content_Types].xml" not in archive.namelist()
                or "word/document.xml" not in archive.namelist()
                or sum(member.file_size for member in members) > MAX_DOCX_EXPANDED_BYTES
            ):
                raise HTTPException(status_code=415, detail="Invalid or oversized DOCX file")
    except (BadZipFile, OSError) as error:
        raise HTTPException(status_code=415, detail="File content does not match DOCX format") from error


def create_course_document(
    *,
    settings: Settings,
    user: AuthenticatedUser,
    course_id: UUID,
    title: str,
    filename: str,
    data: bytes,
    client: httpx.Client,
) -> CreatedDocument:
    if not settings.supabase_url or not settings.supabase_anon_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Document storage is not configured",
        )
    if not user.access_token:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not 1 <= len(title.strip()) <= 200:
        raise HTTPException(status_code=422, detail="Title must be between 1 and 200 characters")

    safe_name, mime_type = validate_document(filename, data)
    document_id = uuid4()
    storage_path = f"{course_id}/{document_id}/{safe_name}"
    base_url = settings.supabase_url.rstrip("/")
    bucket = settings.supabase_storage_bucket
    encoded_bucket = _encode_path(bucket)
    encoded_path = _encode_path(storage_path, preserve_slashes=True)
    headers = {
        "apikey": settings.supabase_anon_key,
        "Authorization": f"Bearer {user.access_token}",
    }

    try:
        storage_response = client.post(
            f"{base_url}/storage/v1/object/{encoded_bucket}/{encoded_path}",
            content=data,
            headers={
                **headers,
                "Content-Type": mime_type,
                "x-upsert": "false",
            },
        )
    except httpx.HTTPError as error:
        raise HTTPException(status_code=503, detail="Document storage is unavailable") from error
    _raise_upstream_error(storage_response, "Storage upload failed")

    metadata = {
        "id": str(document_id),
        "course_id": str(course_id),
        "title": title.strip(),
        "file_name": safe_name,
        "mime_type": mime_type,
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "storage_path": storage_path,
        "created_by": str(user.id),
    }
    try:
        metadata_response = client.post(
            f"{base_url}/rest/v1/course_documents",
            json=metadata,
            headers={
                **headers,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
        )
        _raise_upstream_error(metadata_response, "Document registration failed")
        return CreatedDocument(
            id=document_id,
            course_id=course_id,
            title=title.strip(),
            file_name=safe_name,
            mime_type=mime_type,
            size_bytes=len(data),
            status="queued",
        )
    except (httpx.HTTPError, HTTPException) as error:
        _cleanup_uploaded_object(
            client=client,
            base_url=base_url,
            bucket=encoded_bucket,
            storage_path=encoded_path,
            headers=headers,
            document_id=document_id,
        )
        if isinstance(error, HTTPException):
            raise
        if isinstance(error, httpx.HTTPError):
            raise HTTPException(status_code=503, detail="Document registration is unavailable") from error


def _cleanup_uploaded_object(
    *,
    client: httpx.Client,
    base_url: str,
    bucket: str,
    storage_path: str,
    headers: dict[str, str],
    document_id: UUID,
) -> None:
    try:
        response = client.request(
            "DELETE",
            f"{base_url}/storage/v1/object/{bucket}",
            json={"prefixes": [storage_path]},
            headers={**headers, "Content-Type": "application/json"},
        )
        if response.is_error:
            logger.error(
                "document_orphan_cleanup_failed",
                extra={"document_id": str(document_id), "status_code": response.status_code},
            )
    except httpx.HTTPError:
        logger.exception("document_orphan_cleanup_failed", extra={"document_id": str(document_id)})


def _raise_upstream_error(response: httpx.Response, message: str) -> None:
    if not response.is_error:
        return
    if response.status_code in (401, 403):
        raise HTTPException(status_code=403, detail="You are not authorized to access this course")
    if response.status_code == 413:
        raise HTTPException(status_code=413, detail="File exceeds the storage limit")
    if response.status_code == 415:
        raise HTTPException(status_code=415, detail="Storage rejected the file type")
    raise HTTPException(status_code=502, detail=message)


def _encode_path(value: str, *, preserve_slashes: bool = False) -> str:
    from urllib.parse import quote

    return quote(value, safe="/" if preserve_slashes else "")
