"""
用户相关的 Pydantic Schemas
"""
from pydantic import BaseModel, Field
from datetime import datetime
from typing import Dict, Optional


class UserBase(BaseModel):
    """用户基础 Schema"""
    username: str = Field(..., min_length=3, max_length=50, description="用户名")


class UserCreate(UserBase):
    """用户创建 Schema"""
    password: str = Field(..., min_length=12, max_length=100, description="密码")


class UserLogin(BaseModel):
    """用户登录 Schema"""
    username: str = Field(..., description="用户名")
    password: str = Field(..., description="密码")


class UserUpdate(BaseModel):
    """用户更新 Schema"""
    password: Optional[str] = Field(None, min_length=12, max_length=100, description="新密码")
    is_banned: Optional[bool] = Field(None, description="是否封禁")
    # 每日配额单人 override：每项 -1=不限、null=跟随全局；整体传 null=清除 override（完全跟随全局）
    quota_override: Optional[Dict[str, Optional[int]]] = Field(
        None, description="每日配额 override，键限 tokens/images/web_searches，值 -1=不限、null=跟随全局"
    )


class UserResponse(UserBase):
    """用户响应 Schema"""
    id: int
    role: str
    is_banned: bool
    created_at: datetime
    # 每日配额：单人 override（null=无 override）、今日已用量、生效配额（null=不限）
    quota_override: Optional[Dict[str, Optional[int]]] = None
    today_usage: Optional[Dict[str, int]] = None
    effective_quota: Optional[Dict[str, Optional[int]]] = None

    class Config:
        from_attributes = True


class Token(BaseModel):
    """Token Schema"""
    access_token: str
    token_type: str = "bearer"


class TokenData(BaseModel):
    """Token 数据 Schema"""
    username: Optional[str] = None
