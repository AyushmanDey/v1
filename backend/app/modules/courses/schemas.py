from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class CourseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    code: str = Field(min_length=1, max_length=40)

    @field_validator("name", "code")
    @classmethod
    def trim_and_require_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Value cannot be blank")
        return value


class CourseSummary(BaseModel):
    id: UUID
    name: str
    code: str
    created_at: datetime
