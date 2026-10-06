"""网络镜像库服务：搜索结果沉淀（upsert）+ 本地检索（供思维链「网络镜像」步骤）。

定位（用户口径）：镜像库是非权威知识库——网络搜索每次照常执行，结果按 URL
去重沉淀；问诊时用检索词在镜像库中找历史来源作补充证据。写入失败只记日志，
绝不影响问诊主流程。
"""
from __future__ import annotations

import logging
from datetime import datetime
from urllib.parse import urlparse

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from models.web_mirror import WebMirrorItem
from services.agent_pipeline import Citation

logger = logging.getLogger("web_mirror")


def _host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "")[:200]
    except ValueError:
        return ""


def upsert_mirror_items(db: Session, queries: list[str], citations: list[Citation]) -> int:
    """把一次网络搜索的来源沉淀进镜像库（按 URL 去重：旧 URL 命中次数 +1 并刷新摘要/时间）。"""
    if not citations:
        return 0
    now = datetime.utcnow()
    written = 0
    try:
        for c in citations:
            if not c.url:
                continue
            row = db.execute(select(WebMirrorItem).where(WebMirrorItem.url == c.url)).scalar_one_or_none()
            if row:
                row.hit_count += 1
                row.last_seen_at = now
                if c.snippet and len(c.snippet) > len(row.snippet or ""):
                    row.snippet = c.snippet
                if c.title:
                    row.title = c.title
            else:
                db.add(WebMirrorItem(
                    url=c.url,
                    title=c.title or c.url,
                    snippet=c.snippet or "",
                    host=_host_of(c.url),
                    source_query="；".join(queries)[:500],
                    first_seen_at=now,
                    last_seen_at=now,
                ))
            written += 1
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("网络镜像库写入失败（不影响问诊）：%s", str(exc)[:200])
        return 0
    return written


def search_mirror(db: Session, query: str, top_k: int = 5, exclude_urls: set[str] | None = None) -> list[Citation]:
    """检索镜像库：检索词按空格/分号拆分，LIKE 匹配标题与摘要，命中次数优先、
    最近命中加权排序；exclude_urls 排除本次网络搜索已并入的来源（避免证据重复）。"""
    terms = [t for t in re_split(query) if len(t) >= 2]
    if not terms:
        return []
    exclude_urls = exclude_urls or set()
    rows = db.execute(
        select(WebMirrorItem).where(or_(*[
            WebMirrorItem.title.like(f"%{t}%") | WebMirrorItem.snippet.like(f"%{t}%")
            for t in terms
        ])).order_by(WebMirrorItem.hit_count.desc(), WebMirrorItem.last_seen_at.desc()).limit(60)
    ).scalars().all()
    out: list[Citation] = []
    for row in rows:
        if row.url in exclude_urls:
            continue
        out.append(Citation(0, "mirror", row.title or row.url, row.url, (row.snippet or "")[:400], float(row.hit_count)))
        if len(out) >= top_k:
            break
    return out


def re_split(text: str) -> list[str]:
    """检索词切分：中文按字符 bigram，英文/数字按词——简单可靠的 LIKE 友好切法。"""
    import re
    parts = [p.strip() for p in re.split(r"[；;，,、\s]+", text or "") if p.strip()]
    terms: list[str] = []
    for p in parts:
        if re.fullmatch(r"[A-Za-z0-9\-]+", p):
            terms.append(p)
        else:
            # 中文词组直接整体匹配（检索词本身已是短语）
            terms.append(p[:24])
    return terms
