"""
管理员路由
"""
from typing import Dict, List, Optional
import base64
import json
import os

from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from sqlalchemy.orm import Session

from core.database import get_db
from models.patient_profile import PatientProfile
from models.user import User
from schemas.conversation import ConversationResponse
from schemas.message import MessageResponse
from schemas.settings import (
    ModelListRequest,
    ModelListResponse,
    LogoUploadResponse,
)
from schemas.user import UserCreate, UserResponse, UserUpdate
from services.admin import (
    delete_conversation_by_admin,
    delete_user,
    get_all_conversations,
    get_all_users,
    get_conversation_messages_by_admin,
    update_user_ban_status,
)
from services.auth import get_current_admin_user, register_user
from services.llm import list_llm_models
from services.settings import update_setting
from services.usage import effective_quotas, parse_override_map, today_usage_summary

router = APIRouter(prefix="/api/admin", tags=["管理员"])

# 每日配额 override 允许的键（与 services/usage.QUOTA_KINDS 对应）
QUOTA_KEYS = ("tokens", "images", "web_searches")


# ========== 用户管理 ==========

def _user_response(db: Session, user: User) -> UserResponse:
    """构造用户响应：附带今日用量、生效配额与当前 override（用户列表/更新共用）。"""
    override_raw = parse_override_map(user.quota_override_json)
    quota_override: Optional[Dict[str, Optional[int]]] = (
        {key: override_raw.get(key) for key in QUOTA_KEYS if key in override_raw} or None
    )
    return UserResponse(
        id=user.id,
        username=user.username,
        role=user.role,
        is_banned=user.is_banned,
        created_at=user.created_at,
        quota_override=quota_override,
        today_usage=today_usage_summary(db, user.id),
        effective_quota=effective_quotas(db, user),
    )

@router.post("/users", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    user_data: UserCreate,
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """由管理员创建普通用户；公开注册入口保持关闭。"""
    user = register_user(db, user_data)
    return _user_response(db, user)

@router.get("/users", response_model=List[UserResponse])
def get_users(
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """
    获取所有用户列表（每用户附带今日用量 today_usage 与生效配额 effective_quota，
    配额值 null 表示不限——管理员或显式 -1）

    Args:
        current_admin: 当前管理员
        db: 数据库会话

    Returns:
        用户列表
    """

    users = get_all_users(db)
    return [_user_response(db, user) for user in users]


def _sanitize_quota_override(raw: Optional[Dict[str, Optional[int]]]) -> Optional[str]:
    """清洗并序列化 override：只保留合法键与 int/null 值（布尔不算 int）；全空返回 None。"""
    if raw is None:
        return None
    cleaned: Dict[str, Optional[int]] = {}
    for key in QUOTA_KEYS:
        if key not in raw:
            continue
        value = raw[key]
        if value is None or (isinstance(value, int) and not isinstance(value, bool)):
            cleaned[key] = value
    return json.dumps(cleaned, ensure_ascii=False) if cleaned else None


@router.put("/users/{user_id}", response_model=UserResponse)
def update_user(
    user_id: int,
    user_data: UserUpdate,
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """
    更新用户（封禁/解封、每日配额 override）

    quota_override：{"tokens": int|null, "images": int|null, "web_searches": int|null}，
    值 -1=不限、null/缺键=跟随全局；整体传 null 清除 override。用 model_fields_set
    区分「未提供该字段」与「显式传 null（清除）」。

    Args:
        user_id: 用户 ID
        user_data: 用户更新数据
        current_admin: 当前管理员
        db: 数据库会话

    Returns:
        更新后的用户信息（含今日用量与生效配额）
    """

    if "quota_override" in user_data.model_fields_set:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="用户不存在",
            )
        user.quota_override_json = _sanitize_quota_override(user_data.quota_override)
        db.commit()
        db.refresh(user)
        return _user_response(db, user)

    if user_data.is_banned is not None:
        user = update_user_ban_status(db, user_id, user_data.is_banned)
        return _user_response(db, user)

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="未提供可更新的字段",
    )


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_user(
    user_id: int,
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """
    删除用户

    Args:
        user_id: 用户 ID
        current_admin: 当前管理员
        db: 数据库会话
    """

    delete_user(db, user_id)
    return None


# ========== 全站档案管理 ==========

@router.get("/profiles")
def get_all_profiles(
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """
    获取全站患者档案列表（按创建时间倒序，最多 500 条）

    档案的 diseases/symptoms/family_history 在库中为 JSON 文本，
    这里解析为数组返回；constitution 允许为 None。

    Args:
        current_admin: 当前管理员
        db: 数据库会话

    Returns:
        全站档案列表
    """

    def parse_json_field(value, default):
        if not value:
            return default
        try:
            import json as _json
            parsed = _json.loads(value)
            return parsed if isinstance(parsed, list) else default
        except Exception:
            return default

    profiles = (
        db.query(PatientProfile)
        .order_by(PatientProfile.created_at.desc())
        .limit(500)
        .all()
    )
    return [
        {
            "id": p.id,
            "user_id": p.user_id,
            "name": p.name,
            "gender": p.gender,
            "age": p.age,
            "phone": p.phone or "",
            "residence": p.residence or "",
            "diseases": parse_json_field(p.diseases, []),
            "symptoms": parse_json_field(p.symptoms, []),
            "tcm_syndrome": p.tcm_syndrome or "",
            "chief_complaint": p.chief_complaint or "",
            "family_history": parse_json_field(p.family_history, []),
            "is_family_member": p.is_family_member,
            "is_default": p.is_default,
            "constitution": p.constitution or "",
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p in profiles
    ]


# ========== 对话管理 ==========# ========== 对话管理 ==========

@router.get("/conversations", response_model=List[ConversationResponse])
def get_conversations(
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """
    获取所有对话列表

    Args:
        current_admin: 当前管理员
        db: 数据库会话

    Returns:
        对话列表
    """

    conversations = get_all_conversations(db)
    return conversations


@router.get("/conversations/{conversation_id}/messages", response_model=List[MessageResponse])
def get_conversation_messages(
    conversation_id: int,
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """
    管理员查看指定对话的消息记录

    Args:
        conversation_id: 对话 ID
        current_admin: 当前管理员
        db: 数据库会话

    Returns:
        消息列表
    """

    messages = get_conversation_messages_by_admin(db, conversation_id)
    return messages


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(
    conversation_id: int,
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """
    删除对话

    Args:
        conversation_id: 对话 ID
        current_admin: 当前管理员
        db: 数据库会话
    """

    delete_conversation_by_admin(db, conversation_id)
    return None


# ========== 系统设置 ==========

@router.post("/settings/models", response_model=ModelListResponse)
async def fetch_models(
    request: ModelListRequest,
    current_admin=Depends(get_current_admin_user),
):
    """
    获取指定供应商的可用模型列表

    Args:
        request: 模型列表请求参数
        current_admin: 当前管理员

    Returns:
        模型列表
    """

    success, models, error_message = await list_llm_models(
        request.llm_provider,
        request.llm_api_key,
        request.llm_base_url,
    )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_message,
        )

    return ModelListResponse(models=models)


@router.post("/settings/upload-logo", response_model=LogoUploadResponse)
async def upload_logo(
    file: UploadFile = File(...),
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """
    上传网站 Logo

    Args:
        file: 上传的图片文件
        current_admin: 当前管理员
        db: 数据库会话

    Returns:
        Base64 编码的图片数据
    """

    # 验证文件类型
    allowed_types = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/svg+xml", "image/webp"]
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"不支持的文件类型。允许的类型: {', '.join(allowed_types)}"
        )

    # 验证文件大小 (2MB)
    content = await file.read()
    if len(content) > 2 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="文件大小不能超过 2MB"
        )

    # 转换为 Base64
    base64_data = base64.b64encode(content).decode('utf-8')
    data_url = f"data:{file.content_type};base64,{base64_data}"

    # 保存到数据库
    update_setting(db, "website_logo", data_url)

    return LogoUploadResponse(logo_url=data_url)
