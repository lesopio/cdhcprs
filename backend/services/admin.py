"""
管理员服务模块
"""
from sqlalchemy.orm import Session
from fastapi import HTTPException, status
from typing import List
import os
from models.user import User
from models.conversation import Conversation
from models.message import Message
from models.attachment import Attachment
from services.settings import get_all_settings, update_multiple_settings


def get_all_users(db: Session) -> List[User]:
    """
    获取所有用户
    
    Args:
        db: 数据库会话
        
    Returns:
        用户列表
    """
    users = db.query(User).order_by(User.created_at.desc()).all()
    return users


def update_user_ban_status(db: Session, user_id: int, is_banned: bool) -> User:
    """
    更新用户封禁状态
    
    Args:
        db: 数据库会话
        user_id: 用户 ID
        is_banned: 是否封禁
        
    Returns:
        更新后的用户对象
        
    Raises:
        HTTPException: 用户不存在或不能封禁管理员
    """
    user = db.query(User).filter(User.id == user_id).first()
    
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="用户不存在"
        )
    
    if user.role == "admin":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="不能封禁管理员账户"
        )
    
    user.is_banned = is_banned
    db.commit()
    db.refresh(user)
    
    return user


def delete_user(db: Session, user_id: int) -> None:
    """
    删除用户
    
    Args:
        db: 数据库会话
        user_id: 用户 ID
        
    Raises:
        HTTPException: 用户不存在或不能删除管理员
    """
    user = db.query(User).filter(User.id == user_id).first()
    
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="用户不存在"
        )
    
    if user.role == "admin":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="不能删除管理员账户"
        )
    
    db.delete(user)
    db.commit()


def get_all_conversations(db: Session) -> List[Conversation]:
    """
    获取所有对话
    
    Args:
        db: 数据库会话
        
    Returns:
        对话列表
    """
    conversations = db.query(Conversation)\
        .order_by(Conversation.created_at.desc())\
        .all()
    
    return conversations


def get_conversation_messages_by_admin(db: Session, conversation_id: int) -> List[Message]:
    """
    管理员获取指定对话的全部消息

    Args:
        db: 数据库会话
        conversation_id: 对话 ID

    Returns:
        消息列表

    Raises:
        HTTPException: 对话不存在
    """

    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()

    if not conversation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="对话不存在",
        )

    messages = (
        db.query(Message)
        .filter(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
        .all()
    )

    return messages


def delete_conversation_by_admin(db: Session, conversation_id: int) -> None:
    """
    管理员删除对话

    Args:
        db: 数据库会话
        conversation_id: 对话 ID

    Raises:
        HTTPException: 对话不存在
    """
    conversation = db.query(Conversation)\
        .filter(Conversation.id == conversation_id)\
        .first()

    if not conversation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="对话不存在"
        )

    # 显式删除所有关联的消息（确保即使外键约束未生效也能正确删除）
    for attachment in db.query(Attachment).filter(Attachment.conversation_id == conversation_id).all():
        if attachment.patient_profile_id:
            attachment.conversation_id = None
            attachment.message_id = None
        else:
            for path in (attachment.storage_path, attachment.analysis_path):
                if path:
                    try:
                        os.remove(path)
                    except FileNotFoundError:
                        pass
            db.delete(attachment)

    db.query(Message)\
        .filter(Message.conversation_id == conversation_id)\
        .delete(synchronize_session=False)

    # 删除对话
    db.delete(conversation)
    db.commit()


def disable_all_conversations(db: Session) -> None:
    """
    禁用所有历史对话（模型切换时调用）
    
    Args:
        db: 数据库会话
    """
    db.query(Conversation).update({"is_active": False})
    db.commit()


def update_system_settings_with_model_check(
    db: Session,
    settings_dict: dict
) -> None:
    """
    更新系统设置，如果模型配置发生变化则禁用所有对话
    
    Args:
        db: 数据库会话
        settings_dict: 设置字典
    """
    model_keys = {"llm_provider", "llm_api_key", "llm_model_id", "llm_model_name", "llm_base_url"}
    relevant_updates = {k: v for k, v in settings_dict.items() if k in model_keys and v is not None}
    model_changed = False

    if relevant_updates:
        current_settings = get_all_settings(db)
        model_changed = any(current_settings.get(k) != v for k, v in relevant_updates.items())

    update_multiple_settings(db, settings_dict)

    if model_changed:
        disable_all_conversations(db)
