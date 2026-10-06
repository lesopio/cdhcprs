"""系统设置中的敏感字段加密与掩码处理。"""
from __future__ import annotations

import base64
import hashlib
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from core.config import get_settings


SECRET_SETTING_KEYS = {
    "llm_api_key",
    "suggested_questions_api_key",
    "web_search_api_key",
    "knowledge_base_api_key",
    "asr_api_key",
    "tts_api_key",
    "vl_api_key",
    "rerank_api_key",
}
SECRET_SETTING_PREFIXES = ("llm_profile_api_key:", "web_search_profile_api_key:")
PREFIX = "enc:v1:"


def is_secret_setting_key(key: str) -> bool:
    return key in SECRET_SETTING_KEYS or key.startswith(SECRET_SETTING_PREFIXES)


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    settings = get_settings()
    seed = settings.SETTINGS_ENCRYPTION_KEY or settings.SECRET_KEY
    key = base64.urlsafe_b64encode(hashlib.sha256(seed.encode("utf-8")).digest())
    return Fernet(key)


def encrypt_secret(value: str) -> str:
    if not value or value.startswith(PREFIX):
        return value
    token = _fernet().encrypt(value.encode("utf-8")).decode("ascii")
    return f"{PREFIX}{token}"


def decrypt_secret(value: str | None) -> str:
    if not value:
        return ""
    if not value.startswith(PREFIX):
        return value
    try:
        return _fernet().decrypt(value[len(PREFIX):].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""


def mask_secret(value: str | None) -> str:
    plain = decrypt_secret(value)
    if not plain:
        return ""
    if len(plain) < 8:
        return "••••••••"
    return f"{plain[:3]}••••{plain[-4:]}"
