"""Environment-driven configuration shared by all services."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
        protected_namespaces=(),
    )

    # Infrastructure
    database_url: str = "postgresql+asyncpg://aiplugin:aiplugin@postgres:5432/aiplugin"
    rabbit_url: str = "amqp://guest:guest@rabbitmq:5672/"

    # Shared files (mounted as volumes in docker-compose)
    tokens_file: str = "/app/tokens.json"
    models_file: str = "/app/models.json"

    # LLM upstream (used by the openrouter adapter)
    openrouter_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1/chat/completions"

    # Where the Proxy reaches the LLM Service for metadata (the model list)
    llm_url: str = "http://llm:8002"

    # Queue names
    request_queue: str = "requests"
    response_queue: str = "responses"

    # How long the Request Service WebSocket waits for a response before erroring out
    ws_response_timeout: float = 180.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
