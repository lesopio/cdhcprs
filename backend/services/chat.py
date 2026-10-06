"""
对话管理服务模块
"""
from sqlalchemy.orm import Session
from fastapi import HTTPException, status
from typing import Any, List
import json
import os
from models.conversation import Conversation
from models.message import Message
from models.user import User
from models.attachment import Attachment


def create_conversation(
    db: Session,
    user: User,
    title: str,
    patient_profile_id: int | None = None,
    triage: dict[str, Any] | None = None,
    consultation_mode: str = "free",
) -> Conversation:
    """
    创建新对话
    
    Args:
        db: 数据库会话
        user: 用户对象
        title: 对话标题
        
    Returns:
        创建的对话对象
    """
    conversation = Conversation(
        user_id=user.id,
        title=title,
        is_active=True,
        patient_profile_id=patient_profile_id,
        triage_json=json.dumps(triage, ensure_ascii=False) if triage else None,
        consultation_mode=consultation_mode,
    )
    
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    
    # 确保 updated_at 有值（SQLite 有时无法自动填充）
    if conversation.updated_at is None:
        conversation.updated_at = conversation.created_at
        db.commit()
        db.refresh(conversation)
    
    return conversation


def update_conversation_title(db: Session, conversation_id: int, user: User, title: str) -> Conversation:
    """更新当前用户的对话标题"""
    conversation = get_conversation_by_id(db, conversation_id, user)

    conversation.title = title
    db.commit()
    db.refresh(conversation)

    return conversation


def get_user_conversations(db: Session, user: User) -> List[Conversation]:
    """
    获取用户的所有对话
    
    Args:
        db: 数据库会话
        user: 用户对象
        
    Returns:
        对话列表
    """
    conversations = db.query(Conversation)\
        .filter(Conversation.user_id == user.id)\
        .order_by(Conversation.created_at.desc())\
        .all()
    
    return conversations


def get_conversation_by_id(db: Session, conversation_id: int, user: User) -> Conversation:
    """
    根据 ID 获取对话
    
    Args:
        db: 数据库会话
        conversation_id: 对话 ID
        user: 用户对象
        
    Returns:
        对话对象
        
    Raises:
        HTTPException: 对话不存在或无权访问
    """
    conversation = db.query(Conversation)\
        .filter(Conversation.id == conversation_id)\
        .first()
    
    if not conversation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="对话不存在"
        )
    
    if conversation.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="无权访问此对话"
        )
    
    return conversation


def get_conversation_messages(db: Session, conversation_id: int, user: User) -> List[Message]:
    """
    获取对话的所有消息
    
    Args:
        db: 数据库会话
        conversation_id: 对话 ID
        user: 用户对象
        
    Returns:
        消息列表
    """
    # 先验证对话权限
    conversation = get_conversation_by_id(db, conversation_id, user)
    
    messages = db.query(Message)\
        .filter(Message.conversation_id == conversation.id)\
        .order_by(Message.created_at.asc())\
        .all()
    
    return messages


def create_message(db: Session, conversation_id: int, role: str, content: str, **metadata) -> Message:
    """
    创建新消息
    
    Args:
        db: 数据库会话
        conversation_id: 对话 ID
        role: 角色 (user/assistant)
        content: 消息内容
        
    Returns:
        创建的消息对象
    """
    message = Message(
        conversation_id=conversation_id,
        role=role,
        content=content,
        **metadata,
    )
    
    db.add(message)
    db.commit()
    db.refresh(message)
    
    return message


def delete_conversation(db: Session, conversation_id: int, user: User) -> None:
    """
    删除对话

    Args:
        db: 数据库会话
        conversation_id: 对话 ID
        user: 用户对象
    """
    conversation = get_conversation_by_id(db, conversation_id, user)

    attachments = db.query(Attachment).filter(Attachment.conversation_id == conversation_id).all()
    for attachment in attachments:
        if attachment.patient_profile_id:
            attachment.conversation_id = None
            attachment.message_id = None
        else:
            try:
                os.remove(attachment.storage_path)
            except FileNotFoundError:
                pass
            if attachment.analysis_path:
                try:
                    os.remove(attachment.analysis_path)
                except FileNotFoundError:
                    pass
            db.delete(attachment)

    # 显式删除所有关联的消息（确保即使外键约束未生效也能正确删除）
    db.query(Message)\
        .filter(Message.conversation_id == conversation_id)\
        .delete(synchronize_session=False)

    # 删除对话
    db.delete(conversation)
    db.commit()
