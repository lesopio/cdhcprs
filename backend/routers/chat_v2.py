"""结构化 SSE 聊天 API。"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from core.database import get_db
from models.message import Message
from models.attachment import Attachment
from schemas.conversation import ConversationCreate, ConversationResponse, ConversationUpdate
from schemas.message import MessageCreate, MessageFeedbackUpdate, MessageResponse
from services.agent_pipeline import (
    stream_evidence_summary,
    build_evidence_summary,
    citation_dicts,
    complete_llm,
    elapsed_ms,
    generate_intake_turn,
    generate_search_queries,
    search_web,
    search_knowledge_base,
    stream_final_answer,
)
from services.auth import get_current_user
from services.chat import (
    create_conversation,
    create_message,
    delete_conversation,
    get_conversation_by_id,
    get_conversation_messages,
    get_user_conversations,
    update_conversation_title,
)
from services.llm import generate_suggested_questions
from services.usage import add_usage, ensure_quota
from services.integrations import analyze_images, rerank_documents
from services.patient_profile import format_profile_for_prompt, get_family_members, get_profile_summary
from services.settings import get_setting
from routers.external_kb import load_external_kb_config, search_external_kb
from services.web_mirror import search_mirror, upsert_mirror_items


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chat", tags=["对话"])


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def llm_config(db: Session) -> dict:
    api_key = (get_setting(db, "llm_api_key") or "").strip()
    model = (get_setting(db, "llm_model_id") or get_setting(db, "llm_model_name") or "").strip()
    if not api_key or not model:
        raise HTTPException(status_code=503, detail="主回答模型尚未配置，请联系管理员。")
    return {
        "provider": get_setting(db, "llm_provider") or "deepseek",
        "api_key": api_key,
        "model": model,
        "base_url": (get_setting(db, "llm_base_url") or "").strip() or None,
    }


def resolved_web_search_key(db: Session, config: dict) -> str:
    """网络搜索密钥解析：专用 key → 当前激活搜索 profile 的 key → 主 LLM key。
    管理台保存设置时可能把 web_search_api_key 清空（profile 密钥另存），运行期兜底。"""
    key = (get_setting(db, "web_search_api_key") or "").strip()
    if not key:
        active = (get_setting(db, "active_web_search_profile_id") or "").strip()
        if active:
            key = (get_setting(db, f"web_search_profile_api_key:{active}") or "").strip()
    return key or (config.get("api_key") or "").strip()


def resolved_integration_key(db: Session, prefix: str, config: dict) -> str:
    """rerank/tts 等集成密钥解析：专用 key 为空时借当前主 LLM key
    （用户约定：rerank 与 LLM 用同一套 API，DashScope key 通用）。"""
    return ((get_setting(db, f"{prefix}_api_key") or "").strip()
            or (config.get("api_key") or "").strip())


def patient_context(db: Session, profile_id: int | None, user) -> str:
    if not profile_id:
        return ""
    summary = get_profile_summary(db, profile_id, user)
    if not summary:
        return ""
    sections = [format_profile_for_prompt(summary)]
    for member in get_family_members(db, profile_id, user):
        member_summary = get_profile_summary(db, member.id, user)
        if member_summary:
            sections.append("家庭成员病史：\n" + format_profile_for_prompt(member_summary))
    return "\n\n".join(sections)


def triage_context(conversation) -> str:
    if not conversation.triage_json:
        return ""
    try:
        data = json.loads(conversation.triage_json)
    except (TypeError, json.JSONDecodeError):
        return ""
    fields = [
        ("疾病分类", data.get("categoryName")),
        ("分诊疾病", data.get("diseaseName")),
        ("建议科室", data.get("department")),
        ("核心病机分支", data.get("branchLabel")),
        ("初步证型", data.get("syndromeLabel")),
        ("勾选症状", "、".join(data.get("symptoms") or [])),
        ("分诊主诉", data.get("chiefComplaint")),
    ]
    lines = [f"{label}: {value}" for label, value in fields if value]
    if data.get("emergency"):
        lines.append("风险提示: 分诊规则命中急危重症特征，应优先线下急诊评估。")
    return "文档共识分诊信息：\n" + "\n".join(lines) if lines else ""


def load_intake_state(conversation) -> dict:
    """读取会话的 intake 状态。首轮为空字典。"""
    if not conversation.intake_state_json:
        return {}
    try:
        return json.loads(conversation.intake_state_json) or {}
    except (TypeError, json.JSONDecodeError):
        return {}


def save_intake_state(conversation, state: dict, db: Session) -> None:
    """写回 intake 状态到会话记录。"""
    conversation.intake_state_json = json.dumps(state, ensure_ascii=False)
    db.commit()


def intake_collected_summary(state: dict) -> str:
    """把 intake 阶段累计收集的症状/选项汇总为一段文本，供报告生成阶段作为上下文。"""
    turns = state.get("turns") or []
    parts: list[str] = []
    for turn in turns:
        asked = turn.get("asked")
        selected = turn.get("selected") or []
        if asked and selected:
            parts.append(f"{asked}：{'、'.join(selected)}")
    return "\n".join(parts)


@router.post("/conversations", response_model=ConversationResponse, status_code=201)
def create_new_conversation(data: ConversationCreate, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    return create_conversation(db, current_user, data.title, data.patient_profile_id, data.triage, data.consultation_mode)


@router.get("/conversations", response_model=List[ConversationResponse])
def get_conversations(current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    return get_user_conversations(db, current_user)


@router.get("/conversations/{conversation_id}", response_model=ConversationResponse)
def get_conversation(conversation_id: int, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    return get_conversation_by_id(db, conversation_id, current_user)


@router.put("/conversations/{conversation_id}", response_model=ConversationResponse)
def update_conversation(conversation_id: int, data: ConversationUpdate, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    conversation = get_conversation_by_id(db, conversation_id, current_user)
    if data.title is not None:
        conversation.title = data.title
    if data.is_active is not None:
        conversation.is_active = data.is_active
    if "patient_profile_id" in data.model_fields_set:
        conversation.patient_profile_id = data.patient_profile_id
    if "triage" in data.model_fields_set:
        conversation.triage_json = json.dumps(data.triage, ensure_ascii=False) if data.triage else None
    if not data.model_fields_set:
        raise HTTPException(400, "未提供可更新字段")
    db.commit()
    db.refresh(conversation)
    return conversation


@router.post("/conversations/{conversation_id}/rename", response_model=ConversationResponse)
async def auto_rename(conversation_id: int, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    conversation = get_conversation_by_id(db, conversation_id, current_user)
    messages = get_conversation_messages(db, conversation_id, current_user)
    if not messages:
        raise HTTPException(400, "当前会话还没有消息")
    config = llm_config(db)
    excerpt = "\n".join(f"{m.role}: {m.content[:180]}" for m in messages[:8])
    title = await complete_llm(
        config, "你是会话标题生成器，只输出 8-24 字中文标题。", excerpt, 80,
        on_usage=lambda n: add_usage(db, current_user.id, "tokens", n),
    )
    return update_conversation_title(db, conversation_id, current_user, title.strip('“”\"')[:50])


@router.get("/conversations/{conversation_id}/messages", response_model=List[MessageResponse])
def get_messages(conversation_id: int, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    return get_conversation_messages(db, conversation_id, current_user)


@router.post("/conversations/{conversation_id}/messages")
async def send_message(conversation_id: int, data: MessageCreate, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    conversation = get_conversation_by_id(db, conversation_id, current_user)
    if not conversation.is_active:
        raise HTTPException(403, "系统模型已更新，请新建会话。")
    config = llm_config(db)
    system_prompt = get_setting(db, "system_prompt") or "你是一位专业的中医医生，擅长诊断和治疗各种慢性病。请给出专业的诊疗建议，输出 markdown；重点关键词加粗，需要强调的词用彩色语法 [[#色值|文字]] 标注（蓝 #1976D2 时机/红 #D32F2F 警告/绿 #2E7D32 建议/橙 #F57C00 注意/紫 #7B1FA2 证型），每段最多 2-4 处，不要输出 HTML。"
    profile_id = data.profile_id or conversation.patient_profile_id
    context_parts = [patient_context(db, profile_id, current_user), triage_context(conversation), data.user_info or ""]
    context = "\n\n".join(part for part in context_parts if part)
    history_messages = get_conversation_messages(db, conversation_id, current_user)
    history = [{"role": m.role, "content": m.content} for m in history_messages[-12:]]
    attachments = []
    if data.attachment_ids:
        attachments = db.query(Attachment).filter(Attachment.id.in_(data.attachment_ids), Attachment.user_id == current_user.id, Attachment.conversation_id == conversation_id, Attachment.message_id.is_(None)).all()
        if len(attachments) != len(set(data.attachment_ids)):
            raise HTTPException(400, "附件不存在、已发送或不属于当前会话")
    # ===== 每日配额检查（必须在 SSE 开始前：流中再抛 429 前端只能看到中断）=====
    # token：入口仅校验有剩余额度（不限/未超额才放行），实际用量在流结束后按
    # 统计帧或字符估算事后计量（add_usage），避免流前预扣与真实消耗不符。
    ensure_quota(db, current_user, "tokens", 1, increment=False)
    # 图片：聊天图片已在 media.upload_attachment 上传时计量，这里只校验剩余额度
    #（防止上传后才降额/超额的场景绕过校验直接消耗 VL 分析）
    if attachments:
        ensure_quota(db, current_user, "images", len(attachments), increment=False)
    # 网络搜索：判断本条消息是否会真实触发一次搜索，入口即检查并计数
    #（intake 模式搜索默认开启 data_enable_web_search_default，free 模式看请求开关）
    web_search_planned = get_setting(db, "web_search_enabled") == "true" and (
        data_enable_web_search_default(db) if conversation.consultation_mode == "intake" else data.enable_web_search
    )
    if web_search_planned and (get_setting(db, "web_search_base_url") or "").strip() and resolved_web_search_key(db, config):
        ensure_quota(db, current_user, "web_searches", 1)

    user_message = create_message(db, conversation_id, "user", data.content)
    for attachment in attachments:
        attachment.message_id = user_message.id
        attachment.patient_profile_id = profile_id
    if attachments:
        db.commit()

    # AI 主动问诊模式：用独立的状态机逐轮收集症状，收齐后再转入报告生成。
    if conversation.consultation_mode == "intake":
        return StreamingResponse(
            generate_intake(conversation, config, data.content, context, history, user_message, db),
            media_type="text/event-stream; charset=utf-8",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async def generate():
        trace: list[dict] = []
        citations = []
        web_summary = ""
        total_start = time.perf_counter()
        # token 精确计量：统计帧用量经 on_usage 累计到这里（证据摘要 + 最终正文两路之和），
        # 全部拿不到 usage 时流结束按字符估算（见下方 add_usage 调用处）
        usage_total = {"tokens": 0}

        def accumulate_usage(n: int) -> None:
            usage_total["tokens"] += n

        full_response = ""

        def stage(stage_id: str, title: str, state: str, summary: str, started: float, count: int | None = None, details=None):
            item = {"id": stage_id, "title": title, "status": state, "summary": summary, "elapsed_ms": elapsed_ms(started)}
            if count is not None:
                item["count"] = count
            if details is not None:
                item["details"] = details
            existing = next((index for index, old in enumerate(trace) if old["id"] == stage_id), None)
            if existing is None:
                trace.append(item)
            else:
                trace[existing] = item
            return item

        try:
            vision_summary = ""
            started = time.perf_counter()
            vl_enabled = get_setting(db, "vl_enabled") == "true"
            vl_ready = vl_enabled and all((get_setting(db, key) or "").strip() for key in ("vl_base_url", "vl_endpoint", "vl_api_key", "vl_model"))
            if not attachments:
                item = stage("vision", "医学图片分析", "skipped", "本条消息未上传图片，已跳过", started)
            elif not vl_ready:
                item = stage("vision", "医学图片分析", "skipped", "未配置，已跳过", started)
            else:
                yield sse("trace.stage", {"id": "vision", "title": "医学图片分析", "status": "running", "summary": "正在识别舌像、病历或其他医学图片"})
                try:
                    image_data = [(Path(row.analysis_path or row.storage_path).read_bytes(), row.mime_type) for row in attachments]
                    vision_summary = await analyze_images(get_setting(db, "vl_base_url") or "", get_setting(db, "vl_endpoint") or "/v1/responses", get_setting(db, "vl_api_key") or "", get_setting(db, "vl_model") or "", get_setting(db, "vl_system_prompt") or "", data.content, image_data)
                    for row in attachments:
                        row.analysis_json = json.dumps({"summary": vision_summary}, ensure_ascii=False)
                    db.commit()
                    item = stage("vision", "医学图片分析", "completed", vision_summary, started, len(attachments))
                    yield sse("vision.analysis", {"summary": vision_summary, "attachment_ids": data.attachment_ids})
                except Exception as exc:
                    item = stage("vision", "医学图片分析", "failed", f"执行失败，已跳过：{str(exc)[:100]}", started)
                finally:
                    for row in attachments:
                        if row.analysis_path:
                            try:
                                Path(row.analysis_path).unlink()
                            except FileNotFoundError:
                                pass
                            row.analysis_path = None
                    db.commit()
            yield sse("trace.stage", item)
            for row in attachments:
                if row.analysis_path:
                    try:
                        Path(row.analysis_path).unlink()
                    except FileNotFoundError:
                        pass
                    row.analysis_path = None
            if attachments:
                db.commit()

            started = time.perf_counter()
            yield sse("trace.stage", {"id": "queries", "title": "生成检索词", "status": "running", "summary": "正在拆解疾病、用药、指标与风险问题"})
            queries = await generate_search_queries(config, data.content, context)
            revealed_queries: list[str] = []
            for query in queries:
                revealed_queries.append(query)
                yield sse("trace.stage", {"id": "queries", "title": "生成检索词", "status": "running", "summary": f"已生成 {len(revealed_queries)} 个检索词", "count": len(revealed_queries), "details": revealed_queries.copy()})
                await asyncio.sleep(0.08)
            item = stage("queries", "生成检索词", "completed", f"已生成 {len(queries)} 个检索词", started, len(queries), queries)
            yield sse("trace.stage", item)

            started = time.perf_counter()
            web_enabled = get_setting(db, "web_search_enabled") == "true" and data.enable_web_search
            web_base = (get_setting(db, "web_search_base_url") or "").strip()
            web_key = resolved_web_search_key(db, config)
            web_provider = (get_setting(db, "web_search_provider") or "deepseek").strip()
            if not web_enabled or not web_base or not web_key:
                item = stage("web", "网络搜索", "skipped", "未配置，已跳过", started)
            else:
                searching = "Tavily 快速检索（秒级返回）" if web_provider == "tavily" else f"正在联网检索最新资料（{get_setting(db, 'web_search_model') or '联网模型'}，真实网页抓取约需 20-30 秒）"
                yield sse("trace.stage", {"id": "web", "title": "网络搜索", "status": "running", "summary": searching})
                try:
                    web_summary, web_citations = await search_web(web_provider, web_base, web_key, queries, {
                        "model": get_setting(db, "web_search_model") or "deepseek-v4-flash",
                        "search_depth": get_setting(db, "web_search_depth") or "fast",
                        "max_results": int(get_setting(db, "web_search_max_results") or "8"),
                        "timeout_seconds": int(get_setting(db, "web_search_timeout_seconds") or "15"),
                    })
                    revealed_sources: list[str] = []
                    for citation in web_citations:
                        revealed_sources.append(citation.title or citation.url)
                        yield sse("trace.stage", {"id": "web", "title": "网络搜索", "status": "running", "summary": f"已找到 {len(revealed_sources)} 个可核验来源", "count": len(revealed_sources), "details": revealed_sources.copy()})
                        await asyncio.sleep(0.08)
                    citations.extend(web_citations)
                    # 网络镜像库沉淀：本次来源按 URL 去重入库（尽力而为，不阻断）
                    upsert_mirror_items(db, queries, web_citations)
                    item = stage("web", "网络搜索", "completed", f"获得 {len(web_citations)} 个可核验来源", started, len(web_citations), [c.title for c in web_citations])
                except Exception as exc:
                    item = stage("web", "网络搜索", "failed", f"执行失败，已跳过：{str(exc)[:100]}", started)
            yield sse("trace.stage", item)

            started = time.perf_counter()
            kb_enabled = get_setting(db, "knowledge_base_enabled") == "true"
            kb_url = (get_setting(db, "knowledge_base_url") or "").strip()
            kb_key = (get_setting(db, "knowledge_base_api_key") or "").strip()
            top_k = max(1, min(20, int(get_setting(db, "knowledge_base_top_k") or "5")))
            if not kb_enabled or not kb_url:
                item = stage("knowledge", "知识库搜索", "skipped", "未配置，已跳过", started)
            else:
                yield sse("trace.stage", {"id": "knowledge", "title": "知识库搜索", "status": "running", "summary": "正在检索患者档案与医学知识库"})
                try:
                    kb_citations = await search_knowledge_base(kb_url, kb_key, "；".join(queries), top_k)
                    revealed_kb: list[str] = []
                    for citation in kb_citations:
                        revealed_kb.append(citation.title or citation.url)
                        yield sse("trace.stage", {"id": "knowledge", "title": "知识库搜索", "status": "running", "summary": f"已命中 {len(revealed_kb)} 条资料", "count": len(revealed_kb), "details": revealed_kb.copy()})
                        await asyncio.sleep(0.08)
                    for citation in kb_citations:
                        citation.id = len(citations) + 1
                        citations.append(citation)
                    item = stage("knowledge", "知识库搜索", "completed", f"命中 {len(kb_citations)} 条资料", started, len(kb_citations), [c.title for c in kb_citations])
                except Exception as exc:
                    item = stage("knowledge", "知识库搜索", "failed", f"执行失败，已跳过：{str(exc)[:100]}", started)
            yield sse("trace.stage", item)

            # 权威医学库（原「外部知识源」，独立诊疗指南库服务）+ 网络镜像库：并发检索。
            # 镜像是本地 DB 查询（毫秒级，先算好不占等待），权威库是 HTTP 调用（await 期间
            # 镜像结果已就绪）；失败各自跳过不阻断。镜像排除本次 web 搜索已并入的 URL 防重复。
            started = time.perf_counter()
            ext_enabled, ext_base, ext_top_k = load_external_kb_config(db)
            exclude_urls = {c.url for c in citations if c.url}
            mirror_citations = search_mirror(db, "；".join(queries), 5, exclude_urls)
            if not ext_enabled:
                item = stage("external_kb", "权威医学库", "skipped", "未启用，已跳过", started)
            else:
                yield sse("trace.stage", {"id": "external_kb", "title": "权威医学库", "status": "running", "summary": "正在检索本地诊疗指南与专家共识库"})
                try:
                    ext_citations = await search_external_kb(ext_base, "；".join(queries), ext_top_k)
                    revealed_ext: list[str] = []
                    for citation in ext_citations:
                        revealed_ext.append(citation.title or citation.source)
                        yield sse("trace.stage", {"id": "external_kb", "title": "权威医学库", "status": "running", "summary": f"已命中 {len(revealed_ext)} 条指南共识", "count": len(revealed_ext), "details": revealed_ext.copy()})
                        await asyncio.sleep(0.08)
                    for citation in ext_citations:
                        citation.id = len(citations) + 1
                        citations.append(citation)
                    item = stage("external_kb", "权威医学库", "completed", f"命中 {len(ext_citations)} 条指南共识", started, len(ext_citations), [c.title for c in ext_citations])
                except Exception as exc:
                    logger.warning("权威医学库检索失败，已跳过：%s", str(exc)[:200])
                    item = stage("external_kb", "权威医学库", "failed", f"执行失败，已跳过：{str(exc)[:100]}", started)
            yield sse("trace.stage", item)

            # 网络镜像库（非权威）：历史网络搜索按 URL 沉淀的本地库，命中作为补充证据；
            # 库空或无命中时 skipped（前端时间线不渲染该步，不干扰）
            started = time.perf_counter()
            if not mirror_citations:
                item = stage("mirror", "网络镜像", "skipped", "镜像库暂无相关来源", started)
            else:
                revealed_mirror: list[str] = []
                for citation in mirror_citations:
                    revealed_mirror.append(citation.title or citation.url)
                    yield sse("trace.stage", {"id": "mirror", "title": "网络镜像", "status": "running", "summary": f"已命中 {len(revealed_mirror)} 条历史网络来源", "count": len(revealed_mirror), "details": revealed_mirror.copy()})
                    await asyncio.sleep(0.08)
                for citation in mirror_citations:
                    citation.id = len(citations) + 1
                    citations.append(citation)
                item = stage("mirror", "网络镜像", "completed", f"命中 {len(mirror_citations)} 条历史网络来源", started, len(mirror_citations), [c.title for c in mirror_citations])
            yield sse("trace.stage", item)

            started = time.perf_counter()
            rerank_enabled = get_setting(db, "rerank_enabled") == "true"
            rerank_key = resolved_integration_key(db, "rerank", config)
            rerank_ready = rerank_enabled and bool(rerank_key) and all((get_setting(db, key) or "").strip() for key in ("rerank_base_url", "rerank_endpoint", "rerank_model"))
            if not citations:
                item = stage("rerank", "证据重排", "skipped", "暂无证据，已跳过", started)
            elif not rerank_ready:
                item = stage("rerank", "证据重排", "skipped", "未配置，已跳过", started)
            else:
                yield sse("trace.stage", {"id": "rerank", "title": "证据重排", "status": "running", "summary": "正在按问题相关性重排证据"})
                try:
                    top_n = max(1, min(len(citations), int(get_setting(db, "rerank_top_n") or "5")))
                    indices = await rerank_documents(get_setting(db, "rerank_base_url") or "", get_setting(db, "rerank_endpoint") or "/v1/rerank", rerank_key, get_setting(db, "rerank_model") or "", data.content, [f"{c.title}\n{c.snippet}" for c in citations], top_n)
                    citations = [citations[index] for index in indices if 0 <= index < len(citations)]
                    for index, citation in enumerate(citations, 1):
                        citation.id = index
                    item = stage("rerank", "证据重排", "completed", f"已保留并重排 {len(citations)} 条高相关证据", started, len(citations))
                except Exception as exc:
                    item = stage("rerank", "证据重排", "failed", f"执行失败，保留原顺序：{str(exc)[:100]}", started, len(citations))
            yield sse("trace.stage", item)

            started = time.perf_counter()
            yield sse("trace.stage", {"id": "evidence", "title": "证据整合摘要", "status": "running", "summary": "正在交叉核对控制水平、风险与安全边界"})
            # 思考流式 + 摘要/正文真流式：两条生成通道在独立 task 中泵入队列，SSE 循环短超时轮询——
            # 纯思考阶段（内层生成器无内容产出、reasoning 只走回调）思考增量也能实时外推，
            # 不会攒到首个正文 delta 才一次性涌出。
            thinking_queue: asyncio.Queue = asyncio.Queue()
            events: asyncio.Queue = asyncio.Queue()

            # 思考增量带阶段标记（stage=evidence/answer）：前端把证据整合阶段的思考
            # 显示在对应轨迹步骤内、正文生成前的思考单独一步，不再混在同一个模块
            def push_thinking(stage_tag: str):
                def _push(text: str) -> None:
                    thinking_queue.put_nowait((stage_tag, text))
                return _push

            async def pump() -> None:
                try:
                    pumped_summary = ""
                    async for partial in stream_evidence_summary(
                        config, data.content, citations, web_summary,
                        on_reasoning=push_thinking("evidence"),
                        on_usage=accumulate_usage,
                    ):
                        pumped_summary = partial
                        await events.put(("evidence", partial))
                    pumped_analysis = pumped_summary + (f"\n\n医学图片辅助分析：{vision_summary}" if vision_summary else "")
                    await events.put(("evidence_done", (pumped_summary, pumped_analysis)))
                    # citations 延迟到首个正文 delta 之后再推（用户要求：参考文献不要先于正文弹出）
                    answer_context = "\n\n".join(part for part in (context, f"医学图片辅助分析：{vision_summary}" if vision_summary else "") if part)
                    budget_raw = (get_setting(db, "llm_thinking_budget") or "").strip()
                    # 默认 1024：qwen3.8 thinking 输出约 60-100 tok/s，2048 要多等 10-20s
                    thinking_budget = int(budget_raw) if budget_raw.isdigit() and int(budget_raw) > 0 else 1024
                    async for chunk in stream_final_answer(
                        config, system_prompt, history, data.content, answer_context, pumped_summary, citations,
                        on_reasoning=push_thinking("answer"),
                        enable_thinking=True,
                        thinking_budget=thinking_budget,
                        on_usage=accumulate_usage,
                    ):
                        if chunk.lstrip().startswith("[错误]"):
                            raise RuntimeError(chunk)
                        await events.put(("answer", chunk))
                except Exception as exc:  # noqa: BLE001
                    await events.put(("error", str(exc)))
                finally:
                    await events.put(("done", None))

            pump_task = asyncio.create_task(pump())
            evidence_summary = ""
            analysis_summary = ""
            full_response = ""
            consuming = True
            try:
                while consuming:
                    while not thinking_queue.empty():
                        stage_tag, text = thinking_queue.get_nowait()
                        yield sse("thinking.delta", {"delta": text, "stage": stage_tag})
                    try:
                        kind, payload = await asyncio.wait_for(events.get(), timeout=0.12)
                    except asyncio.TimeoutError:
                        continue
                    if kind == "evidence":
                        evidence_summary = payload
                        yield sse("trace.stage", {"id": "evidence", "title": "证据整合摘要", "status": "running", "summary": payload})
                        yield sse("analysis.summary", {"summary": payload})
                    elif kind == "evidence_done":
                        evidence_summary, analysis_summary = payload
                        yield sse("trace.stage", stage("evidence", "证据整合摘要", "completed", evidence_summary, started, len(citations)))
                        yield sse("analysis.summary", {"summary": analysis_summary})
                    elif kind == "answer":
                        full_response += payload
                        yield sse("answer.delta", {"delta": payload})
                    elif kind == "error":
                        raise RuntimeError(payload)
                    else:
                        consuming = False
            finally:
                if not pump_task.done():
                    pump_task.cancel()
            while not thinking_queue.empty():
                stage_tag, text = thinking_queue.get_nowait()
                yield sse("thinking.delta", {"delta": text, "stage": stage_tag})
            if citations:
                sources = "\n\n### 参考来源\n" + "\n".join(f"[{c.id}] [{c.title}]({c.url})" if c.url else f"[{c.id}] {c.title}" for c in citations)
                full_response += sources
                yield sse("answer.delta", {"delta": sources})
            # 参考文献（citations SSE）在正文全部输出完成后才推送（用户要求：最后再弹出）
            yield sse("citations", {"items": citation_dicts(citations)})
            assistant = create_message(
                db, conversation_id, "assistant", full_response,
                trace_json=json.dumps(trace, ensure_ascii=False),
                citations_json=json.dumps(citation_dicts(citations), ensure_ascii=False),
                generation_status="completed",
                analysis_summary=analysis_summary,
            )
            # token 事后计量：优先统计帧实际用量；两路 LLM 都没拿到 usage 时按字符估算（约 1.5 token/字）
            add_usage(db, current_user.id, "tokens", usage_total["tokens"] or int(len(full_response) * 1.5))
            if conversation.title in {"新问诊", "新对话", "自由问诊", "AI 主动问诊"} or conversation.title.startswith("患者-"):
                try:
                    generated_title = await complete_llm(
                        config, "你是会话标题生成器，只输出 8-24 字中文标题。", data.content, 80,
                        on_usage=lambda n: add_usage(db, current_user.id, "tokens", n),
                    )
                    conversation.title = generated_title.strip('“”"')[:50]
                    db.commit()
                except Exception:
                    pass
            yield sse("done", {"message_id": assistant.id, "elapsed_ms": elapsed_ms(total_start)})
        except Exception as exc:
            # 已流出的部分 token 同样计量（add_usage 内部吞错，不影响错误提示）
            add_usage(db, current_user.id, "tokens", usage_total["tokens"] or int(len(full_response) * 1.5))
            # HTTPException（如配额 429）取 detail 文案；普通异常取 str——
            # 避免把 {"detail":"..."} 的 JSON 序列化整个显示给用户
            exc_text = getattr(exc, "detail", None) or str(exc)
            yield sse("error", {"message": f"回答生成失败：{str(exc_text)[:240]}"})

    return StreamingResponse(generate(), media_type="text/event-stream; charset=utf-8", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def generate_intake(conversation, config, user_message_text, patient_context_str, history, user_message, db):
    """AI 主动问诊模式的 SSE 生成器：每轮产 intake.turn（回应+选项），收齐后转报告。

    token 每日配额：入口检查在 send_message 中完成（SSE 开始前），
    这里在每轮流结束后按统计帧实际用量或字符估算事后计量（add_usage）。
    """
    total_start = time.perf_counter()
    intake_system_prompt = get_setting(db, "intake_system_prompt") or "你是中医慢病问诊助手，请逐步提问收集症状。"
    state = load_intake_state(conversation)
    turns = state.setdefault("turns", [])
    rounds = state.get("rounds", 0) + 1
    # token 计量：本轮追问 + 报告正文的统计帧用量累计（generate_intake_user 无 user 对象，
    # 用 conversation.user_id 落账），拿不到 usage 时按字符估算
    usage_total = {"tokens": 0}

    def accumulate_usage(n: int) -> None:
        usage_total["tokens"] += n

    try:
        # 把当前轮的用户输入并入供 LLM 参考的历史
        intake_history = history + [{"role": "user", "content": user_message_text}]
        turn = await generate_intake_turn(
            config, intake_history, user_message_text, patient_context_str, intake_system_prompt,
            on_usage=accumulate_usage,
        )
        turns.append({"asked": user_message_text, "reply": turn.get("reply", ""), "options": turn.get("options", [])})
        state["rounds"] = rounds
        state["complete"] = bool(turn.get("complete"))
        save_intake_state(conversation, state, db)

        if not turn.get("complete"):
            # 追问轮：持久化一条 assistant 消息承载本轮回应文字（intake 状态已在 conversation 上保存）
            assistant = create_message(
                db, conversation.id, "assistant", turn.get("reply", ""),
            )
            # token 事后计量（追问轮：按本轮回应长度估算兜底）
            add_usage(db, conversation.user_id, "tokens", usage_total["tokens"] or int(len(turn.get("reply", "")) * 1.5))
            yield sse("intake.turn", {
                "message_id": assistant.id,
                "reply": turn.get("reply", ""),
                "options": turn.get("options", []),
                "round": rounds,
                "intake_state": state,
            })
            yield sse("done", {"message_id": assistant.id, "elapsed_ms": elapsed_ms(total_start)})
            return

        # 收齐：通知前端进入报告生成，然后转入现有的证据管线 + 流式最终回答
        yield sse("intake.complete", {
            "summary": intake_collected_summary(state),
            "round": rounds,
            "intake_state": state,
        })
        # 同步 system_prompt、trace、citations、最终回答（复用 free 模式的流水线）
        system_prompt = get_setting(db, "system_prompt") or "你是一位专业的中医医生，擅长诊断和治疗各种慢性病。请给出专业的诊疗建议，输出 markdown；重点关键词加粗，需要强调的词用彩色语法 [[#色值|文字]] 标注（蓝 #1976D2 时机/红 #D32F2F 警告/绿 #2E7D32 建议/橙 #F57C00 注意/紫 #7B1FA2 证型），每段最多 2-4 处，不要输出 HTML。"
        trace: list[dict] = []
        citations: list = []
        collected = intake_collected_summary(state)
        report_context = "\n\n".join(part for part in (patient_context_str, f"AI 主动问诊收集到的症状：\n{collected}") if part)
        evidence_summary = ""
        web_summary = ""
        try:
            queries = await generate_search_queries(config, collected or user_message_text, report_context)
            trace.append({"id": "queries", "title": "生成检索词", "status": "completed", "summary": f"已生成 {len(queries)} 个检索词", "count": len(queries), "details": queries})
        except Exception as exc:
            queries = [collected[:120] or user_message_text[:120]]
            trace.append({"id": "queries", "title": "生成检索词", "status": "failed", "summary": f"执行失败：{str(exc)[:80]}"})
        try:
            web_enabled = get_setting(db, "web_search_enabled") == "true" and data_enable_web_search_default(db)
            web_base = (get_setting(db, "web_search_base_url") or "").strip()
            web_key = resolved_web_search_key(db, config)
            web_provider = (get_setting(db, "web_search_provider") or "deepseek").strip()
            if web_enabled and web_base and web_key:
                web_summary, web_citations = await search_web(web_provider, web_base, web_key, queries, {
                    "model": get_setting(db, "web_search_model") or "deepseek-v4-flash",
                    "search_depth": get_setting(db, "web_search_depth") or "fast",
                    "max_results": int(get_setting(db, "web_search_max_results") or "8"),
                    "timeout_seconds": int(get_setting(db, "web_search_timeout_seconds") or "15"),
                })
                citations.extend(web_citations)
                # 网络镜像库沉淀：本次来源按 URL 去重入库（尽力而为，不阻断）
                upsert_mirror_items(db, queries, web_citations)
                trace.append({"id": "web", "title": "网络搜索", "status": "completed", "summary": f"获得 {len(web_citations)} 个可核验来源", "count": len(web_citations), "details": [c.title for c in web_citations]})
        except Exception as exc:
            trace.append({"id": "web", "title": "网络搜索", "status": "failed", "summary": f"执行失败：{str(exc)[:80]}"})
        # 权威医学库（原「外部知识源」）+ 网络镜像库：与 web 搜索并列的独立证据分支，失败跳过不阻断。
        try:
            ext_enabled, ext_base, ext_top_k = load_external_kb_config(db)
            mirror_citations = search_mirror(db, "；".join(queries), 5, {c.url for c in citations if c.url})
            if ext_enabled:
                ext_citations = await search_external_kb(ext_base, "；".join(queries), ext_top_k)
                for citation in ext_citations:
                    citation.id = len(citations) + 1
                    citations.append(citation)
                trace.append({"id": "external_kb", "title": "权威医学库", "status": "completed", "summary": f"命中 {len(ext_citations)} 条指南共识", "count": len(ext_citations), "details": [c.title for c in ext_citations]})
            else:
                trace.append({"id": "external_kb", "title": "权威医学库", "status": "skipped", "summary": "未启用，已跳过"})
            if mirror_citations:
                for citation in mirror_citations:
                    citation.id = len(citations) + 1
                    citations.append(citation)
                trace.append({"id": "mirror", "title": "网络镜像", "status": "completed", "summary": f"命中 {len(mirror_citations)} 条历史网络来源", "count": len(mirror_citations), "details": [c.title for c in mirror_citations]})
        except Exception as exc:
            logger.warning("权威医学库/网络镜像检索失败，已跳过：%s", str(exc)[:200])
            trace.append({"id": "external_kb", "title": "权威医学库", "status": "failed", "summary": f"执行失败：{str(exc)[:80]}"})
        try:
            evidence_summary = await build_evidence_summary(config, collected or user_message_text, citations, web_summary)
            yield sse("analysis.summary", {"summary": evidence_summary})
        except Exception as exc:
            evidence_summary = ""
        yield sse("citations", {"items": citation_dicts(citations)})

        full_response = ""
        async for chunk in stream_final_answer(config, system_prompt, history, collected or user_message_text, report_context, evidence_summary, citations, on_usage=accumulate_usage):
            if chunk.lstrip().startswith("[错误]"):
                raise RuntimeError(chunk)
            full_response += chunk
            yield sse("answer.delta", {"delta": chunk})
        if citations:
            sources = "\n\n### 参考来源\n" + "\n".join(f"[{c.id}] [{c.title}]({c.url})" if c.url else f"[{c.id}] {c.title}" for c in citations)
            full_response += sources
            yield sse("answer.delta", {"delta": sources})
        disclaimer = "\n\n> ⚠️ 辅助问诊声明：以上内容仅供参考，不能替代医生当面诊断与处方。"
        full_response += disclaimer
        yield sse("answer.delta", {"delta": disclaimer})
        assistant = create_message(
            db, conversation.id, "assistant", full_response,
            trace_json=json.dumps(trace, ensure_ascii=False),
            citations_json=json.dumps(citation_dicts(citations), ensure_ascii=False),
            generation_status="completed",
            analysis_summary=evidence_summary,
        )
        # token 事后计量（收齐转报告轮：证据摘要/检索词未计量的小额调用由正文估算覆盖）
        add_usage(db, conversation.user_id, "tokens", usage_total["tokens"] or int(len(full_response) * 1.5))
        if conversation.title in {"新问诊", "新对话"} or conversation.title.startswith("患者-"):
            try:
                generated_title = await complete_llm(
                    config, "你是会话标题生成器，只输出 8-24 字中文标题。", collected or user_message_text, 80,
                    on_usage=lambda n: add_usage(db, conversation.user_id, "tokens", n),
                )
                conversation.title = generated_title.strip('“”"')[:50]
                db.commit()
            except Exception:
                pass
        yield sse("done", {"message_id": assistant.id, "elapsed_ms": elapsed_ms(total_start)})
    except Exception as exc:
        # 已消耗的 token 同样计量（add_usage 内部吞错，不影响错误提示）
        try:
            add_usage(db, conversation.user_id, "tokens", usage_total["tokens"])
        except Exception:
            pass
        yield sse("error", {"message": f"问诊生成失败：{str(getattr(exc, 'detail', None) or exc)[:240]}"})


def data_enable_web_search_default(db: Session) -> bool:
    """默认允许 web 搜索（与 MessageCreate.enable_web_search 的默认 True 对齐）。"""
    return True


@router.put("/messages/{message_id}/feedback", response_model=MessageResponse)
def update_feedback(message_id: int, data: MessageFeedbackUpdate, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    message = db.query(Message).filter(Message.id == message_id).first()
    if not message:
        raise HTTPException(404, "消息不存在")
    get_conversation_by_id(db, message.conversation_id, current_user)
    if message.role != "assistant":
        raise HTTPException(400, "只能评价助手回答")
    message.feedback = data.feedback or None
    db.commit()
    db.refresh(message)
    return message


@router.post("/conversations/{conversation_id}/summary")
async def summarize_conversation(conversation_id: int, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    get_conversation_by_id(db, conversation_id, current_user)
    messages = get_conversation_messages(db, conversation_id, current_user)
    if not messages:
        raise HTTPException(400, "当前会话没有可总结内容")
    transcript = "\n\n".join(f"{m.role}: {m.content}" for m in messages[-20:])
    summary = await complete_llm(
        llm_config(db), "你是医疗问诊记录员。输出简洁、结构化的问诊摘要，不新增事实。", transcript, 1200,
        on_usage=lambda n: add_usage(db, current_user.id, "tokens", n),
    )
    return {"summary": summary}


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conv(conversation_id: int, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    delete_conversation(db, conversation_id, current_user)


@router.get("/conversations/{conversation_id}/suggested-questions")
async def suggested_questions(conversation_id: int, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    get_conversation_by_id(db, conversation_id, current_user)
    if get_setting(db, "suggested_questions_enabled") != "true":
        return {"questions": []}
    messages = get_conversation_messages(db, conversation_id, current_user)
    if not messages:
        return {"questions": []}
    count = int(get_setting(db, "suggested_questions_count") or "3")
    api_key = (get_setting(db, "suggested_questions_api_key") or get_setting(db, "llm_api_key") or "").strip()
    if not api_key:
        return {"questions": []}
    success, questions, _ = await generate_suggested_questions(
        provider=get_setting(db, "suggested_questions_provider") or get_setting(db, "llm_provider") or "deepseek",
        api_key=api_key,
        model=get_setting(db, "suggested_questions_model_id") or get_setting(db, "llm_model_id") or "deepseek-chat",
        system_prompt=get_setting(db, "suggested_questions_system_prompt") or "根据对话生成后续问题，只输出 JSON 数组。",
        messages=[{"role": m.role, "content": m.content} for m in messages[-10:]],
        count=count,
        base_url=get_setting(db, "suggested_questions_base_url") or get_setting(db, "llm_base_url") or None,
    )
    return {"questions": questions[:count] if success else []}
