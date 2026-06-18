"""SQLAlchemy ORM model for the request log (Postgres)."""

from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Request(Base):
    """One row per LLM request. Proxy inserts it (status=queued), LLM Service
    updates it (processing -> done/error), Request Service reads the response."""

    __tablename__ = "requests"

    request_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    token: Mapped[str | None] = mapped_column(String(256), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    payload: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    response: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
