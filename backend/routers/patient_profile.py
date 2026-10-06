"""
患者档案路由 — /api/patient
"""
import json
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from core.database import get_db
from schemas.patient_profile import (
    PatientProfileCreate,
    PatientProfileUpdate,
    PatientProfileResponse,
    PatientProfileSummary,
)
from services.auth import get_current_user
from services.patient_profile import (
    create_profile,
    get_profiles_by_user,
    get_profile_by_id,
    update_profile,
    delete_profile,
    get_family_members,
    set_default_profile,
    format_profile_for_prompt,
    get_profile_summary,
)
from models.patient_profile import PatientProfile

router = APIRouter(prefix="/api/patient", tags=["患者档案"])


@router.get("/profiles", response_model=List[PatientProfileResponse])
def list_profiles(
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取当前用户的所有患者档案（本人 + 家庭成员）"""
    return get_profiles_by_user(db, current_user)


@router.post("/profiles", response_model=PatientProfileResponse, status_code=status.HTTP_201_CREATED)
def create_new_profile(
    profile_data: PatientProfileCreate,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """创建新患者档案"""
    return create_profile(db, current_user, profile_data)


@router.get("/profiles/{profile_id}", response_model=PatientProfileResponse)
def get_profile(
    profile_id: int,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取指定档案详情"""
    profile = get_profile_by_id(db, profile_id, current_user)
    if not profile:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="档案不存在")
    from services.patient_profile import _row_to_response
    return _row_to_response(profile)


@router.put("/profiles/{profile_id}", response_model=PatientProfileResponse)
def update_profile_info(
    profile_id: int,
    profile_data: PatientProfileUpdate,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """更新档案"""
    profile = get_profile_by_id(db, profile_id, current_user)
    if not profile:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="档案不存在")
    return update_profile(db, profile, profile_data)


@router.delete("/profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_profile(
    profile_id: int,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除档案（级联删除家庭成员）"""
    profile = get_profile_by_id(db, profile_id, current_user)
    if not profile:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="档案不存在")
    delete_profile(db, profile, current_user)
    return None


@router.get("/profiles/{profile_id}/family", response_model=List[PatientProfileResponse])
def list_family_members(
    profile_id: int,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取某档案下的所有家庭成员"""
    return get_family_members(db, profile_id, current_user)


@router.post("/profiles/{profile_id}/set-default", response_model=PatientProfileResponse)
def mark_as_default(
    profile_id: int,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """设为默认档案"""
    profile = get_profile_by_id(db, profile_id, current_user)
    if not profile:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="档案不存在")
    return set_default_profile(db, profile, current_user)


@router.get("/profiles/{profile_id}/prompt", response_model=dict)
def get_profile_prompt(
    profile_id: int,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取档案格式化 prompt（含家庭成员病史信息）"""
    # 主档案
    summary = get_profile_summary(db, profile_id, current_user)
    if not summary:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="档案不存在")

    parts = []
    profile_text = format_profile_for_prompt(summary)
    if profile_text:
        parts.append(profile_text)

    # 附加上家庭成员的患病/体质信息
    family = get_family_members(db, profile_id, current_user)
    if family:
        parts.append("家庭成员病史参考：")
        for member in family:
            member_summary = get_profile_summary(db, member.id, current_user)
            if member_summary:
                member_text = format_profile_for_prompt(member_summary)
                if member_text:
                    parts.append(f"  【{member.name}（{member.gender}，{member.age}岁）】")
                    for line in member_text.split("\n"):
                        parts.append(f"    {line}")

    return {"text": "\n".join(parts) if parts else ""}
