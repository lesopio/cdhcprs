"""管理员模型多配置接口：/api/admin/model-configs。

- api_key 永不回显（仅 api_key_configured 布尔），入库经 Fernet 加密（services/settings.py 同一套设施）。
- 全部接口需管理员身份（Depends(get_current_admin_user)）。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from core.database import get_db
from schemas.model_config import (
    ModelConfigCreate,
    ModelConfigListResponse,
    ModelConfigResponse,
    ModelConfigUpdate,
)
from services.auth import get_current_admin_user
from services.model_configs import (
    create_config,
    delete_config,
    enable_config,
    get_config,
    is_valid_category,
    list_configs,
    to_response,
    update_config,
)

router = APIRouter(prefix="/api/admin/model-configs", tags=["管理员模型配置"])


@router.get("", response_model=ModelConfigListResponse)
def list_model_configs(
    category: str = Query(..., description="能力分类：llm/search/kb/asr/tts/vl/rerank"),
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """列出某能力的全部配置（分类为空时自动从 system_settings 种子一次）。"""
    if not is_valid_category(category):
        raise HTTPException(status_code=400, detail=f"未知的能力分类：{category}")
    items = [to_response(config) for config in list_configs(db, category)]
    return ModelConfigListResponse(items=items)


@router.post("", response_model=ModelConfigResponse)
def create_model_config(
    data: ModelConfigCreate,
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """新增配置（name + category 必填；api_key 若传则加密入库，不回显）。"""
    config = create_config(
        db,
        category=data.category,
        name=data.name,
        provider=data.provider,
        base_url=data.base_url,
        endpoint=data.endpoint,
        model_id=data.model_id,
        model_name=data.model_name,
        api_key=data.api_key,
        extra=data.extra,
    )
    return to_response(config)


@router.put("/{config_id}", response_model=ModelConfigResponse)
def update_model_config(
    config_id: int,
    data: ModelConfigUpdate,
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """更新配置（api_key 传空串=不改，传新值=覆盖）。"""
    config = get_config(db, config_id)
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")
    config = update_config(db, config, data.model_dump())
    return to_response(config)


@router.delete("/{config_id}")
def delete_model_config(
    config_id: int,
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """删除配置（若删的是启用条，同步清掉 system_settings 的 enabled 键为 false）。"""
    config = get_config(db, config_id)
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")
    delete_config(db, config)
    return {"detail": "ok"}


@router.post("/{config_id}/enable", response_model=ModelConfigResponse)
def enable_model_config(
    config_id: int,
    current_admin=Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """启用该配置：同类别单开，并把该条字段同步写回 system_settings 现有键（兼容层）。"""
    config = get_config(db, config_id)
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")
    config = enable_config(db, config)
    return to_response(config)
