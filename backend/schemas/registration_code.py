"""
注册码相关的 Pydantic Schemas
"""
from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional


class RegistrationCodeCreate(BaseModel):
    """管理员创建注册码"""
    note: Optional[str] = Field(None, max_length=200, description="备注")


class RegistrationCodeBatchCreate(BaseModel):
    """管理员批量创建注册码"""
    count: int = Field(1, ge=1, le=50, description="生成数量（1-50）")
    note: Optional[str] = Field(None, max_length=200, description="备注")


class RegistrationCodeResponse(BaseModel):
    """注册码响应"""
    id: int
    code: str
    is_used: bool
    note: Optional[str] = None
    created_by: Optional[int] = None
    used_by: Optional[int] = None
    created_at: datetime
    used_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class RegisterWithCodeRequest(BaseModel):
    """用户使用注册码注册"""
    username: str = Field(..., min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_]+$",
                          description="用户名：3-32 位字母、数字或下划线")
    nickname: Optional[str] = Field(None, max_length=50, description="昵称（可选）")
    password: str = Field(..., min_length=12, max_length=100, description="密码：至少 12 位")
    confirm_password: str = Field(..., min_length=12, max_length=100, description="确认密码")
    registration_code: str = Field(..., min_length=1, max_length=50, description="注册码")
    captcha_token: Optional[str] = Field(None, description="CF Turnstile token")
