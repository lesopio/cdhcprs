"""Clinic login Turnstile verification. No secret is exposed by public_config."""
import os
from fastapi import HTTPException
import httpx


def configured():
    return bool(os.getenv("MULAO_TURNSTILE_SITE_KEY") or os.getenv("MULAO_TURNSTILE_SECRET_KEY"))


def public_config():
    return {"enabled": configured(), "siteKey": os.getenv("MULAO_TURNSTILE_SITE_KEY", "")}


def verify_login(token):
    """CF Turnstile 验证（login action）"""
    _verify(token, "login", "登录安全验证")


def verify_register(token):
    """CF Turnstile 验证（register action）"""
    _verify(token, "register", "注册安全验证")


def _verify(token, action: str, label: str):
    secret = os.getenv("MULAO_TURNSTILE_SECRET_KEY", "")
    hosts = {h.strip().lower() for h in os.getenv("MULAO_TURNSTILE_HOSTNAMES", "").split(",") if h.strip()}
    if not secret or not hosts or not os.getenv("MULAO_TURNSTILE_SITE_KEY"):
        raise HTTPException(503, f"{label}暂不可用，请稍后重试")
    if not isinstance(token, str) or not token or len(token) > 2048:
        raise HTTPException(400, "请先完成安全验证")
    try:
        response = httpx.post("https://challenges.cloudflare.com/turnstile/v0/siteverify",
                              data={"secret": secret, "response": token}, timeout=5.0)
        response.raise_for_status()
        result = response.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(503, f"{label}暂不可用，请稍后重试") from None
    if (result.get("success") is not True or result.get("hostname", "").lower() not in hosts
            or result.get("action") != action):
        raise HTTPException(400, "安全验证未通过或已过期，请重试")
