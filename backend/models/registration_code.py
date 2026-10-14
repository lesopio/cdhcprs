"""
注册码数据模型
"""
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
from sqlalchemy.sql import func
from core.database import Base


class RegistrationCode(Base):
    """注册邀请码"""

    __tablename__ = "registration_codes"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    code = Column(String, unique=True, index=True, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    used_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    is_used = Column(Boolean, default=False, nullable=False)
    note = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)

    def __repr__(self):
        return f"<RegistrationCode(id={self.id}, code='{self.code}', used={self.is_used})>"
