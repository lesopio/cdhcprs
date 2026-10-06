"""消息 API Schema。"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class MessageBase(BaseModel):
    role: str
    content: str


class MessageCreate(BaseModel):
    content: str = Field(..., min_length=1)
    user_info: Optional[str] = None
    profile_id: Optional[int] = None
    enable_web_search: bool = True
    attachment_ids: list[int] = Field(default_factory=list, max_length=4)


class MessageResponse(MessageBase):
    id: int
    conversation_id: int
    created_at: datetime
    updated_at: Optional[datetime] = None
    trace_json: Optional[str] = None
    citations_json: Optional[str] = None
    generation_status: str = "completed"
    feedback: Optional[str] = None
    analysis_summary: Optional[str] = None

    class Config:
        from_attributes = True


class MessageFeedbackUpdate(BaseModel):
    feedback: Optional[str] = Field(None, pattern="^(helpful|unhelpful)?$")
