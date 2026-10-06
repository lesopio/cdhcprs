"""模型多配置服务：CRUD、空分类种子迁移、启用同步（写回 system_settings 兼容层）。

密钥红线：
- api_key 仅以 Fernet 密文存于 model_configs.api_key_enc（复用 services/secret_settings.py）。
- 对外响应永不回显 api_key，仅返回 api_key_configured 布尔。
- 启用同步写回 system_settings 时经 update_multiple_settings（内部对密钥键自动加密）。
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models.model_config import ModelConfig
from schemas.model_config import ModelConfigResponse
from services.secret_settings import decrypt_secret, encrypt_secret
from services.settings import get_all_settings, update_multiple_settings

MODEL_CATEGORIES = ("llm", "search", "kb", "asr", "tts", "vl", "rerank")

# 各能力的「启用」设置键（llm 无 enabled 键，主模型恒可用，不写）
CATEGORY_ENABLED_KEY = {
    "search": "web_search_enabled",
    "kb": "knowledge_base_enabled",
    "asr": "asr_enabled",
    "tts": "tts_enabled",
    "vl": "vl_enabled",
    "rerank": "rerank_enabled",
}

# 各能力专属字段 → system_settings 键（extra_json 内）
CATEGORY_EXTRA_KEYS = {
    "kb": {"knowledge_base_top_k": "knowledge_base_top_k"},
    "asr": {"asr_language": "asr_language", "asr_max_seconds": "asr_max_seconds"},
    "tts": {"tts_voice": "tts_voice", "tts_response_format": "tts_response_format"},
    "vl": {"vl_system_prompt": "vl_system_prompt", "vl_max_images": "vl_max_images", "vl_max_image_mb": "vl_max_image_mb"},
    "rerank": {"rerank_top_n": "rerank_top_n"},
}


def is_valid_category(category: str) -> bool:
    return category in MODEL_CATEGORIES


def _parse_extra(raw: Optional[str]) -> Dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        return {}


def to_response(config: ModelConfig) -> ModelConfigResponse:
    return ModelConfigResponse(
        id=config.id,
        category=config.category,
        name=config.name,
        provider=config.provider or "",
        base_url=config.base_url or "",
        endpoint=config.endpoint or "",
        model_id=config.model_id or "",
        model_name=config.model_name or "",
        extra=_parse_extra(config.extra_json),
        enabled=bool(config.enabled),
        api_key_configured=bool(config.api_key_enc),
        created_at=config.created_at,
        updated_at=config.updated_at,
    )


def list_configs(db: Session, category: str) -> List[ModelConfig]:
    """按分类列出配置；分类为空时执行一次幂等种子（只在空时种）。"""
    seed_from_settings_if_empty(db, category)
    return list(
        db.execute(
            select(ModelConfig)
            .where(ModelConfig.category == category)
            .order_by(ModelConfig.enabled.desc(), ModelConfig.id.asc())
        ).scalars().all()
    )


def get_config(db: Session, config_id: int) -> Optional[ModelConfig]:
    return db.get(ModelConfig, config_id)


def create_config(
    db: Session,
    *,
    category: str,
    name: str,
    provider: str = "",
    base_url: str = "",
    endpoint: str = "",
    model_id: str = "",
    model_name: str = "",
    api_key: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> ModelConfig:
    config = ModelConfig(
        category=category,
        name=name.strip() or "未命名配置",
        provider=provider or "",
        base_url=base_url or "",
        endpoint=endpoint or "",
        model_id=model_id or "",
        model_name=model_name or "",
        api_key_enc=encrypt_secret(api_key.strip()) if api_key and api_key.strip() else "",
        extra_json=json.dumps(extra or {}, ensure_ascii=False),
        enabled=0,
    )
    db.add(config)
    db.commit()
    db.refresh(config)
    return config


def update_config(db: Session, config: ModelConfig, data: Dict[str, Any]) -> ModelConfig:
    """更新配置。api_key 传空串/缺省=不改，传新值=覆盖。"""
    for field in ("name", "provider", "base_url", "endpoint", "model_id", "model_name"):
        value = data.get(field)
        if value is not None:
            setattr(config, field, (value.strip() if isinstance(value, str) else value) or "")
    new_key = data.get("api_key")
    if new_key is not None and str(new_key).strip():
        config.api_key_enc = encrypt_secret(str(new_key).strip())
    if data.get("extra") is not None:
        config.extra_json = json.dumps(data["extra"] or {}, ensure_ascii=False)
    db.commit()
    db.refresh(config)
    return config


def delete_config(db: Session, config: ModelConfig) -> None:
    """删除配置；若删的是启用条，同步清掉 system_settings 的 enabled 键为 false。"""
    was_enabled = bool(config.enabled)
    category = config.category
    db.delete(config)
    db.commit()
    if was_enabled:
        enabled_key = CATEGORY_ENABLED_KEY.get(category)
        if enabled_key:
            update_multiple_settings(db, {enabled_key: "false"})


def enable_config(db: Session, config: ModelConfig) -> ModelConfig:
    """同类别单开：该条置启用、其余置停用，并把该条字段同步写回 system_settings 现有键（兼容层，运行时仍读旧键）。"""
    if not bool(config.enabled):
        db.query(ModelConfig).filter(ModelConfig.category == config.category).update({"enabled": 0})
        config.enabled = 1
        db.commit()
        db.refresh(config)
    sync_config_to_settings(db, config)
    return config


def sync_config_to_settings(db: Session, config: ModelConfig) -> None:
    """把配置字段映射写回 system_settings 现有键（密文经 update_multiple_settings 自动加密落库）。

    密钥键无条件写回：配置存了密钥写明文（由 update_multiple_settings 加密），
    未存密钥则写空串清掉上一条启用配置的残留密钥——否则运行时会读到
    「新配置 base_url/model + 旧配置 key」的错配组合，上游鉴权失败且难排查。
    """
    category = config.category
    extra = _parse_extra(config.extra_json)
    values: Dict[str, str] = {}

    if category == "llm":
        values["llm_provider"] = config.provider or ""
        values["llm_base_url"] = config.base_url or ""
        values["llm_model_id"] = config.model_id or ""
        values["llm_model_name"] = config.model_name or ""
        values["llm_api_key"] = decrypt_secret(config.api_key_enc)
    elif category == "search":
        values["web_search_base_url"] = config.base_url or ""
        values["web_search_model"] = config.model_id or str(extra.get("model") or "")
        values["web_search_api_key"] = decrypt_secret(config.api_key_enc)
    elif category == "kb":
        values["knowledge_base_url"] = config.base_url or ""
        values["knowledge_base_top_k"] = str(extra.get("knowledge_base_top_k", "5"))
        values["knowledge_base_api_key"] = decrypt_secret(config.api_key_enc)
    elif category == "asr":
        values["asr_base_url"] = config.base_url or ""
        values["asr_endpoint"] = config.endpoint or ""
        values["asr_model"] = config.model_id or ""
        values["asr_language"] = str(extra.get("asr_language", "zh"))
        values["asr_max_seconds"] = str(extra.get("asr_max_seconds", "60"))
        values["asr_api_key"] = decrypt_secret(config.api_key_enc)
    elif category == "tts":
        values["tts_base_url"] = config.base_url or ""
        values["tts_endpoint"] = config.endpoint or ""
        values["tts_model"] = config.model_id or ""
        values["tts_voice"] = str(extra.get("tts_voice", ""))
        values["tts_response_format"] = str(extra.get("tts_response_format", "mp3"))
        values["tts_api_key"] = decrypt_secret(config.api_key_enc)
    elif category == "vl":
        values["vl_base_url"] = config.base_url or ""
        values["vl_endpoint"] = config.endpoint or ""
        values["vl_model"] = config.model_id or ""
        values["vl_system_prompt"] = str(extra.get("vl_system_prompt", ""))
        values["vl_max_images"] = str(extra.get("vl_max_images", "4"))
        values["vl_max_image_mb"] = str(extra.get("vl_max_image_mb", "10"))
        values["vl_api_key"] = decrypt_secret(config.api_key_enc)
    elif category == "rerank":
        values["rerank_base_url"] = config.base_url or ""
        values["rerank_endpoint"] = config.endpoint or ""
        values["rerank_model"] = config.model_id or ""
        values["rerank_top_n"] = str(extra.get("rerank_top_n", "5"))
        values["rerank_api_key"] = decrypt_secret(config.api_key_enc)

    enabled_key = CATEGORY_ENABLED_KEY.get(category)
    if enabled_key:
        values[enabled_key] = "true"

    update_multiple_settings(db, values)


def seed_from_settings_if_empty(db: Session, category: str) -> None:
    """分类为空时，从 system_settings 现有键迁移生成一条「当前配置」（幂等：只在空时种）。"""
    existing = db.query(ModelConfig).filter(ModelConfig.category == category).count()
    if existing > 0:
        return

    values = get_all_settings(db)

    def setting(key: str, default: str = "") -> str:
        value = values.get(key)
        return default if value is None else str(value)

    name = "当前配置"
    api_key_plain = ""
    provider = ""
    base_url = ""
    endpoint = ""
    model_id = ""
    model_name = ""
    extra: Dict[str, Any] = {}
    enabled = True  # llm 主模型无 enabled 键，恒可用

    if category == "llm":
        provider = setting("llm_provider")
        base_url = setting("llm_base_url")
        api_key_plain = setting("llm_api_key")
        model_id = setting("llm_model_id")
        model_name = setting("llm_model_name")
    elif category == "search":
        provider = "responses"
        base_url = setting("web_search_base_url")
        api_key_plain = setting("web_search_api_key")
        enabled = setting("web_search_enabled", "false") == "true"
    elif category == "kb":
        provider = "custom"
        base_url = setting("knowledge_base_url")
        api_key_plain = setting("knowledge_base_api_key")
        extra = {"knowledge_base_top_k": setting("knowledge_base_top_k", "5")}
        enabled = setting("knowledge_base_enabled", "false") == "true"
    elif category == "asr":
        provider = "openai"
        base_url = setting("asr_base_url")
        endpoint = setting("asr_endpoint", "/v1/audio/transcriptions")
        api_key_plain = setting("asr_api_key")
        model_id = setting("asr_model")
        extra = {"asr_language": setting("asr_language", "zh"), "asr_max_seconds": setting("asr_max_seconds", "60")}
        enabled = setting("asr_enabled", "false") == "true"
    elif category == "tts":
        provider = "openai"
        base_url = setting("tts_base_url")
        endpoint = setting("tts_endpoint", "/v1/audio/speech")
        api_key_plain = setting("tts_api_key")
        model_id = setting("tts_model")
        extra = {"tts_voice": setting("tts_voice"), "tts_response_format": setting("tts_response_format", "mp3")}
        enabled = setting("tts_enabled", "false") == "true"
    elif category == "vl":
        provider = "openai"
        base_url = setting("vl_base_url")
        endpoint = setting("vl_endpoint", "/v1/responses")
        api_key_plain = setting("vl_api_key")
        model_id = setting("vl_model")
        extra = {
            "vl_system_prompt": setting("vl_system_prompt"),
            "vl_max_images": setting("vl_max_images", "4"),
            "vl_max_image_mb": setting("vl_max_image_mb", "10"),
        }
        enabled = setting("vl_enabled", "false") == "true"
    elif category == "rerank":
        provider = "openai"
        base_url = setting("rerank_base_url")
        endpoint = setting("rerank_endpoint", "/v1/rerank")
        api_key_plain = setting("rerank_api_key")
        model_id = setting("rerank_model")
        extra = {"rerank_top_n": setting("rerank_top_n", "5")}
        enabled = setting("rerank_enabled", "false") == "true"

    config = ModelConfig(
        category=category,
        name=name,
        provider=provider,
        base_url=base_url,
        endpoint=endpoint,
        api_key_enc=encrypt_secret(api_key_plain) if api_key_plain else "",
        model_id=model_id,
        model_name=model_name,
        extra_json=json.dumps(extra, ensure_ascii=False),
        enabled=1 if enabled else 0,
    )
    db.add(config)
    db.commit()


def get_enabled_llm_config(db: Session) -> Optional[Dict[str, Any]]:
    """只读：返回启用中的 llm 配置字段（api_key 已解密）；无启用条目时返回 None。

    供管理端测试端点「借用当前启用 LLM 的 API Key」使用：不做任何写操作、
    不触碰 enable 映射；解密 key 仅在服务端内存中短暂使用，不写入日志与响应。
    """
    config = db.execute(
        select(ModelConfig)
        .where(ModelConfig.category == "llm", ModelConfig.enabled == 1)
        .order_by(ModelConfig.id.asc())
    ).scalars().first()
    if not config:
        return None
    return {
        "id": config.id,
        "name": config.name,
        "provider": config.provider or "",
        "base_url": config.base_url or "",
        "endpoint": config.endpoint or "",
        "model_id": config.model_id or "",
        "model_name": config.model_name or "",
        "api_key": decrypt_secret(config.api_key_enc),
    }
