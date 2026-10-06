"""模型多配置数据模型：每个能力（llm/search/kb/asr/tts/vl/rerank）可存多条配置，同类别仅一条启用。"""
from sqlalchemy import Column, DateTime, Integer, String, Text
from sqlalchemy.sql import func

from core.database import Base


class ModelConfig(Base):
    """模型配置模型"""

    __tablename__ = "model_configs"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    # 能力分类：llm / search / kb / asr / tts / vl / rerank
    category = Column(String(20), nullable=False, index=True)
    # 用户可读的配置名，如「DeepSeek 主力」
    name = Column(String(100), nullable=False)
    provider = Column(String(40), nullable=False, default="")
    base_url = Column(Text, nullable=False, default="")
    endpoint = Column(String(200), nullable=False, default="")
    # Fernet 加密后的 API Key（密文，复用 services/secret_settings.py），永不回显明文
    api_key_enc = Column(Text, nullable=False, default="")
    model_id = Column(String(200), nullable=False, default="")
    model_name = Column(String(200), nullable=False, default="")
    # 各能力专属字段 JSON（asr_language/tts_voice/vl_max_images/knowledge_base_top_k/rerank_top_n 等）
    extra_json = Column(Text, nullable=False, default="{}")
    # INTEGER 布尔：同类别只允许一条为 1
    enabled = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    def __repr__(self):
        return f"<ModelConfig(id={self.id}, category='{self.category}', name='{self.name}')>"
