from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.sql import func

from core.database import Base


class Attachment(Base):
    __tablename__ = "attachments"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True, index=True)
    message_id = Column(Integer, nullable=True, index=True)
    patient_profile_id = Column(Integer, nullable=True, index=True)
    kind = Column(String(32), nullable=False, default="medical_image")
    mime_type = Column(String(64), nullable=False)
    original_name = Column(String(255), nullable=False)
    storage_path = Column(Text, nullable=False)
    analysis_path = Column(Text, nullable=True)
    size_bytes = Column(Integer, nullable=False)
    sha256 = Column(String(64), nullable=False, index=True)
    analysis_json = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
