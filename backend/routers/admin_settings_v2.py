"""安全的管理员集成设置接口。"""
from __future__ import annotations

from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.database import get_db
from schemas.settings import AdminSettings, AdminSettingsUpdate, IntegrationProfilesPayload, IntegrationTestRequest, TestConnectionRequest, TestConnectionResponse
from services.admin import update_system_settings_with_model_check
from services.agent_pipeline import complete_llm, search_knowledge_base, search_web
from services.auth import get_current_admin_user
from services.llm import test_llm_connection
from services.model_configs import get_config as get_model_config
from services.model_configs import get_enabled_llm_config
from services.secret_settings import decrypt_secret, mask_secret
from services.integrations import auth_headers, integration_url
from services.integrations import test_asr_service, test_tts_service, test_vl_service, test_rerank_service, test_storage_root
from services.integration_profiles import load_profiles, save_profiles
from services.settings import get_all_settings, get_setting


router = APIRouter(prefix="/api/admin", tags=["管理员设置"])
SECRET_FIELDS = {"llm_api_key", "suggested_questions_api_key", "web_search_api_key", "knowledge_base_api_key", "asr_api_key", "tts_api_key", "vl_api_key", "rerank_api_key"}


class BorrowKeyLLMTestRequest(TestConnectionRequest):
    """test-connection 请求体：加「借用当前启用 LLM 密钥」开关（schemas/settings.py 保持不动）。"""
    borrow_llm_key: bool = False


class BorrowKeyIntegrationTestRequest(IntegrationTestRequest):
    """search/kb/asr/tts/vl/rerank 测试请求体：加「借用当前启用 LLM 密钥」开关。"""
    borrow_llm_key: bool = False


class EmbeddingsTestRequest(BaseModel):
    """test-embeddings 请求体：OpenAI 兼容 /embeddings 连通性测试。"""
    base_url: str
    api_key: Optional[str] = None
    model: str = ""
    borrow_llm_key: bool = False


class AdminSettingsV2(AdminSettings):
    """管理设置响应 + 登录滑块验证码开关。

    为什么不动 schemas/settings.py：字段被多路由共用，路由侧本地子类扩展
    单字段即可（同本文件 BorrowKey* 先例），避免影响其他正在并行的改动。
    """
    captcha_enabled: str = "false"


class AdminSettingsUpdateV2(AdminSettingsUpdate):
    """更新白名单 + captcha_enabled：仅此一个新增字段。"""
    captcha_enabled: Optional[str] = None


def _config_api_key(db: Session, config_id: Optional[int]) -> str:
    """读取指定模型多配置存的密钥（解密）；未指定/不存在/未存密钥返回空串。

    测试连接的密钥回退顺序：重输明文 → 该配置 api_key_enc 解密 → 全局 system_settings 键。
    """
    if not config_id:
        return ""
    config = get_model_config(db, config_id)
    return decrypt_secret(config.api_key_enc) if config else ""


def _borrow_llm_key_or_400(db: Session) -> str:
    """「用 LLM Key 测」：借用当前启用 LLM 配置的解密密钥；借不到时 400。

    解密密钥仅在服务端内存中用于本次测试请求，不写入日志与任何响应。
    """
    config = get_enabled_llm_config(db)
    if not config:
        raise HTTPException(400, "当前无启用的 LLM 配置，无法借用密钥")
    if not config.get("api_key"):
        raise HTTPException(400, "当前启用的 LLM 配置未存储 API 密钥，无法借用密钥")
    return config["api_key"]


@router.get("/integration-profiles")
def get_integration_profiles(current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    return load_profiles(db)


@router.put("/integration-profiles")
def put_integration_profiles(data: IntegrationProfilesPayload, current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    try:
        return save_profiles(db, data.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def settings_response(values: dict) -> AdminSettingsV2:
    llm_key = values.get("llm_api_key", "")
    web_key = values.get("web_search_api_key", "")
    kb_key = values.get("knowledge_base_api_key", "")
    suggested_key = values.get("suggested_questions_api_key", "")
    asr_key = values.get("asr_api_key", "")
    tts_key = values.get("tts_api_key", "")
    vl_key = values.get("vl_api_key", "")
    rerank_key = values.get("rerank_api_key", "")
    return AdminSettingsV2(
        website_name=values.get("website_name", ""), website_logo=values.get("website_logo", ""),
        system_prompt=values.get("system_prompt", ""), llm_provider=values.get("llm_provider", ""),
        llm_base_url=values.get("llm_base_url", ""), llm_api_key=mask_secret(llm_key),
        llm_api_key_configured=bool(llm_key), llm_model_id=values.get("llm_model_id", ""),
        llm_model_name=values.get("llm_model_name", ""), large_font_scale=float(values.get("large_font_scale", "1.5")),
        suggested_questions_enabled=values.get("suggested_questions_enabled", "false"),
        suggested_questions_provider=values.get("suggested_questions_provider", ""),
        suggested_questions_base_url=values.get("suggested_questions_base_url", ""),
        suggested_questions_api_key=mask_secret(suggested_key),
        suggested_questions_model_id=values.get("suggested_questions_model_id", ""),
        suggested_questions_system_prompt=values.get("suggested_questions_system_prompt", ""),
        suggested_questions_count=values.get("suggested_questions_count", "3"),
        suggested_questions_max_rounds=values.get("suggested_questions_max_rounds", "5"),
        suggested_questions_template_questions=values.get("suggested_questions_template_questions", "[]"),
        web_search_enabled=values.get("web_search_enabled", "false"),
        web_search_base_url=values.get("web_search_base_url", ""), web_search_api_key=mask_secret(web_key),
        web_search_api_key_configured=bool(web_key), knowledge_base_enabled=values.get("knowledge_base_enabled", "false"),
        knowledge_base_url=values.get("knowledge_base_url", ""), knowledge_base_api_key=mask_secret(kb_key),
        knowledge_base_api_key_configured=bool(kb_key), knowledge_base_top_k=values.get("knowledge_base_top_k", "5"),
        extra_large_font_scale=float(values.get("extra_large_font_scale", "1.85")),
        asr_enabled=values.get("asr_enabled", "false"), asr_base_url=values.get("asr_base_url", ""), asr_endpoint=values.get("asr_endpoint", "/v1/audio/transcriptions"), asr_api_key=mask_secret(asr_key), asr_api_key_configured=bool(asr_key), asr_model=values.get("asr_model", ""), asr_language=values.get("asr_language", "zh"), asr_max_seconds=values.get("asr_max_seconds", "60"),
        tts_enabled=values.get("tts_enabled", "false"), tts_base_url=values.get("tts_base_url", ""), tts_endpoint=values.get("tts_endpoint", "/v1/audio/speech"), tts_api_key=mask_secret(tts_key), tts_api_key_configured=bool(tts_key), tts_model=values.get("tts_model", ""), tts_voice=values.get("tts_voice", ""), tts_response_format=values.get("tts_response_format", "mp3"),
        vl_enabled=values.get("vl_enabled", "false"), vl_base_url=values.get("vl_base_url", ""), vl_endpoint=values.get("vl_endpoint", "/v1/responses"), vl_api_key=mask_secret(vl_key), vl_api_key_configured=bool(vl_key), vl_model=values.get("vl_model", ""), vl_system_prompt=values.get("vl_system_prompt", ""), vl_max_images=values.get("vl_max_images", "4"), vl_max_image_mb=values.get("vl_max_image_mb", "10"),
        rerank_enabled=values.get("rerank_enabled", "false"), rerank_base_url=values.get("rerank_base_url", ""), rerank_endpoint=values.get("rerank_endpoint", "/v1/rerank"), rerank_api_key=mask_secret(rerank_key), rerank_api_key_configured=bool(rerank_key), rerank_model=values.get("rerank_model", ""), rerank_top_n=values.get("rerank_top_n", "5"), medical_storage_root=values.get("medical_storage_root", ""),
        captcha_enabled=values.get("captcha_enabled", "false"),
    )


@router.get("/settings", response_model=AdminSettingsV2)
def get_settings_v2(current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    return settings_response(get_all_settings(db))


@router.put("/settings", response_model=AdminSettingsV2)
def update_settings_v2(data: AdminSettingsUpdateV2, current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    values = data.model_dump(exclude_none=True)
    for field in SECRET_FIELDS:
        value = values.get(field)
        if value is not None and (not value.strip() or "•" in value or "*" in value):
            values.pop(field, None)
    for numeric_scale in ("large_font_scale", "extra_large_font_scale"):
        if numeric_scale in values:
            values[numeric_scale] = str(values[numeric_scale])
    update_system_settings_with_model_check(db, values)
    return settings_response(get_all_settings(db))


@router.post("/settings/test-connection", response_model=TestConnectionResponse)
async def test_main_llm(data: BorrowKeyLLMTestRequest, current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    submitted = data.llm_api_key.strip()
    if "•" in submitted or "*" in submitted:
        submitted = ""
    if data.borrow_llm_key and not submitted:
        submitted = _borrow_llm_key_or_400(db)
    key = submitted or _config_api_key(db, data.config_id) or (get_setting(db, f"llm_profile_api_key:{data.profile_id}") if data.profile_id else "") or (get_setting(db, "llm_api_key") or "")
    if data.llm_provider == "responses":
        try:
            await complete_llm({"provider": "responses", "api_key": key, "model": data.llm_model_id or data.llm_model_name or "deepseek-v4-flash", "base_url": data.llm_base_url}, "只返回正常", "连接测试", 20)
            return TestConnectionResponse(success=True, message="连接成功，Responses API 响应正常")
        except Exception as exc:
            return TestConnectionResponse(success=False, message=f"连接失败：{str(exc)[:180]}")
    success, message = await test_llm_connection(data.llm_provider, key, data.llm_model_id or data.llm_model_name or "", data.llm_base_url)
    return TestConnectionResponse(success=success, message=message)


@router.post("/settings/test-web-search", response_model=TestConnectionResponse)
async def test_web_search(data: BorrowKeyIntegrationTestRequest, current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    submitted = (data.api_key or "").strip()
    if "•" in submitted or "*" in submitted:
        submitted = ""
    if data.borrow_llm_key and not submitted:
        submitted = _borrow_llm_key_or_400(db)
    key = submitted or _config_api_key(db, data.config_id) or (get_setting(db, f"web_search_profile_api_key:{data.profile_id}") if data.profile_id else "") or (get_setting(db, "web_search_api_key") or "")
    if not key:
        return TestConnectionResponse(success=False, message="请填写 API Key")
    # 测试模型口径与运行时一致（chat_v2 读 web_search_model）：表单重传模型 → options 模型 → 已保存的 web_search_model
    model = data.model or str(data.options.get("model") or "") or (get_setting(db, "web_search_model") or "")
    try:
        summary, sources = await search_web(data.provider, data.base_url, key, ["高血压诊疗指南 最新进展"], {**data.options, "model": model})
        return TestConnectionResponse(success=True, message=f"连接成功，网络搜索返回 {len(sources)} 个来源、{len(summary)} 字摘要")
    except Exception as exc:
        return TestConnectionResponse(success=False, message=f"连接失败：{str(exc)[:180]}")


@router.post("/settings/test-knowledge-base", response_model=TestConnectionResponse)
async def test_knowledge(data: BorrowKeyIntegrationTestRequest, current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    submitted = (data.api_key or "").strip()
    if "•" in submitted or "*" in submitted:
        submitted = ""
    if data.borrow_llm_key and not submitted:
        submitted = _borrow_llm_key_or_400(db)
    key = submitted or _config_api_key(db, data.config_id) or (get_setting(db, "knowledge_base_api_key") or "")
    try:
        items = await search_knowledge_base(data.base_url, key, "高血压 慢病诊疗", data.top_k)
        return TestConnectionResponse(success=True, message=f"连接成功，命中 {len(items)} 条知识库资料")
    except Exception as exc:
        return TestConnectionResponse(success=False, message=f"连接失败：{str(exc)[:180]}")


async def _test_integration(kind: str, data: BorrowKeyIntegrationTestRequest, db: Session) -> TestConnectionResponse:
    values = get_all_settings(db)
    submitted = (data.api_key or "").strip()
    if "•" in submitted or "*" in submitted:
        submitted = ""
    if data.borrow_llm_key and not submitted:
        submitted = _borrow_llm_key_or_400(db)
    key = submitted or _config_api_key(db, data.config_id) or (get_setting(db, f"{kind}_api_key") or "")
    base_url = data.base_url or values.get(f"{kind}_base_url", "")
    endpoint = data.endpoint or values.get(f"{kind}_endpoint", "")
    model = data.model or values.get(f"{kind}_model", "")
    try:
        if kind == "asr":
            message = await test_asr_service(base_url, endpoint, key, model)
        elif kind == "tts":
            message = await test_tts_service(base_url, endpoint, key, model, values.get("tts_voice", ""))
        elif kind == "vl":
            message = await test_vl_service(base_url, endpoint, key, model)
        else:
            message = await test_rerank_service(base_url, endpoint, key, model)
        return TestConnectionResponse(success=True, message=message)
    except Exception as exc:
        return TestConnectionResponse(success=False, message=f"连接失败：{str(exc)[:180]}")


@router.post("/settings/test-asr", response_model=TestConnectionResponse)
async def test_asr(data: BorrowKeyIntegrationTestRequest, current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    return await _test_integration("asr", data, db)


@router.post("/settings/test-tts", response_model=TestConnectionResponse)
async def test_tts(data: BorrowKeyIntegrationTestRequest, current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    return await _test_integration("tts", data, db)


@router.post("/settings/test-vl", response_model=TestConnectionResponse)
async def test_vl(data: BorrowKeyIntegrationTestRequest, current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    return await _test_integration("vl", data, db)


@router.post("/settings/test-rerank", response_model=TestConnectionResponse)
async def test_rerank(data: BorrowKeyIntegrationTestRequest, current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    return await _test_integration("rerank", data, db)


@router.post("/settings/test-embeddings", response_model=TestConnectionResponse)
async def test_embeddings(data: EmbeddingsTestRequest, current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    """OpenAI 兼容向量化连通性测试：POST {base}/embeddings，2xx 且 data[0].embedding 为非空数组即成功。"""
    submitted = (data.api_key or "").strip()
    if "•" in submitted or "*" in submitted:
        submitted = ""
    if data.borrow_llm_key and not submitted:
        submitted = _borrow_llm_key_or_400(db)
    if not data.model.strip():
        return TestConnectionResponse(success=False, message="请填写向量化模型名")
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(
                integration_url(data.base_url, "embeddings"),
                headers=auth_headers(submitted),
                json={"model": data.model.strip(), "input": ["橘泉智养连接测试"]},
            )
            response.raise_for_status()
            payload = response.json()
        items = payload.get("data") if isinstance(payload, dict) else None
        embedding = items[0].get("embedding") if items and isinstance(items[0], dict) else None
        if not isinstance(embedding, list) or not embedding:
            raise RuntimeError("Embeddings 接口未返回向量")
        return TestConnectionResponse(success=True, message=f"Embeddings 连接成功，向量维度 {len(embedding)}")
    except Exception as exc:
        return TestConnectionResponse(success=False, message=f"连接失败：{str(exc)[:180]}")


@router.post("/settings/test-storage", response_model=TestConnectionResponse)
async def test_storage(data: IntegrationTestRequest, current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    try:
        message = test_storage_root(data.base_url or get_setting(db, "medical_storage_root") or "")
        return TestConnectionResponse(success=True, message=message)
    except Exception as exc:
        return TestConnectionResponse(success=False, message=f"存储目录不可用：{str(exc)[:180]}")
