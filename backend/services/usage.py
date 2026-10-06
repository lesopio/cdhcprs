"""用户每日配额与用量计量服务。

三类资源（kind）：
- tokens       每日 token 总量（默认 50 万，system_settings 键 quota_tokens_day）
- images       每日图片张数（默认 50，键 quota_images_day）
- web_searches 每日网络搜索次数（默认 50，键 quota_websearch_day）

配额生效优先级：管理员(role=admin) 完全不限 → 用户 override（users.quota_override_json，
-1=不限、null/缺键=跟随全局）→ system_settings 全局值（-1 视为不限）。

计量约定（SSE 场景检查必须在流开始前，流中再抛 429 已无意义）：
- ensure_quota：动作发生前的配额检查，超额抛 429「今日XX额度已用完…」；
  increment=True（默认）时同时计数（图片上传、网络搜索的计量点）；
  increment=False 仅校验剩余额度（token 入口检查、聊天图片发送时防降额绕过）。
- add_usage：事后累加（流式 token 在流结束后按统计帧实际值或字符估算补记），
  失败仅记日志不影响主流程。
"""
from __future__ import annotations

import json
import logging
from datetime import date
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from models.user import User
from models.user_daily_usage import UserDailyUsage
from services.settings import get_setting

logger = logging.getLogger(__name__)

# kind → (全局配额设置键, 默认值, user_daily_usage 列名, 用户可读名称)
KIND_META: dict[str, tuple[str, int, str, str]] = {
    "tokens": ("quota_tokens_day", 500000, "tokens", "token"),
    "images": ("quota_images_day", 50, "images", "图片"),
    "web_searches": ("quota_websearch_day", 50, "web_searches", "网络搜索"),
}

QUOTA_KINDS = ("tokens", "images", "web_searches")

QUOTA_UNLIMITED = -1  # override / 全局配置值 -1 表示不限


def parse_override_map(raw: Optional[str]) -> dict:
    """解析 users.quota_override_json；空值或损坏数据一律视为无 override。"""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def get_quota(db: Session, user: User, kind: str) -> Optional[int]:
    """读取生效配额：None=不限；否则为每日上限（0 表示当日禁用）。"""
    if kind not in KIND_META:
        raise ValueError(f"未知配额种类: {kind}")
    if getattr(user, "role", None) == "admin":
        return None  # 管理员完全不限
    override = parse_override_map(getattr(user, "quota_override_json", None)).get(kind)
    if override is not None:
        try:
            override = int(override)
        except (TypeError, ValueError):
            override = None
    if override is not None:
        return None if override == QUOTA_UNLIMITED else override
    setting_key, default, _, _ = KIND_META[kind]
    raw = (get_setting(db, setting_key) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return None if value == QUOTA_UNLIMITED else value


def used_today(db: Session, user_id: int, kind: str) -> int:
    """读取某用户当日在某资源上的已用量。"""
    if kind not in KIND_META:
        raise ValueError(f"未知配额种类: {kind}")
    row = (
        db.query(UserDailyUsage)
        .filter(UserDailyUsage.user_id == user_id, UserDailyUsage.date == date.today())
        .first()
    )
    if not row:
        return 0
    return int(getattr(row, KIND_META[kind][2]) or 0)


def today_usage_summary(db: Session, user_id: int) -> dict:
    """当日三类资源用量汇总（管理台展示用）。"""
    row = (
        db.query(UserDailyUsage)
        .filter(UserDailyUsage.user_id == user_id, UserDailyUsage.date == date.today())
        .first()
    )
    if not row:
        return {"tokens": 0, "images": 0, "web_searches": 0}
    return {
        "tokens": int(row.tokens or 0),
        "images": int(row.images or 0),
        "web_searches": int(row.web_searches or 0),
    }


def effective_quotas(db: Session, user: User) -> dict:
    """三类资源的生效配额（None=不限），管理台展示用。"""
    return {kind: get_quota(db, user, kind) for kind in QUOTA_KINDS}


def _bump(db: Session, user_id: int, kind: str, n: int) -> None:
    """当日计数原子累加：不存在则插入（本资源计 n、其余 0），存在则按列累加。"""
    column = KIND_META[kind][2]
    table = UserDailyUsage.__table__
    values: dict = {"tokens": 0, "images": 0, "web_searches": 0}
    values[column] = int(n)
    stmt = sqlite_insert(table).values(
        user_id=user_id, date=date.today(), updated_at=func.now(), **values
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["user_id", "date"],
        set_={column: table.c[column] + stmt.excluded[column], "updated_at": func.now()},
    )
    db.execute(stmt)
    db.commit()


def ensure_quota(db: Session, user: User, kind: str, n: int = 1, increment: bool = True) -> None:
    """流开始前的配额检查：当日已用 + n 超过生效配额时抛 429。

    increment=True 时检查通过即计数（图片/搜索的计量点）；
    increment=False 仅校验不计数（token 入口检查、发送消息时的图片剩余额度校验——
    聊天图片已在 media.upload_attachment 上传时计量，避免重复计数）。
    """
    quota = get_quota(db, user, kind)
    if quota is None:
        return  # 不限（管理员或显式 -1）
    count = max(int(n), 0)
    if used_today(db, user.id, kind) + count > quota:
        label = KIND_META[kind][3]
        raise HTTPException(status_code=429, detail=f"今日{label}额度已用完，明天再来或联系管理员")
    if increment and count > 0:
        _bump(db, user.id, kind, count)


def add_usage(db: Session, user_id: int, kind: str, n: int) -> None:
    """事后计量累加（流式 token 完成后调用）；失败仅记日志，不影响主流程。"""
    if not n or n <= 0:
        return
    try:
        _bump(db, user_id, kind, int(n))
    except Exception as exc:  # noqa: BLE001
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        logger.warning("每日用量计量失败 user_id=%s kind=%s n=%s: %s", user_id, kind, n, str(exc)[:160])
