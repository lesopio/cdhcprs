"""
对话相关的 Pydantic Schemas
"""
from pydantic import BaseModel, Field
from datetime import datetime
from typing import Any, Optional


class ConversationBase(BaseModel):
    """对话基础 Schema"""
    title: str = Field(..., min_length=1, max_length=200, description="对话标题")


class ConversationCreate(ConversationBase):
    """对话创建 Schema"""
    patient_profile_id: Optional[int] = Field(None, description="关联患者档案 ID")
    triage: Optional[dict[str, Any]] = Field(None, description="分诊结果")


    consultation_mode: str = Field("free", pattern="^(free|guided|intake|senior)$")


class ConversationUpdate(BaseModel):
    """对话更新 Schema"""
    title: Optional[str] = Field(None, min_length=1, max_length=200, description="对话标题")
    is_active: Optional[bool] = Field(None, description="是否激活")
    patient_profile_id: Optional[int] = Field(None, description="关联患者档案 ID")
    triage: Optional[dict[str, Any]] = Field(None, description="分诊结果")


class ConversationResponse(ConversationBase):
    """对话响应 Schema"""
    id: int
    user_id: int
    is_active: bool
    created_at: datetime
    updated_at: Optional[datetime] = None
    patient_profile_id: Optional[int] = None
    triage_json: Optional[str] = None

    consultation_mode: str = "free"
    intake_state_json: Optional[str] = None

    class Config:
        from_attributes = True
