"""
对话数据模型
"""
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from core.database import Base


class Conversation(Base):
    """对话模型"""

    __tablename__ = "conversations"
    __table_args__ = {'sqlite_autoincrement': True}  # 确保SQLite使用AUTOINCREMENT，防止ID复用

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)  # 模型切换后变为 False
    patient_profile_id = Column(Integer, nullable=True)
    triage_json = Column(Text, nullable=True)
    consultation_mode = Column(String(20), nullable=False, default="free")
    # AI 主动问诊（intake）模式下，记录已问轮次、已收集症状、是否收齐等状态
    intake_state_json = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    
    # 关系
    # user = relationship("User", back_populates="conversations")
    # messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")
    
    def __repr__(self):
        return f"<Conversation(id={self.id}, user_id={self.user_id}, title='{self.title}', is_active={self.is_active})>"
