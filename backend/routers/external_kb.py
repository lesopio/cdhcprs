"""外部知识源（独立诊疗指南库服务）接入层。

独立服务与主系统完全分离（独立目录 / venv / SQLite / 进程，默认端口 8900，
数据源 本地语料目录：126 PDF 诊疗指南/专家共识 + 109 CAJ 仅录元数据），
对主系统暴露两个 HTTP 接口：
- GET /search?q=<检索词>&top_k=<n>  → 指南共识片段检索（chat_v2 / senior 证据阶段调用）
- GET /stats                        → 索引统计（documents / blocks / caj_skipped / indexed_at）

本路由只做三件事：
1. load_external_kb_config：三个 system_settings 键的统一读取（缺省兜底，供
   chat_v2 / senior 直接 get_setting 同口径消费）——
   external_kb_enabled（'false'）/ external_kb_url（'http://127.0.0.1:8900'）/
   external_kb_top_k（'4'）。
2. search_external_kb：/search 的共享取数与条目解析（8s 超时），返回 Citation 列表；
   source 统一标注「外部知识源·疾病·标题」，url 留空，snippet 剥掉【】标记符（保留命中词）。
   异常不在本函数内吞掉，由调用方决定「失败跳过不阻断」的表现形式。
3. /api/admin/external-kb/settings 与 /api/admin/external-kb/stats：
   管理端「系统设置 → 外部知识源」区块的配置读写与服务检测。检测走后端 httpx
   代理转发 /stats（8s 超时），避免浏览器跨域直连独立服务；服务不可达时返回
   reachable=false 与原因，不抛 500。

注意：与既有 knowledge_base 检索完全并列、互不影响——本文件不读写 knowledge_base
的任何配置，也不改动 chat_v2 / senior 既有检索逻辑，仅新增独立分支。
"""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from core.database import get_db
from services.agent_pipeline import Citation
from services.auth import get_current_admin_user
from services.settings import get_setting, update_multiple_settings

router = APIRouter(prefix="/api/admin", tags=["外部知识源"])

EXTERNAL_KB_ENABLED_KEY = "external_kb_enabled"
EXTERNAL_KB_URL_KEY = "external_kb_url"
EXTERNAL_KB_TOP_K_KEY = "external_kb_top_k"
DEFAULT_EXTERNAL_KB_URL = "http://127.0.0.1:8900"
DEFAULT_EXTERNAL_KB_TOP_K = 4
EXTERNAL_KB_TIMEOUT_SECONDS = 8

# 独立服务在 snippet 中用【】包裹的是检索命中词本身（paper-knowledge-service
# /app/search.py make_snippet 统一给命中片段加【】标记，并非区块标签），
# 注入证据文本前只剥标记符、保留命中词内容
_BRACKET_MARK_RE = re.compile(r"[【】]")


def clamp_top_k(value) -> int:
    """检索条数收敛到 1-10（Admin 表单与运行时同口径）。"""
    try:
        top_k = int(value)
    except (TypeError, ValueError):
        return DEFAULT_EXTERNAL_KB_TOP_K
    return max(1, min(10, top_k))


def load_external_kb_config(db: Session) -> Tuple[bool, str, int]:
    """读取外部知识源三项配置（缺省兜底）；base_url 去尾斜杠。"""
    enabled = (get_setting(db, EXTERNAL_KB_ENABLED_KEY) or "false").strip() == "true"
    base_url = (get_setting(db, EXTERNAL_KB_URL_KEY) or "").strip().rstrip("/") or DEFAULT_EXTERNAL_KB_URL
    top_k = clamp_top_k(get_setting(db, EXTERNAL_KB_TOP_K_KEY) or DEFAULT_EXTERNAL_KB_TOP_K)
    return enabled, base_url, top_k


def clean_external_snippet(text: str) -> str:
    """剥掉【】标记符（保留其中的命中词）并压缩空白，得到可直接注入证据摘要的片段。"""
    cleaned = _BRACKET_MARK_RE.sub("", text or "")
    return re.sub(r"\s+", " ", cleaned).strip()


def _parse_search_item(item: dict) -> Tuple[str, str, str]:
    """兼容字段命名：疾病（disease/disease_name）、标题（title/doc）、片段（snippet/text/content）。"""
    disease = str(item.get("disease") or item.get("disease_name") or "").strip()
    title = str(item.get("title") or item.get("doc") or "").strip()
    snippet = clean_external_snippet(str(item.get("snippet") or item.get("text") or item.get("content") or ""))
    return disease, title, snippet


async def search_external_kb(base_url: str, query: str, top_k: int) -> List[Citation]:
    """GET {base_url}/search?q=<query>&top_k=<n>，返回独立 citations。

    source 固定「外部知识源·疾病·标题」（疾病/标题缺一个就去掉对应段）、url 留空、
    snippet 剥【】标记符保留命中词；score 仅在服务端返回数值时携带。响应缺 results/items 数组、
    HTTP 非 2xx、连接失败等一律抛异常，由调用方兜底（chat_v2 记 trace failed、
    senior 记 warning），保证「失败跳过不阻断问诊」。
    """
    endpoint = f"{(base_url or '').strip().rstrip('/')}/search"
    async with httpx.AsyncClient(timeout=EXTERNAL_KB_TIMEOUT_SECONDS) as client:
        response = await client.get(endpoint, params={"q": query, "top_k": clamp_top_k(top_k)})
        response.raise_for_status()
        data = response.json()
    items = None
    if isinstance(data, dict):
        raw = data.get("results")
        items = raw if isinstance(raw, list) else data.get("items")
    if not isinstance(items, list):
        raise RuntimeError("外部知识源响应缺少 results/items 数组")
    citations: List[Citation] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        disease, title, snippet = _parse_search_item(item)
        if not title and not snippet:
            continue
        # source 是前端引用列表的分组键：固定 authoritative（权威医学库分组），
        # 疾病信息并入标题保留溯源（与网络来源的 web/mirror 非权威分组相区分）
        display_title = title or (f"{disease}指南条目" if disease else "权威医学库条目")
        if disease and disease not in display_title:
            display_title = f"{disease}·{display_title}"
        score = item.get("score")
        citations.append(Citation(
            len(citations) + 1,
            "authoritative",
            display_title,
            "",
            snippet,
            score if isinstance(score, (int, float)) else None,
        ))
        if len(citations) >= clamp_top_k(top_k):
            break
    return citations


# ===== 管理端：系统设置 → 外部知识源 区块 =====

class ExternalKbSettingsUpdate(BaseModel):
    enabled: str = Field(pattern="^(true|false)$")
    url: str = ""
    top_k: int = Field(ge=1, le=10)


def _settings_payload(db: Session) -> dict:
    enabled, base_url, top_k = load_external_kb_config(db)
    return {"enabled": "true" if enabled else "false", "url": base_url, "top_k": top_k}


@router.get("/external-kb/settings")
def get_external_kb_settings(current_admin=Depends(get_current_admin_user), db: Session = Depends(get_db)):
    """三项配置（未保存过时返回缺省值，前端表单直接回填）。"""
    return _settings_payload(db)


@router.put("/external-kb/settings")
def update_external_kb_settings(
    data: ExternalKbSettingsUpdate,
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """保存三项配置到 system_settings（任意键值可存，无需改设置主接口）。"""
    update_multiple_settings(db, {
        EXTERNAL_KB_ENABLED_KEY: data.enabled,
        EXTERNAL_KB_URL_KEY: data.url.strip() or DEFAULT_EXTERNAL_KB_URL,
        EXTERNAL_KB_TOP_K_KEY: str(clamp_top_k(data.top_k)),
    })
    return _settings_payload(db)


@router.get("/external-kb/stats")
async def external_kb_stats(
    url: Optional[str] = None,
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """后端代理转发独立服务 /stats（8s 超时），规避浏览器跨域直连。

    url 参数优先用表单当前值（未保存也可检测），缺省回落到已保存配置。
    返回 {reachable, documents, blocks, caj_skipped, indexed_at}；不可达时
    reachable=false 并附 error 原因，不抛 500。
    """
    target = (url or "").strip().rstrip("/") or load_external_kb_config(db)[1]
    try:
        async with httpx.AsyncClient(timeout=EXTERNAL_KB_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{target}/stats")
            response.raise_for_status()
            payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError("响应格式不正确")
        return {
            "reachable": True,
            "documents": payload.get("documents"),
            "blocks": payload.get("blocks"),
            "caj_skipped": payload.get("caj_skipped"),
            "indexed_at": payload.get("indexed_at"),
        }
    except Exception as exc:
        return {
            "reachable": False,
            "documents": None,
            "blocks": None,
            "caj_skipped": None,
            "indexed_at": None,
            "error": str(exc)[:180],
        }
