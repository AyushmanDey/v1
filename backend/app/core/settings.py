from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", env_file=".env")

    frontend_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    supabase_url: str | None = None
    supabase_anon_key: str | None = None
    supabase_service_role_key: str | None = None
    supabase_storage_bucket: str = "course-documents"
    ai_embedding_endpoint: str | None = None
    ai_embedding_model: str | None = None
    ai_api_key: str | None = None
    ai_chat_endpoint: str | None = None
    ai_chat_model: str | None = None
    ai_chat_reasoning_effort: str | None = None
    rag_min_similarity: float = Field(default=0.70, ge=0, le=1)
    rag_max_chunks: int = Field(default=8, ge=1, le=10)


@lru_cache
def get_settings() -> Settings:
    return Settings()



