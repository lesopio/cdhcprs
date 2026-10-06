"""长辈模式（适老问答）生成 API。

纯生成端点：不建会话、不写 messages 表。问题与报告均由 LLM 依据
主诉 + 历史问答 + 前端传入的分诊依据摘要现场生成。
补全统一走 services/llm.py 现有的 stream_llm_response（聚合为整段文本）。

多模态增强（本轮接入，均不落盘、不写库）：
- 图片：前端把图片转 data URL 随请求体 images 直传，后端解码后调
  services/integrations.analyze_images（VL），摘要注入 question/report 上下文；
  VL 未配置或未传图片则整体跳过（与 chat_v2 同款判断）。
- 搜索：web_search_enabled=true 时检索最新网络资料，摘要与来源注入
  question 提示与 report 正文（带 [编号] 来源标记）；失败不阻断生成。
- 外部知识源：external_kb_enabled=true 时检索独立诊疗指南库服务（默认
  http://127.0.0.1:8900，见 routers/external_kb.py），指南共识摘要与来源
  以独立标注（外部知识源·疾病·标题）注入 question/report，与搜索增强同款
  模式、失败同样不阻断。
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import re
from typing import List

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from core.database import get_db
from routers.external_kb import load_external_kb_config, search_external_kb
from services.agent_pipeline import Citation, _extract_links, complete_llm, responses_url, search_tavily
from services.auth import get_current_user
from services.chat import create_conversation, create_message
from services.integrations import analyze_images
from services.llm import stream_llm_response
from services.settings import get_setting
from services.usage import add_usage, ensure_quota

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/senior", tags=["长辈模式"])

# stream_llm_response 失败时会以该前缀在流内输出错误说明（见 services/llm.py）
_LLM_ERROR_MARKER = "[错误]"

QUESTION_SYSTEM_PROMPT = (
    "你是一位面向中老年患者的中医慢病问诊助手，语气亲切耐心。"
    "你每次只提一个问题，问题必须口语化、通俗、简短（不超过 30 字），"
    "避免任何医学专业术语，不要一次问好几件事。\n"
    "严格只输出一个 JSON 对象，格式如下（不要 markdown 围栏、不要解释、不要多余文字）：\n"
    '{"question": "问题文本", "options": ["选项1", "选项2", "选项3"], "multi": false, "tip": "口语化科普"}\n'
    "要求：\n"
    "1. options：3 到 6 个患者可以直接点选的通俗选项，覆盖该问题最常见的几种情况，"
    "可视情况在末尾放一个「都没有 / 不确定」类的兜底选项；\n"
    "2. multi：这个问题是否适合多选（布尔值，多数情况为 false）；\n"
    "3. tip：不少于 80 字的口语化科普，用长辈听得懂的大白话解释「为什么要问这个问题」，"
    "纯文字，不要用任何符号开头的列表或标题。"
)

REPORT_SYSTEM_PROMPT = (
    "你是一位面向中老年患者的中医慢病问诊助手。请根据患者主诉和问答记录，"
    "用 markdown 写一份通俗、温暖、结构化的健康总结报告，给患者本人看，"
    "不是诊断书。只输出 markdown 正文，不要围栏。\n"
    "结构固定为四个二级标题，依次为：\n"
    "## 情况梳理\n## 需要关注的信号\n## 建议科室与日常调理\n## 免责声明\n"
    "要求：全篇大白话，分点简短；不编造诊断，不夸大病情；"
    "免责声明中说明本报告仅供健康参考、不能替代医生当面诊断，如有不适请及时就医。"
)


class SeniorHistoryItem(BaseModel):
    question: str
    answer: str


class SeniorQuestionRequest(BaseModel):
    chief_complaint: str = Field(..., min_length=1)
    history: List[SeniorHistoryItem] = Field(default_factory=list)
    triage_context: str = ""
    # 医学图片 data URL（data:image/...;base64,...）直传，仅作本轮问诊参考，不落盘不写库
    images: List[str] = Field(default_factory=list)
    # 关联的长辈问诊会话（/api/senior/sessions 创建）；第一问完成后用于生成会话标题
    session_id: int | None = None


class SeniorQuestionResponse(BaseModel):
    question: str
    options: List[str]
    multi: bool
    tip: str


class SeniorReportRequest(BaseModel):
    chief_complaint: str = Field(..., min_length=1)
    history: List[SeniorHistoryItem] = Field(default_factory=list)
    images: List[str] = Field(default_factory=list)


class SeniorReportResponse(BaseModel):
    report: str


def llm_config(db: Session) -> dict:
    """复用全局模型设置（与 chat_v2.llm_config 同口径）。"""
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


# ── 图片（VL）：data URL 解码 + 辅助观察 ─────────────────────────────
_DATA_URL_RE = re.compile(r"^data:(image/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)\s*$")


def _decode_images(db: Session, images: List[str]) -> List[tuple[bytes, str]]:
    """解码前端直传的 data URL 图片（与 media.upload_attachment 同口径的限额）。

    类型仅 JPEG/PNG/WebP（image/jpg 归一为 image/jpeg）；张数上限 vl_max_images，
    单张大小上限 vl_max_image_mb（按解码后字节算，data URL 的 base64 膨胀不算在内）。
    违规直接抛 4xx，由前端 toast 明确告知长辈。
    """
    if not images:
        return []
    max_images = int(get_setting(db, "vl_max_images") or "4")
    max_mb = int(get_setting(db, "vl_max_image_mb") or "10")
    max_bytes = max_mb * 1024 * 1024
    decoded: List[tuple[bytes, str]] = []
    for data_url in images[:max_images]:
        match = _DATA_URL_RE.match((data_url or "").strip())
        if not match:
            raise HTTPException(status_code=415, detail="仅支持 JPEG、PNG、WebP 图片")
        mime, payload = match.group(1), match.group(2)
        if mime == "image/jpg":
            mime = "image/jpeg"
        try:
            raw = base64.b64decode(payload)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail="图片数据解析失败，请重新选择图片")
        if not raw:
            raise HTTPException(status_code=400, detail="图片内容为空，请重新选择图片")
        if len(raw) > max_bytes:
            raise HTTPException(status_code=413, detail=f"单张图片不能超过 {max_mb} MB")
        decoded.append((raw, mime))
    return decoded


def _vl_ready(db: Session) -> bool:
    """VL（医学图片分析）是否已启用并配置完整（每日配额图片计量点共用该判断）。"""
    return get_setting(db, "vl_enabled") == "true" and all(
        (get_setting(db, key) or "").strip()
        for key in ("vl_base_url", "vl_endpoint", "vl_api_key", "vl_model")
    )


def _web_evidence_ready(db: Session) -> bool:
    """网络搜索是否已启用并配置完整（每日配额搜索计量点共用该判断，与 _web_evidence 同口径）。"""
    return (
        get_setting(db, "web_search_enabled") == "true"
        and bool((get_setting(db, "web_search_base_url") or "").strip())
        and bool((get_setting(db, "web_search_api_key") or "").strip())
    )


def _senior_daily_quota_gate(db: Session, current_user, images: List[str]) -> None:
    """长辈模式两个流式端点的每日配额入口检查（必须在 SSE 开始前，流中 429 无意义）。

    - token：仅校验剩余额度，实际用量在流结束后按统计帧/字符估算事后计量；
    - 图片：data URL 直传没有上传计量点，这里检查并计数（仅 VL 已配置时才真实消耗，
      张数与 _decode_images 的 vl_max_images 截断上限对齐）；
    - 网络搜索：会真实触发一次搜索，入口即计数。
    """
    ensure_quota(db, current_user, "tokens", 1, increment=False)
    if images and _vl_ready(db):
        max_images = int(get_setting(db, "vl_max_images") or "4")
        ensure_quota(db, current_user, "images", min(len(images), max(1, max_images)))
    if _web_evidence_ready(db):
        ensure_quota(db, current_user, "web_searches", 1)


async def _vision_summary(db: Session, question_text: str, images: List[str]) -> str:
    """医学图片辅助观察摘要；VL 未配置或未传图则跳过（chat_v2:235-236 同款判断）。

    分析失败不阻断问答（返回空串），长辈不能因为图片链路故障问不了诊。
    """
    if not _vl_ready(db):
        return ""
    decoded = _decode_images(db, images)
    if not decoded:
        return ""
    try:
        return await analyze_images(
            get_setting(db, "vl_base_url") or "",
            get_setting(db, "vl_endpoint") or "/v1/responses",
            get_setting(db, "vl_api_key") or "",
            get_setting(db, "vl_model") or "",
            get_setting(db, "vl_system_prompt") or "",
            question_text,
            decoded,
        )
    except Exception as exc:
        logger.warning("长辈模式图片分析失败，已跳过：%s", str(exc)[:200])
        return ""


# ── 搜索：web_search_enabled 开启时检索最新网络资料 ───────────────────
def _search_queries(chief_complaint: str, history: List[SeniorHistoryItem]) -> List[str]:
    """主诉 + 最近一轮问答拼检索词（不在长辈链路里再花一次 LLM 规划调用）。"""
    query = chief_complaint.strip()
    if history:
        last = history[-1]
        piece = f"{last.question.strip()}：{last.answer.strip()}".strip("： ")
        if piece:
            query = f"{query}；{piece}"
    return [query[:160]] if query else []


async def _web_evidence(
    db: Session, chief_complaint: str, history: List[SeniorHistoryItem],
) -> tuple[str, List[Citation]]:
    """检索最新网络资料，返回（摘要, 来源）；未启用/未配置返回空，失败不阻断。

    search_deepseek 目前把模型名硬编码为 deepseek-v4-flash
    （services/agent_pipeline.py:144-151），web_search_model 参数化合入前，
    这里按 get_setting(db, 'web_search_model') or 'deepseek-v4-flash'
    直接构造同协议请求；解析逻辑与 search_deepseek 保持一致。
    """
    if get_setting(db, "web_search_enabled") != "true":
        return "", []
    web_base = (get_setting(db, "web_search_base_url") or "").strip()
    web_key = (get_setting(db, "web_search_api_key") or "").strip()
    if not web_base or not web_key:
        return "", []
    queries = _search_queries(chief_complaint, history)
    if not queries:
        return "", []
    try:
        provider = (get_setting(db, "web_search_provider") or "deepseek").strip()
        options = {
            "search_depth": get_setting(db, "web_search_depth") or "fast",
            "max_results": int(get_setting(db, "web_search_max_results") or "8"),
            "timeout_seconds": int(get_setting(db, "web_search_timeout_seconds") or "15"),
        }
        if provider == "tavily":
            return await search_tavily(web_base, web_key, queries, options)
        payload = {
            "model": (get_setting(db, "web_search_model") or "").strip() or "deepseek-v4-flash",
            "input": (
                "必须使用网络搜索工具。检索以下医疗问题，给出简洁、通俗、可核验的结论，"
                "并为每条事实附可访问的来源链接：\n" + "\n".join(f"- {q}" for q in queries)
            ),
            "tools": [{"type": "web_search"}],
            "tool_choice": "required",
            "stream": False,
        }
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                responses_url(web_base),
                headers={"Authorization": f"Bearer {web_key}", "Content-Type": "application/json"},
                json=payload,
            )
            response.raise_for_status()
            data = response.json()

        text_parts: List[str] = []
        sources: List[tuple[str, str, str]] = []
        for item in data.get("output") or []:
            if item.get("type") == "web_search_call":
                for source in (item.get("action") or {}).get("sources") or []:
                    sources.append((source.get("title") or source.get("url") or "网络来源", source.get("url") or "", source.get("snippet") or ""))
            if item.get("type") == "message":
                for content in item.get("content") or []:
                    if content.get("type") == "output_text" and content.get("text"):
                        text_parts.append(content["text"])
                        for annotation in content.get("annotations") or []:
                            if annotation.get("url"):
                                sources.append((annotation.get("title") or annotation["url"], annotation["url"], ""))
        summary = "\n".join(text_parts).strip()
        if not sources:
            sources = [(title, url, "") for title, url in _extract_links(summary)]
        citations: List[Citation] = []
        seen: set[str] = set()
        for title, url, snippet in sources:
            if not url or url in seen:
                continue
            seen.add(url)
            citations.append(Citation(len(citations) + 1, "web", title, url, snippet))
        return summary, citations[:8]
    except Exception as exc:
        logger.warning("长辈模式网络搜索失败，已跳过：%s", str(exc)[:200])
        return "", []


def _sources_line(citations: List[Citation]) -> str:
    """来源标记行（注入 question 提示用，不要求模型复述链接）。"""
    if not citations:
        return ""
    return "；".join(f"[{c.id}] {c.title}" for c in citations)


async def _external_kb_evidence(
    db: Session, chief_complaint: str, history: List[SeniorHistoryItem],
    id_offset: int = 0,
) -> tuple[str, List[Citation]]:
    """外部知识源（独立诊疗指南库服务）检索：未启用返回空，失败不阻断。

    与 _web_evidence 同款模式——摘要行（[编号] 标题：片段，snippet 已剥【】标记符）
    + citations（source=「外部知识源·疾病·标题」，url 留空），与 chat_v2 的来源
    标注口径一致。检索词复用 _search_queries。

    id_offset：web 证据条数。search_external_kb 从 1 起编号，这里整体平移到
    web 证据之后（与 _merge_citations 合并重编号一致），保证 prompt 内摘要行、
    证据清单与报告末尾 _sources_appendix 用同一套编号，两路证据不会都从 [1] 起。
    """
    enabled, base_url, top_k = load_external_kb_config(db)
    if not enabled:
        return "", []
    queries = _search_queries(chief_complaint, history)
    if not queries:
        return "", []
    try:
        citations = await search_external_kb(base_url, "；".join(queries), top_k)
        if not citations:
            return "", []
        for index, citation in enumerate(citations, start=id_offset + 1):
            citation.id = index
        summary = "\n".join(
            f"[{c.id}] {c.source}：{c.snippet}" if c.snippet else f"[{c.id}] {c.source}"
            for c in citations
        )
        return summary, citations
    except Exception as exc:
        logger.warning("长辈模式外部知识源检索失败，已跳过：%s", str(exc)[:200])
        return "", []


async def _complete(config: dict, system_prompt: str, prompt: str, on_usage=None) -> str:
    """聚合 stream_llm_response 为整段文本；流内错误标记视为失败抛异常。

    on_usage：透传 stream_llm_response 的 token 用量回调（每日配额事后计量）。
    """
    chunks: List[str] = []
    async for chunk in stream_llm_response(
        provider=config["provider"],
        api_key=config["api_key"],
        model=config["model"],
        system_prompt=system_prompt,
        messages=[{"role": "user", "content": prompt}],
        base_url=config.get("base_url"),
        on_usage=on_usage,
    ):
        chunks.append(chunk)
    text = "".join(chunks).strip()
    if not text:
        raise RuntimeError("模型未返回有效内容")
    if _LLM_ERROR_MARKER in text:
        raise RuntimeError(text.split(_LLM_ERROR_MARKER, 1)[1].strip() or "调用大模型失败")
    return text


def _extract_json_object(raw: str) -> dict | None:
    """剥离 ```json 围栏后提取首个 JSON 对象；解析失败返回 None。"""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _parse_question(raw: str) -> SeniorQuestionResponse | None:
    """校验模型输出；缺问题或缺选项视为无效。"""
    data = _extract_json_object(raw)
    if data is None:
        return None
    question = str(data.get("question") or "").strip()
    if not question:
        return None
    options: List[str] = []
    for opt in (data.get("options") or []):
        label = str(opt or "").strip()
        if label:
            options.append(label)
    if not options:
        return None
    tip = str(data.get("tip") or "").strip()
    return SeniorQuestionResponse(
        question=question,
        options=options[:6],
        multi=bool(data.get("multi", False)),
        tip=tip,
    )


def _history_text(history: List[SeniorHistoryItem]) -> str:
    if not history:
        return "（还没有问过问题）"
    lines: List[str] = []
    for idx, item in enumerate(history, start=1):
        lines.append(f"{idx}. 问：{item.question.strip()}")
        lines.append(f"   答：{item.answer.strip()}")
    return "\n".join(lines)


def _question_prompt(
    chief_complaint: str,
    history: List[SeniorHistoryItem],
    triage_context: str,
    vision_summary: str = "",
    web_summary: str = "",
    citations: List[Citation] | None = None,
    ext_summary: str = "",
    ext_citations: List[Citation] | None = None,
) -> str:
    sections: List[str] = []
    if triage_context.strip():
        sections.append(f"分诊依据（仅供你参考，不要原样念给患者）：\n{triage_context.strip()}")
    if vision_summary.strip():
        sections.append(
            "患者上传医学图片的辅助观察（仅供你判断病情方向，不要原样念给患者，"
            f"也不要在问题里复述）：\n{vision_summary.strip()}"
        )
    if web_summary.strip():
        marks = _sources_line(citations or [])
        sections.append(
            "最新网络资料摘要（仅供你参考，不要原样念给患者）：\n"
            f"{web_summary.strip()}" + (f"\n来源：{marks}" if marks else "")
        )
    if ext_summary.strip():
        ext_marks = "；".join(f"[{c.id}] {c.title}" for c in (ext_citations or []))
        sections.append(
            "诊疗指南/专家共识摘要（来自本地外部知识源，仅供你参考，不要原样念给患者）：\n"
            f"{ext_summary.strip()}" + (f"\n来源：{ext_marks}" if ext_marks else "")
        )
    extra = ("\n\n" + "\n\n".join(sections)) if sections else ""
    next_index = len(history) + 1
    return (
        f"患者主诉：{chief_complaint.strip()}\n\n"
        f"已经问过的问题和患者的回答：\n{_history_text(history)}{extra}\n\n"
        f"这是第 {next_index} 问（总共约 6 问）。"
        "请结合主诉、已有回答和分诊依据，提出下一个最有价值的问题；"
        "不要重复问过的内容，围绕主诉逐步深入（例如：什么时候开始的、什么情况下加重或减轻、"
        "有没有伴随不舒服、平时的作息饮食、有没有慢性病或在吃药等）。"
        "只输出一个 JSON 对象。"
    )


def _report_prompt(
    chief_complaint: str,
    history: List[SeniorHistoryItem],
    vision_summary: str = "",
    web_summary: str = "",
    citations: List[Citation] | None = None,
    ext_summary: str = "",
    ext_citations: List[Citation] | None = None,
) -> str:
    context_sections: List[str] = []
    if vision_summary.strip():
        context_sections.append(f"患者上传医学图片的辅助观察：\n{vision_summary.strip()}")
    if web_summary.strip():
        evidence = "\n".join(
            f"[{c.id}] {c.title}：{c.snippet}" for c in (citations or []) if (c.snippet or c.title)
        )
        context_sections.append(
            "最新网络资料摘要（只可依据下面列出的来源引用，不得编造引用）：\n"
            f"{web_summary.strip()}" + (f"\n来源清单：\n{evidence}" if evidence else "")
        )
    if ext_summary.strip():
        ext_evidence = "\n".join(
            f"[{c.id}] {c.source}：{c.snippet}" for c in (ext_citations or []) if (c.snippet or c.title)
        )
        context_sections.append(
            "诊疗指南/专家共识摘要（来自本地外部知识源，只可依据下面列出的来源引用，不得编造引用）：\n"
            f"{ext_summary.strip()}" + (f"\n来源清单：\n{ext_evidence}" if ext_evidence else "")
        )
    citation_rules = ""
    if web_summary.strip() or ext_summary.strip():
        citation_rules = "如引用了网络资料或指南共识，请在对应句末用 [编号] 标记来源；没有对应来源的句子不要加编号。"
    context = ("\n\n" + "\n\n".join(context_sections)) if context_sections else ""
    return (
        f"患者主诉：{chief_complaint.strip()}\n\n"
        f"问诊问答记录：\n{_history_text(history)}{context}\n\n"
        f"请据此生成健康总结报告（markdown，按系统提示中的固定结构）。{citation_rules}"
    )


def _sources_appendix(citations: List[Citation]) -> str:
    """报告末尾的参考来源（### 三级标题，不破坏系统提示约定的四个二级标题）。"""
    if not citations:
        return ""
    lines = [f"[{c.id}] [{c.title}]({c.url})" if c.url else f"[{c.id}] {c.title}" for c in citations]
    return "\n\n### 参考来源\n" + "\n".join(lines)


def _merge_citations(base: List[Citation], extra: List[Citation]) -> List[Citation]:
    """web 搜索与外部知识源两路证据合并，统一重编号（web 在前、指南在后）。"""
    merged = base + extra
    for index, citation in enumerate(merged, 1):
        citation.id = index
    return merged


@router.post("/question", response_model=SeniorQuestionResponse)
async def generate_question(
    data: SeniorQuestionRequest,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SeniorQuestionResponse:
    """依据主诉 + 历史问答生成本轮问题（JSON：question/options/multi/tip）。

    图片（VL）、网络搜索与外部知识源均为可选增强：未配置/未启用/失败都不阻断问题生成。
    """
    config = llm_config(db)
    vision_summary = await _vision_summary(db, data.chief_complaint, data.images)
    web_summary, web_citations = await _web_evidence(db, data.chief_complaint, data.history)
    ext_summary, ext_citations = await _external_kb_evidence(
        db, data.chief_complaint, data.history, id_offset=len(web_citations),
    )
    citations = _merge_citations(web_citations, ext_citations)
    prompt = _question_prompt(
        data.chief_complaint, data.history, data.triage_context,
        vision_summary=vision_summary, web_summary=web_summary, citations=web_citations,
        ext_summary=ext_summary, ext_citations=ext_citations,
    )
    try:
        raw = await _complete(config, QUESTION_SYSTEM_PROMPT, prompt)
        parsed = _parse_question(raw)
        if parsed is None:
            # 解析失败重试一次
            logger.warning("长辈模式问题 JSON 首次解析失败，重试：%s", raw[:200])
            raw = await _complete(config, QUESTION_SYSTEM_PROMPT, prompt)
            parsed = _parse_question(raw)
        if parsed is None:
            raise HTTPException(status_code=502, detail="问题生成失败，请稍后重试。")
        return parsed
    except HTTPException:
        raise
    except Exception:
        logger.exception("长辈模式问题生成异常")
        raise HTTPException(status_code=502, detail="问题生成失败，请稍后重试。")


@router.post("/report", response_model=SeniorReportResponse)
async def generate_report(
    data: SeniorReportRequest,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SeniorReportResponse:
    """汇总主诉与全部问答，生成 markdown 健康总结报告（含图片观察与来源标记）。"""
    config = llm_config(db)
    vision_summary = await _vision_summary(db, data.chief_complaint, data.images)
    web_summary, web_citations = await _web_evidence(db, data.chief_complaint, data.history)
    ext_summary, ext_citations = await _external_kb_evidence(
        db, data.chief_complaint, data.history, id_offset=len(web_citations),
    )
    citations = _merge_citations(web_citations, ext_citations)
    prompt = _report_prompt(
        data.chief_complaint, data.history,
        vision_summary=vision_summary, web_summary=web_summary, citations=web_citations,
        ext_summary=ext_summary, ext_citations=ext_citations,
    )
    try:
        report = await _complete(config, REPORT_SYSTEM_PROMPT, prompt)
        # 来源附录在生成后追加（与 chat_v2 参考来源同款式），不依赖模型输出链接
        report = report.strip() + _sources_appendix(citations)
        return SeniorReportResponse(report=report)
    except HTTPException:
        raise
    except Exception:
        logger.exception("长辈模式报告生成异常")
        raise HTTPException(status_code=502, detail="报告生成失败，请稍后重试。")


# ── 流式端点（长辈模式重做）：SSE 思维链 + 逐字题目 + 流式报告 ───────────
# 协议：stage（思维链步骤）→ thinking.delta（模型思考流式）→ question.delta
# （题目逐字，解析 JSON 后由后端匀速推）→ question（完整问题+选项）→
# citations → done；报告同理（report.delta 正文流式 + report 终态）。
import asyncio
import time

from fastapi.responses import StreamingResponse

from services.web_mirror import search_mirror, upsert_mirror_items

MAX_QUESTIONS_SENIOR = 6


# ── 长辈问诊会话（历史分离）：conversations.consultation_mode='senior' ──
class SeniorSessionPayload(BaseModel):
    chief_complaint: str = Field(..., min_length=1)


class SeniorMessagePayload(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str = Field(..., min_length=1, max_length=12000)


@router.post("/sessions", status_code=201)
async def create_senior_session(
    data: SeniorSessionPayload,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """创建长辈问诊会话（consultation_mode='senior'，与普通问诊历史分离）。"""
    title = data.chief_complaint.strip()[:16] or "长辈问诊"
    conversation = create_conversation(db, current_user, title, None, None, "senior")
    return {"id": conversation.id, "title": conversation.title}


@router.post("/sessions/{conversation_id}/messages", status_code=201)
async def save_senior_message(
    conversation_id: int,
    data: SeniorMessagePayload,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """向长辈会话写入一条消息（主诉/答案= user；题目/报告= assistant）。"""
    from models.conversation import Conversation

    conversation = (
        db.query(Conversation)
        .filter(Conversation.id == conversation_id, Conversation.user_id == current_user.id)
        .first()
    )
    if not conversation:
        raise HTTPException(status_code=404, detail="长辈问诊会话不存在")
    message = create_message(db, conversation_id, data.role, data.content)
    return {"id": message.id}


async def _refresh_session_title(db: Session, conversation, config: dict, chief: str) -> None:
    """第一问完成后用 LLM 把会话标题总结成几个字（失败保留截断主诉，不阻断）。"""
    try:
        raw = await complete_llm(
            config,
            "你是会话标题生成器。把患者主诉总结成 6-16 字的中文标题，只输出标题本身，不加标点句号。",
            chief,
            60,
            on_usage=lambda n: add_usage(db, conversation.user_id, "tokens", n),
        )
        clean = raw.strip().strip('“”"。. ')[:40]
        if clean:
            conversation.title = clean
            db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("长辈会话标题生成失败，保留原标题：%s", str(exc)[:120])


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _chunk_text(text: str, size: int = 2):
    for i in range(0, len(text), size):
        yield text[i:i + size]


def _citation_payloads(citations: List[Citation]) -> list[dict]:
    return [{"id": c.id, "source": c.source, "title": c.title, "url": c.url,
             "snippet": c.snippet, "score": c.score} for c in citations]


async def _senior_pipeline_stages(
    db: Session, chief_complaint: str, history: List[SeniorHistoryItem], images: List[str],
):
    """证据管线：VL 观察 → 网络搜索（来源沉淀镜像库）→ 网络镜像检索 → 权威医学库。

    返回 (vision_summary, web_summary, citations, mirror_citations, ext_summary, ext_citations)。
    各路失败均不阻断（与旧端点同口径）；镜像检索排除本次 web 已并入的 URL 防重复。
    """
    queries = _search_queries(chief_complaint, history)
    vision_summary = await _vision_summary(db, chief_complaint, images)
    web_summary, web_citations = await _web_evidence(db, chief_complaint, history)
    upsert_mirror_items(db, queries, web_citations)
    mirror_citations = search_mirror(db, "；".join(queries), 5, {c.url for c in web_citations if c.url})
    citations = list(web_citations)
    for citation in mirror_citations:
        citation.id = len(citations) + 1
        citations.append(citation)
    ext_summary, ext_citations = await _external_kb_evidence(
        db, chief_complaint, history, id_offset=len(citations),
    )
    for citation in ext_citations:
        citation.id = len(citations) + 1
        citations.append(citation)
    return vision_summary, web_summary, citations, mirror_citations, ext_summary, ext_citations


async def _senior_stream_llm(
    config: dict, system_prompt: str, prompt: str,
    events: asyncio.Queue, thinking_queue: asyncio.Queue,
    on_usage=None,
) -> str:
    """长辈模式流式补全：思考增量入 thinking_queue（实时外推用），正文聚合成段后
    整体入 events（"raw", text）。enable_thinking=True：DeepSeek 映射 thinking.type、
    qwen 映射 enable_thinking（stream_llm_response 按平台分发），reasoning_content
    经 on_reasoning 回调实时入队——纯思考阶段 SSE 循环也能轮询外推。
    on_usage：透传 stream_llm_response 的 token 用量回调（每日配额事后计量）。"""
    raw = ""
    try:
        async for chunk in stream_llm_response(
            provider=config["provider"], api_key=config["api_key"], model=config["model"],
            system_prompt=system_prompt,
            messages=[{"role": "user", "content": prompt}],
            base_url=config.get("base_url"),
            enable_thinking=True,
            on_reasoning=lambda t: thinking_queue.put_nowait(t),
            on_usage=on_usage,
        ):
            if _LLM_ERROR_MARKER in chunk:
                raise RuntimeError(chunk.split(_LLM_ERROR_MARKER, 1)[1].strip() or "调用大模型失败")
            raw += chunk
        await events.put(("raw", raw))
    except Exception as exc:  # noqa: BLE001
        await events.put(("error", str(exc)))
    finally:
        await events.put(("done", None))
    return raw


@router.post("/question/stream")
async def generate_question_stream(
    data: SeniorQuestionRequest,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """流式生成下一问：思维链步骤 + 模型思考流式 + 题目逐字 + 完整问题 + 来源。"""
    # 每日配额入口检查（token/图片/搜索，必须在 SSE 开始前抛 429）
    _senior_daily_quota_gate(db, current_user, data.images)
    total_start = time.perf_counter()

    async def generate():
        # token 计量：统计帧用量累计，拿不到时按原始输出字符估算
        usage_total = {"tokens": 0}

        def accumulate_usage(n: int) -> None:
            usage_total["tokens"] += n

        raw_text = ""
        try:
            config = llm_config(db)
            yield _sse("stage", {"id": "understand", "title": "理解病情", "status": "running", "summary": "正在理解您的情况"})
            (vision_summary, web_summary, citations,
             mirror_citations, ext_summary, ext_citations) = await _senior_pipeline_stages(
                db, data.chief_complaint, data.history, data.images,
            )
            web_count = len([c for c in citations if c.source == "web"])
            yield _sse("stage", {"id": "understand", "title": "理解病情", "status": "completed",
                                 "summary": (vision_summary[:80] or "已了解您的情况")})
            yield _sse("stage", {"id": "web", "title": "网络搜索", "status": "completed" if web_summary else "skipped",
                                 "summary": f"查到 {web_count} 条网络来源" if web_summary else "未启用"})
            yield _sse("stage", {"id": "mirror", "title": "网络镜像", "status": "completed" if mirror_citations else "skipped",
                                 "summary": f"找到 {len(mirror_citations)} 条历史来源" if mirror_citations else "暂无相关记录"})
            yield _sse("stage", {"id": "authoritative", "title": "权威医学库", "status": "completed" if ext_citations else "skipped",
                                 "summary": f"命中 {len(ext_citations)} 条指南共识" if ext_citations else "未启用"})
            yield _sse("stage", {"id": "organize", "title": "组织问题", "status": "running", "summary": "正在想怎么问您…"})

            prompt = _question_prompt(
                data.chief_complaint, data.history, data.triage_context,
                vision_summary=vision_summary, web_summary=web_summary, citations=[c for c in citations if c.source == "web"],
                ext_summary=ext_summary, ext_citations=ext_citations,
            )
            thinking_queue: asyncio.Queue = asyncio.Queue()
            events: asyncio.Queue = asyncio.Queue()
            pump_task = asyncio.create_task(
                _senior_stream_llm(config, QUESTION_SYSTEM_PROMPT, prompt, events, thinking_queue, on_usage=accumulate_usage),
            )
            parsed: SeniorQuestionResponse | None = None
            consuming = True
            try:
                while consuming:
                    while not thinking_queue.empty():
                        yield _sse("thinking.delta", {"delta": thinking_queue.get_nowait()})
                    try:
                        kind, payload = await asyncio.wait_for(events.get(), timeout=0.12)
                    except asyncio.TimeoutError:
                        continue
                    if kind == "raw":
                        raw_text = payload
                        parsed = _parse_question(payload)
                        if parsed is None:
                            logger.warning("长辈模式流式问题 JSON 首次解析失败，重试：%s", payload[:200])
                            retry_raw = await _complete(config, QUESTION_SYSTEM_PROMPT, prompt, on_usage=accumulate_usage)
                            raw_text = retry_raw
                            parsed = _parse_question(retry_raw)
                        if parsed is None:
                            raise RuntimeError("问题生成失败，请稍后重试。")
                    elif kind == "error":
                        raise RuntimeError(payload)
                    else:
                        consuming = False
            finally:
                if not pump_task.done():
                    pump_task.cancel()
            while not thinking_queue.empty():
                yield _sse("thinking.delta", {"delta": thinking_queue.get_nowait()})

            yield _sse("stage", {"id": "organize", "title": "组织问题", "status": "completed", "summary": "问题想好了"})
            # 题目逐字推送（右侧大字随 SSE 生长），随后完整问题事件带出选项
            for piece in _chunk_text(parsed.question, 2):
                yield _sse("question.delta", {"delta": piece})
                await asyncio.sleep(0.03)
            yield _sse("question", {
                "question": parsed.question, "options": parsed.options, "multi": parsed.multi,
                "tip": parsed.tip, "number": min(len(data.history) + 1, MAX_QUESTIONS_SENIOR),
                "total": MAX_QUESTIONS_SENIOR,
            })
            # 第一问完成：LLM 把会话标题总结成几个字（历史列表展示用，失败保留截断主诉）
            if not data.history and data.session_id:
                from models.conversation import Conversation
                conversation = (
                    db.query(Conversation)
                    .filter(Conversation.id == data.session_id, Conversation.user_id == current_user.id)
                    .first()
                )
                if conversation:
                    await _refresh_session_title(db, conversation, config, data.chief_complaint)
            yield _sse("citations", {"items": _citation_payloads(citations)})
            # token 事后计量：统计帧优先，拿不到按原始 JSON 输出长度估算（约 1.5 token/字）
            add_usage(db, current_user.id, "tokens", usage_total["tokens"] or int(len(raw_text or "") * 1.5))
            yield _sse("done", {"elapsed_ms": int((time.perf_counter() - total_start) * 1000)})
        except Exception as exc:  # noqa: BLE001
            logger.exception("长辈模式流式问题生成异常")
            # 已消耗的 token 同样计量（add_usage 内部吞错，不影响错误提示）
            add_usage(db, current_user.id, "tokens", usage_total["tokens"])
            yield _sse("error", {"message": f"问题生成失败：{str(exc)[:200]}"})

    return StreamingResponse(generate(), media_type="text/event-stream; charset=utf-8",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/report/stream")
async def generate_report_stream(
    data: SeniorReportRequest,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """流式生成健康报告：思维链 + 思考流式 + report.delta 正文流式 + 来源。"""
    # 每日配额入口检查（token/图片/搜索，必须在 SSE 开始前抛 429）
    _senior_daily_quota_gate(db, current_user, data.images)
    total_start = time.perf_counter()

    async def generate():
        # token 计量：统计帧用量累计，拿不到时按报告正文长度估算
        usage_total = {"tokens": 0}

        def accumulate_usage(n: int) -> None:
            usage_total["tokens"] += n

        try:
            config = llm_config(db)
            yield _sse("stage", {"id": "understand", "title": "汇总病情", "status": "running", "summary": "正在整理您的问答记录"})
            (vision_summary, web_summary, citations,
             mirror_citations, ext_summary, ext_citations) = await _senior_pipeline_stages(
                db, data.chief_complaint, data.history, data.images,
            )
            web_count = len([c for c in citations if c.source == "web"])
            yield _sse("stage", {"id": "understand", "title": "汇总病情", "status": "completed",
                                 "summary": f"整理了 {len(data.history)} 轮问答"})
            yield _sse("stage", {"id": "web", "title": "网络搜索", "status": "completed" if web_summary else "skipped",
                                 "summary": f"查到 {web_count} 条网络来源" if web_summary else "未启用"})
            yield _sse("stage", {"id": "mirror", "title": "网络镜像", "status": "completed" if mirror_citations else "skipped",
                                 "summary": f"找到 {len(mirror_citations)} 条历史来源" if mirror_citations else "暂无相关记录"})
            yield _sse("stage", {"id": "authoritative", "title": "权威医学库", "status": "completed" if ext_citations else "skipped",
                                 "summary": f"命中 {len(ext_citations)} 条指南共识" if ext_citations else "未启用"})
            yield _sse("stage", {"id": "organize", "title": "撰写报告", "status": "running", "summary": "正在为您写健康报告…"})

            prompt = _report_prompt(
                data.chief_complaint, data.history,
                vision_summary=vision_summary, web_summary=web_summary, citations=[c for c in citations if c.source == "web"],
                ext_summary=ext_summary, ext_citations=ext_citations,
            )
            thinking_queue: asyncio.Queue = asyncio.Queue()
            events: asyncio.Queue = asyncio.Queue()
            pump_task = asyncio.create_task(
                _senior_stream_llm(config, REPORT_SYSTEM_PROMPT, prompt, events, thinking_queue, on_usage=accumulate_usage),
            )
            full_report = ""
            consuming = True
            try:
                while consuming:
                    while not thinking_queue.empty():
                        yield _sse("thinking.delta", {"delta": thinking_queue.get_nowait()})
                    try:
                        kind, payload = await asyncio.wait_for(events.get(), timeout=0.12)
                    except asyncio.TimeoutError:
                        continue
                    if kind == "raw":
                        if not payload.strip():
                            raise RuntimeError("模型未返回有效内容")
                        full_report = payload
                        consuming = False
                    elif kind == "error":
                        raise RuntimeError(payload)
                    else:
                        consuming = False
            finally:
                if not pump_task.done():
                    pump_task.cancel()
            while not thinking_queue.empty():
                yield _sse("thinking.delta", {"delta": thinking_queue.get_nowait()})

            yield _sse("stage", {"id": "organize", "title": "撰写报告", "status": "completed", "summary": "报告写好了"})
            # 正文按小块匀速推送（与题目同款节奏），避免一次性大块跳出
            for piece in _chunk_text(full_report.strip(), 24):
                yield _sse("report.delta", {"delta": piece})
                await asyncio.sleep(0.03)
            final_report = full_report.strip() + _sources_appendix(citations)
            yield _sse("report", {"report": final_report})
            yield _sse("citations", {"items": _citation_payloads(citations)})
            # token 事后计量：统计帧优先，拿不到按报告正文长度估算（约 1.5 token/字）
            add_usage(db, current_user.id, "tokens", usage_total["tokens"] or int(len(full_report) * 1.5))
            yield _sse("done", {"elapsed_ms": int((time.perf_counter() - total_start) * 1000)})
        except Exception as exc:  # noqa: BLE001
            logger.exception("长辈模式流式报告生成异常")
            # 已消耗的 token 同样计量（add_usage 内部吞错，不影响错误提示）
            add_usage(db, current_user.id, "tokens", usage_total["tokens"])
            yield _sse("error", {"message": f"报告生成失败：{str(getattr(exc, 'detail', None) or exc)[:200]}"})

    return StreamingResponse(generate(), media_type="text/event-stream; charset=utf-8",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
