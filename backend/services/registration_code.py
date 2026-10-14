"""
注册码服务模块
"""
import secrets
import string
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session
from fastapi import HTTPException

from models.registration_code import RegistrationCode
from models.user import User
from core.security import hash_password, password_strength_error

# 12 位注册码：大写字母 + 数字，去掉易混淆字符（O/0/I/1/L）
_CODE_ALPHABET = string.ascii_uppercase + string.digits
_CONFUSABLE = set("O0I1L")
_CODE_ALPHABET = "".join(c for c in _CODE_ALPHABET if c not in _CONFUSABLE)
_CODE_LENGTH = 12


def generate_code() -> str:
    """生成 12 位注册码（ML- 前缀 + 12 位随机字符）"""
    body = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LENGTH))
    return f"ML-{body}"


def create_code(db: Session, created_by: Optional[int] = None, note: Optional[str] = None) -> RegistrationCode:
    """生成一条新注册码（确保唯一）"""
    for _ in range(10):
        code = generate_code()
        existing = db.query(RegistrationCode).filter(RegistrationCode.code == code).first()
        if not existing:
            reg_code = RegistrationCode(
                code=code,
                created_by=created_by,
                note=note,
            )
            db.add(reg_code)
            db.commit()
            db.refresh(reg_code)
            return reg_code
    raise HTTPException(status_code=500, detail="注册码生成失败，请重试")


def get_all_codes(db: Session) -> list[RegistrationCode]:
    """获取全部注册码（按创建时间倒序）"""
    return db.query(RegistrationCode).order_by(RegistrationCode.created_at.desc()).all()


def delete_code(db: Session, code_id: int) -> None:
    """删除注册码（未使用的才允许删除）"""
    reg_code = db.query(RegistrationCode).filter(RegistrationCode.id == code_id).first()
    if not reg_code:
        raise HTTPException(status_code=404, detail="注册码不存在")
    if reg_code.is_used:
        raise HTTPException(status_code=400, detail="注册码已被使用，无法删除")
    db.delete(reg_code)
    db.commit()


def register_with_code(
    db: Session,
    username: str,
    password: str,
    confirm_password: str,
    registration_code: str,
    nickname: Optional[str] = None,
) -> User:
    """
    使用注册码注册新用户

    流程：校验密码一致性 / 强度 → 校验注册码有效性 → 校验用户名唯一 → 创建用户 → 标记注册码已用
    """
    if password != confirm_password:
        raise HTTPException(status_code=400, detail="两次输入的密码不一致")

    strength_error = password_strength_error(password)
    if strength_error:
        raise HTTPException(status_code=400, detail=strength_error)

    # 查注册码
    reg_code = db.query(RegistrationCode).filter(
        RegistrationCode.code == registration_code.strip()
    ).first()
    if not reg_code:
        raise HTTPException(status_code=400, detail="注册码无效")
    if reg_code.is_used:
        raise HTTPException(status_code=400, detail="注册码已被使用")

    # 查用户名唯一
    existing = db.query(User).filter(User.username == username).first()
    if existing:
        raise HTTPException(status_code=400, detail="用户名已存在")

    # 创建用户
    new_user = User(
        username=username,
        hashed_password=hash_password(password),
        role="user",
        is_banned=False,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    # 标记注册码已用
    reg_code.is_used = True
    reg_code.used_by = new_user.id
    reg_code.used_at = datetime.now(timezone.utc)
    db.commit()

    return new_user
