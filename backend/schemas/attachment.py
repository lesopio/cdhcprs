from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class AttachmentResponse(BaseModel):
    id: int
    conversation_id: int
    message_id: Optional[int] = None
    patient_profile_id: Optional[int] = None
    mime_type: str
    original_name: str
    size_bytes: int
    analysis_json: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True

