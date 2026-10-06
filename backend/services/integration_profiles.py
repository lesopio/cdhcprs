"""可切换的 LLM 与联网搜索配置组。"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from services.secret_settings import mask_secret
from services.settings import delete_settings, get_all_settings, get_setting, update_multiple_settings, update_setting


KINDS = ("llm", "web_search")


def _json_profiles(values: dict[str, str], kind: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(values.get(f"{kind}_profiles_json", "[]"))
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []


def _legacy_profile(values: dict[str, str], kind: str) -> dict[str, Any]:
    if kind == "llm":
        return {
            "id": "llm-default", "name": "LLM 1", "provider": values.get("llm_provider", "deepseek") or "deepseek",
            "base_url": values.get("llm_base_url", ""), "endpoint": "", "model": values.get("llm_model_id", "") or values.get("llm_model_name", ""),
            "enabled": True, "options": {},
        }
    return {
        "id": "web-default", "name": "DeepSeek", "provider": values.get("web_search_provider", "deepseek") or "deepseek",
        "base_url": values.get("web_search_base_url", ""), "endpoint": values.get("web_search_endpoint", ""), "model": values.get("web_search_model", "deepseek-v4-flash"),
        "enabled": values.get("web_search_enabled", "false") == "true",
        "options": {"search_depth": values.get("web_search_depth", "fast"), "max_results": int(values.get("web_search_max_results", "8") or 8), "timeout_seconds": int(values.get("web_search_timeout_seconds", "15") or 15)},
    }


def load_profiles(db: Session) -> dict[str, Any]:
    values = get_all_settings(db)
    result: dict[str, Any] = {}
    for kind in KINDS:
        profiles = _json_profiles(values, kind) or [_legacy_profile(values, kind)]
        for profile in profiles:
            secret = get_setting(db, f"{kind}_profile_api_key:{profile['id']}")
            if not secret:
                secret = values.get("llm_api_key" if kind == "llm" else "web_search_api_key", "") if profile["id"].endswith("default") else ""
            profile["api_key"] = mask_secret(secret)
            profile["api_key_configured"] = bool(secret)
        result[f"{kind}_profiles"] = profiles
        active = values.get(f"active_{kind}_profile_id", "")
        result[f"active_{kind}_id"] = active if any(p["id"] == active for p in profiles) else profiles[0]["id"]
    return result


def save_profiles(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    old = load_profiles(db)
    for kind in KINDS:
        profiles = payload[f"{kind}_profiles"]
        if not profiles:
            raise ValueError(f"{kind} 至少保留一个配置")
        ids = {profile["id"] for profile in profiles}
        old_ids = {profile["id"] for profile in old[f"{kind}_profiles"]}
        delete_settings(db, [f"{kind}_profile_api_key:{profile_id}" for profile_id in old_ids - ids])
        clean_profiles = []
        for profile in profiles:
            api_key = str(profile.pop("api_key", "") or "").strip()
            profile.pop("api_key_configured", None)
            if api_key and "•" not in api_key and "*" not in api_key:
                update_setting(db, f"{kind}_profile_api_key:{profile['id']}", api_key)
            elif not get_setting(db, f"{kind}_profile_api_key:{profile['id']}") and profile["id"].endswith("default"):
                legacy_key = get_setting(db, "llm_api_key" if kind == "llm" else "web_search_api_key") or ""
                if legacy_key:
                    update_setting(db, f"{kind}_profile_api_key:{profile['id']}", legacy_key)
            clean_profiles.append(profile)
        active_id = payload[f"active_{kind}_id"]
        if active_id not in ids:
            active_id = clean_profiles[0]["id"]
        update_multiple_settings(db, {f"{kind}_profiles_json": json.dumps(clean_profiles, ensure_ascii=False), f"active_{kind}_profile_id": active_id})

        active = next(profile for profile in clean_profiles if profile["id"] == active_id)
        active_key = get_setting(db, f"{kind}_profile_api_key:{active_id}") or ""
        if kind == "llm":
            update_multiple_settings(db, {
                "llm_provider": active["provider"], "llm_base_url": active.get("base_url", ""), "llm_model_id": active.get("model", ""),
                "llm_model_name": active.get("model", ""), "llm_api_key": active_key,
            })
        else:
            options = active.get("options") or {}
            update_multiple_settings(db, {
                "web_search_provider": active["provider"], "web_search_enabled": "true" if active.get("enabled", True) else "false",
                "web_search_base_url": active.get("base_url", ""), "web_search_endpoint": active.get("endpoint", ""), "web_search_model": active.get("model", ""),
                "web_search_api_key": active_key, "web_search_depth": str(options.get("search_depth", "fast")),
                "web_search_max_results": str(options.get("max_results", 8)), "web_search_timeout_seconds": str(options.get("timeout_seconds", 15)),
            })
    return load_profiles(db)
