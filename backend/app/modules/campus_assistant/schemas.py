from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1_000)

    @field_validator("question")
    @classmethod
    def question_must_contain_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Question cannot be blank")
        return value


class Citation(BaseModel):
    source_id: str
    chunk_id: UUID
    document_id: UUID
    title: str
    file_name: str
    page_start: int | None
    page_end: int | None
    chunk_index: int
    similarity: float
    url: str
    excerpt: str


class AskResponse(BaseModel):
    answer: str
    insufficient_evidence: bool
    citations: list[Citation]
