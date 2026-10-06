"""模型多配置 API Schema。"""
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

ModelCategory = Literal["llm", "search", "kb", "asr", "tts", "vl", "rerank"]


class ModelConfigCreate(BaseModel):
    """新增配置：name + category 必填；api_key 若传则加密入库，不回显。"""

    name: str = Field(min_length=1, max_length=100)
    category: ModelCategory
    provider: str = ""
    base_url: str = ""
    endpoint: str = ""
    model_id: str = ""
    model_name: str = ""
    api_key: Optional[str] = None
    extra: Dict[str, Any] = Field(default_factory=dict)


class ModelConfigUpdate(BaseModel):
    """更新配置：api_key 传空串/缺省=不改，传新值=覆盖。"""

    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    provider: Optional[str] = None
    base_url: Optional[str] = None
    endpoint: Optional[str] = None
    model_id: Optional[str] = None
    model_name: Optional[str] = None
    api_key: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None


class ModelConfigResponse(BaseModel):
    """配置响应：api_key 永不回显，仅返回 api_key_configured 布尔。"""

    id: int
    category: str
    name: str
    provider: str
    base_url: str
    endpoint: str
    model_id: str
    model_name: str
    extra: Dict[str, Any] = Field(default_factory=dict)
    enabled: bool
    api_key_configured: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ModelConfigListResponse(BaseModel):
    items: List[ModelConfigResponse]
