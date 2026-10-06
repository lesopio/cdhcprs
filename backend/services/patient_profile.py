"""
患者档案服务模块
"""
import json
import os
from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import select
from models.user import User
from models.patient_profile import PatientProfile
from models.attachment import Attachment
from schemas.patient_profile import (
    PatientProfileCreate,
    PatientProfileUpdate,
    PatientProfileResponse,
    PatientProfileSummary,
)


def _parse_json_list(value, default=None) -> list:
    """解析 JSON 数组文本列；空值/非法 JSON/非数组一律回退默认值。

    与 routers/admin.py 的 parse_json_field 口径一致，避免历史脏数据
    （如纯文本而非 JSON 数组）导致 json.loads 抛异常返回 500。
    """
    if default is None:
        default = []
    if not value:
        return default
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, list) else default
    except Exception:
        return default


def _row_to_response(row: PatientProfile) -> PatientProfileResponse:
    """将 ORM 对象转为响应 Schema（自动解析 JSON 字段）"""
    return PatientProfileResponse(
        id=row.id,
        user_id=row.user_id,
        name=row.name or "",
        gender=row.gender or "",
        age=row.age or "",
        phone=row.phone or "",
        residence=row.residence or "",
        diseases=_parse_json_list(row.diseases),
        symptoms=_parse_json_list(row.symptoms),
        tcm_syndrome=row.tcm_syndrome or "",
        chief_complaint=row.chief_complaint or "",
        family_history=_parse_json_list(row.family_history),
        is_family_member=bool(row.is_family_member),
        primary_member_id=row.primary_member_id,
        is_default=bool(row.is_default),
        constitution=row.constitution or "",
        source_conversation_id=row.source_conversation_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _row_to_summary(row: PatientProfile) -> PatientProfileSummary:
    """将 ORM 对象转为摘要 Schema"""
    return PatientProfileSummary(
        id=row.id,
        name=row.name or "",
        gender=row.gender or "",
        age=row.age or "",
        residence=row.residence or "",
        diseases=_parse_json_list(row.diseases),
        symptoms=_parse_json_list(row.symptoms),
        tcm_syndrome=row.tcm_syndrome or "",
        chief_complaint=row.chief_complaint or "",
        family_history=_parse_json_list(row.family_history),
        is_family_member=bool(row.is_family_member),
        constitution=row.constitution or "",
    )


# ─── CRUD ──────────────────────────────────────────────────────────

def create_profile(
    db: Session,
    user: User,
    data: PatientProfileCreate,
) -> PatientProfileResponse:
    """创建患者档案"""
    profile = PatientProfile(
        user_id=user.id,
        name=data.name or "",
        gender=data.gender or "",
        age=data.age or "",
        phone=data.phone or "",
        residence=data.residence or "",
        diseases=json.dumps(data.diseases, ensure_ascii=False),
        symptoms=json.dumps(data.symptoms, ensure_ascii=False),
        tcm_syndrome=data.tcm_syndrome or "",
        chief_complaint=data.chief_complaint or "",
        family_history=json.dumps(
            [item.model_dump() for item in data.family_history],
            ensure_ascii=False,
        ),
        is_family_member=data.is_family_member,
        primary_member_id=data.primary_member_id,
        is_default=bool(data.is_default),
        constitution=data.constitution or "",
        source_conversation_id=data.source_conversation_id,
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return _row_to_response(profile)


def get_profiles_by_user(
    db: Session,
    user: User,
) -> List[PatientProfileResponse]:
    """获取用户的所有档案（本人 + 家庭成员）"""
    stmt = (
        select(PatientProfile)
        .where(PatientProfile.user_id == user.id)
        .order_by(PatientProfile.is_default.desc(), PatientProfile.created_at.desc())
    )
    rows = db.execute(stmt).scalars().all()
    return [_row_to_response(r) for r in rows]


def get_profile_by_id(
    db: Session,
    profile_id: int,
    user: User,
) -> Optional[PatientProfile]:
    """根据 ID 获取档案 ORM 对象（含权限校验）"""
    stmt = (
        select(PatientProfile)
        .where(PatientProfile.id == profile_id, PatientProfile.user_id == user.id)
    )
    return db.execute(stmt).scalar_one_or_none()


def update_profile(
    db: Session,
    profile: PatientProfile,
    data: PatientProfileUpdate,
) -> PatientProfileResponse:
    """更新档案"""
    update_data = data.model_dump(exclude_none=True)

    # JSON 字段特殊处理
    if "diseases" in update_data:
        profile.diseases = json.dumps(update_data.pop("diseases"), ensure_ascii=False)
    if "symptoms" in update_data:
        profile.symptoms = json.dumps(update_data.pop("symptoms"), ensure_ascii=False)
    if "family_history" in update_data:
        profile.family_history = json.dumps(
            [item.model_dump() if hasattr(item, "model_dump") else item for item in update_data.pop("family_history")],
            ensure_ascii=False,
        )

    for key, value in update_data.items():
        setattr(profile, key, value)

    db.commit()
    db.refresh(profile)
    return _row_to_response(profile)


def delete_profile(
    db: Session,
    profile: PatientProfile,
    user: User,
) -> None:
    """删除档案（级联删除家庭成员）"""
    for attachment in db.query(Attachment).filter(Attachment.patient_profile_id == profile.id).all():
        attachment.patient_profile_id = None
        if attachment.conversation_id is None and attachment.message_id is None:
            try:
                os.remove(attachment.storage_path)
            except FileNotFoundError:
                pass
            db.delete(attachment)

    # 同时删除该档案下的所有家庭成员档案
    db.execute(
        select(PatientProfile).where(
            PatientProfile.primary_member_id == profile.id
        )
    ).scalars().all()
    # SQLAlchemy cascade 处理
    db.delete(profile)
    db.commit()


def get_profile_summary(
    db: Session,
    profile_id: int,
    user: User,
) -> Optional[PatientProfileSummary]:
    """获取档案摘要（用于 prompt）"""
    profile = get_profile_by_id(db, profile_id, user)
    if not profile:
        return None
    return _row_to_summary(profile)


def get_family_members(
    db: Session,
    primary_profile_id: int,
    user: User,
) -> List[PatientProfileResponse]:
    """获取某主档案的所有家庭成员"""
    # 先确认主档案属于该用户
    primary = get_profile_by_id(db, primary_profile_id, user)
    if not primary:
        return []

    stmt = (
        select(PatientProfile)
        .where(
            PatientProfile.primary_member_id == primary_profile_id,
            PatientProfile.user_id == user.id,
        )
        .order_by(PatientProfile.created_at.desc())
    )
    rows = db.execute(stmt).scalars().all()
    return [_row_to_response(r) for r in rows]


def set_default_profile(
    db: Session,
    profile: PatientProfile,
    user: User,
) -> PatientProfileResponse:
    """将某档案设为默认"""
    # 取消其他档案的默认状态
    db.execute(
        select(PatientProfile).where(
            PatientProfile.user_id == user.id,
            PatientProfile.id != profile.id,
        )
    ).scalars().all()
    # 在 Python 侧批量取消
    all_profiles = db.execute(
        select(PatientProfile).where(
            PatientProfile.user_id == user.id,
            PatientProfile.id != profile.id,
        )
    ).scalars().all()
    for p in all_profiles:
        p.is_default = False
    profile.is_default = True
    db.commit()
    db.refresh(profile)
    return _row_to_response(profile)


# ─── Prompt 格式化 ─────────────────────────────────────────────────

def format_profile_for_prompt(summary: PatientProfileSummary) -> str:
    """将档案摘要格式化为 LLM prompt 片段"""
    parts = []

    if summary.name:
        parts.append(f"姓名: {summary.name}")
    if summary.age:
        parts.append(f"年龄: {summary.age}岁")
    if summary.gender:
        label = {"male": "男", "female": "女", "other": "其他"}.get(summary.gender, summary.gender)
        parts.append(f"性别: {label}")
    if summary.residence:
        parts.append(f"现居住地区: {summary.residence}")

    if summary.diseases:
        parts.append(f"疾病史: {', '.join(summary.diseases)}")
    if summary.symptoms:
        parts.append(f"近期症状: {', '.join(summary.symptoms)}")
    if summary.tcm_syndrome:
        parts.append(f"中医证型: {summary.tcm_syndrome}")
    if summary.constitution:
        parts.append(f"中医体质: {summary.constitution}")
    if summary.chief_complaint:
        parts.append(f"主诉: {summary.chief_complaint}")

    if summary.family_history:
        fh_lines = [
            f"{item.get('relation', '?')}: {item.get('disease', '?')}"
            for item in summary.family_history
        ]
        parts.append(f"家族病史: {'; '.join(fh_lines)}")

    if summary.is_family_member:
        parts.append("（家庭成员档案）")

    return "\n".join(parts) if parts else ""
