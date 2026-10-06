"""系统设置 API Schema。"""
from typing import Any, List, Optional

from pydantic import BaseModel, Field, model_validator


class SystemSettingBase(BaseModel):
    key: str
    value: str


class SystemSettingResponse(SystemSettingBase):
    class Config:
        from_attributes = True


class PublicSettings(BaseModel):
    website_name: str
    website_logo: str
    large_font_scale: float = 1.5
    extra_large_font_scale: float = 1.85
    asr_available: bool = False
    tts_available: bool = False
    vl_available: bool = False
    asr_max_seconds: int = 60
    vl_max_images: int = 4
    vl_max_image_mb: int = 10


class AdminSettings(BaseModel):
    website_name: str = ""
    website_logo: str = ""
    system_prompt: str = ""
    llm_provider: str = ""
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_api_key_configured: bool = False
    llm_model_id: str = ""
    llm_model_name: str = ""
    large_font_scale: float = 1.5
    suggested_questions_enabled: str = "false"
    suggested_questions_provider: str = ""
    suggested_questions_base_url: str = ""
    suggested_questions_api_key: str = ""
    suggested_questions_model_id: str = ""
    suggested_questions_system_prompt: str = ""
    suggested_questions_count: str = "3"
    suggested_questions_max_rounds: str = "5"
    suggested_questions_template_questions: str = "[]"
    web_search_enabled: str = "false"
    web_search_base_url: str = ""
    web_search_api_key: str = ""
    web_search_api_key_configured: bool = False
    knowledge_base_enabled: str = "false"
    knowledge_base_url: str = ""
    knowledge_base_api_key: str = ""
    knowledge_base_api_key_configured: bool = False
    knowledge_base_top_k: str = "5"


    extra_large_font_scale: float = 1.85
    asr_enabled: str = "false"
    asr_base_url: str = ""
    asr_endpoint: str = "/v1/audio/transcriptions"
    asr_api_key: str = ""
    asr_api_key_configured: bool = False
    asr_model: str = ""
    asr_language: str = "zh"
    asr_max_seconds: str = "60"
    tts_enabled: str = "false"
    tts_base_url: str = ""
    tts_endpoint: str = "/v1/audio/speech"
    tts_api_key: str = ""
    tts_api_key_configured: bool = False
    tts_model: str = ""
    tts_voice: str = ""
    tts_response_format: str = "mp3"
    vl_enabled: str = "false"
    vl_base_url: str = ""
    vl_endpoint: str = "/v1/responses"
    vl_api_key: str = ""
    vl_api_key_configured: bool = False
    vl_model: str = ""
    vl_system_prompt: str = ""
    vl_max_images: str = "4"
    vl_max_image_mb: str = "10"
    rerank_enabled: str = "false"
    rerank_base_url: str = ""
    rerank_endpoint: str = "/v1/rerank"
    rerank_api_key: str = ""
    rerank_api_key_configured: bool = False
    rerank_model: str = ""
    rerank_top_n: str = "5"
    medical_storage_root: str = ""


class AdminSettingsUpdate(BaseModel):
    website_name: Optional[str] = None
    website_logo: Optional[str] = None
    system_prompt: Optional[str] = None
    llm_provider: Optional[str] = None
    llm_base_url: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_model_id: Optional[str] = None
    llm_model_name: Optional[str] = None
    large_font_scale: Optional[float] = None
    extra_large_font_scale: Optional[float] = None
    asr_enabled: Optional[str] = None
    asr_base_url: Optional[str] = None
    asr_endpoint: Optional[str] = None
    asr_api_key: Optional[str] = None
    asr_model: Optional[str] = None
    asr_language: Optional[str] = None
    asr_max_seconds: Optional[str] = None
    tts_enabled: Optional[str] = None
    tts_base_url: Optional[str] = None
    tts_endpoint: Optional[str] = None
    tts_api_key: Optional[str] = None
    tts_model: Optional[str] = None
    tts_voice: Optional[str] = None
    tts_response_format: Optional[str] = None
    vl_enabled: Optional[str] = None
    vl_base_url: Optional[str] = None
    vl_endpoint: Optional[str] = None
    vl_api_key: Optional[str] = None
    vl_model: Optional[str] = None
    vl_system_prompt: Optional[str] = None
    vl_max_images: Optional[str] = None
    vl_max_image_mb: Optional[str] = None
    rerank_enabled: Optional[str] = None
    rerank_base_url: Optional[str] = None
    rerank_endpoint: Optional[str] = None
    rerank_api_key: Optional[str] = None
    rerank_model: Optional[str] = None
    rerank_top_n: Optional[str] = None
    medical_storage_root: Optional[str] = None
    suggested_questions_enabled: Optional[str] = None
    suggested_questions_provider: Optional[str] = None
    suggested_questions_base_url: Optional[str] = None
    suggested_questions_api_key: Optional[str] = None
    suggested_questions_model_id: Optional[str] = None
    suggested_questions_system_prompt: Optional[str] = None
    suggested_questions_count: Optional[str] = None
    suggested_questions_max_rounds: Optional[str] = None
    suggested_questions_template_questions: Optional[str] = None
    web_search_enabled: Optional[str] = None
    web_search_base_url: Optional[str] = None
    web_search_api_key: Optional[str] = None
    knowledge_base_enabled: Optional[str] = None
    knowledge_base_url: Optional[str] = None
    knowledge_base_api_key: Optional[str] = None
    knowledge_base_top_k: Optional[str] = None


class TestConnectionRequest(BaseModel):
    llm_provider: str
    llm_api_key: str = ""
    llm_model_id: Optional[str] = None
    llm_model_name: Optional[str] = None
    llm_base_url: Optional[str] = None
    profile_id: str = ""
    # 模型多配置表单测试连接：密钥回退顺序 = 重输明文 → 该配置存的密钥 → 全局键
    config_id: Optional[int] = None

    @model_validator(mode="after")
    def validate_identifier(self):
        if not (self.llm_model_id or self.llm_model_name):
            raise ValueError("llm_model_id 或 llm_model_name 至少填写一个")
        return self


class TestConnectionResponse(BaseModel):
    success: bool
    message: str


class IntegrationTestRequest(BaseModel):
    base_url: str
    api_key: Optional[str] = None
    top_k: int = Field(default=5, ge=1, le=20)
    endpoint: str = ""
    model: str = ""
    provider: str = "deepseek"
    options: dict[str, Any] = Field(default_factory=dict)
    profile_id: str = ""
    # 模型多配置表单测试连接：密钥回退顺序 = 重输明文 → 该配置存的密钥 → 全局键
    config_id: Optional[int] = None


class IntegrationProfile(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=80)
    provider: str = Field(min_length=1, max_length=40)
    base_url: str = ""
    endpoint: str = ""
    model: str = ""
    enabled: bool = True
    options: dict[str, Any] = Field(default_factory=dict)
    api_key: str = ""
    api_key_configured: bool = False


class IntegrationProfilesPayload(BaseModel):
    llm_profiles: list[IntegrationProfile]
    web_search_profiles: list[IntegrationProfile]
    active_llm_id: str
    active_web_search_id: str


class ModelOption(BaseModel):
    id: str
    name: Optional[str] = None
    owned_by: Optional[str] = None


class ModelListResponse(BaseModel):
    models: List[ModelOption]


class ModelListRequest(BaseModel):
    llm_provider: str
    llm_api_key: str
    llm_base_url: Optional[str] = None


class LogoUploadResponse(BaseModel):
    logo_url: str
