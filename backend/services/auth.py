"""
用户认证服务模块
"""
from sqlalchemy.orm import Session
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from typing import Optional
from datetime import datetime, timedelta, timezone
from math import ceil
from models.user import User
from core.security import hash_password, verify_password, create_access_token, decode_access_token, password_strength_error
from core.database import get_db
from schemas.user import UserCreate, Token

# OAuth2 密码流
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")

# 对不存在的用户也执行一次密码校验，降低通过响应耗时枚举账号的风险。
_DUMMY_PASSWORD_HASH = hash_password("not-a-real-account-password")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _lock_minutes(attempts: int) -> int:
    """第三次失败锁 5 分钟，此后依次延长到 10、20、30 分钟。"""
    return min(30, 5 * (2 ** max(0, attempts - 3)))


def register_user(db: Session, user_data: UserCreate) -> User:
    """
    注册新用户
    
    Args:
        db: 数据库会话
        user_data: 用户注册数据
        
    Returns:
        创建的用户对象
        
    Raises:
        HTTPException: 用户名已存在
    """
    strength_error = password_strength_error(user_data.password)
    if strength_error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=strength_error)

    # 检查用户名是否已存在
    existing_user = db.query(User).filter(User.username == user_data.username).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="用户名已存在"
        )
    
    # 创建新用户
    hashed_pwd = hash_password(user_data.password)
    new_user = User(
        username=user_data.username,
        hashed_password=hashed_pwd,
        role="user",
        is_banned=False
    )
    
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    return new_user


def authenticate_user(db: Session, username: str, password: str) -> Optional[User]:
    """
    验证用户凭据
    
    Args:
        db: 数据库会话
        username: 用户名
        password: 密码
        
    Returns:
        用户对象，如果验证失败返回 None
    """
    user = db.query(User).filter(User.username == username).first()
    if not user:
        return None
    
    if not verify_password(password, user.hashed_password):
        return None
    
    return user


def login_user(db: Session, username: str, password: str) -> Token:
    """
    用户登录
    
    Args:
        db: 数据库会话
        username: 用户名
        password: 密码
        
    Returns:
        JWT Token
        
    Raises:
        HTTPException: 认证失败或用户被封禁
    """
    user = db.query(User).filter(User.username == username).first()
    now = _utcnow()

    if not user:
        verify_password(password, _DUMMY_PASSWORD_HASH)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
            headers={"WWW-Authenticate": "Bearer"},
        )

    locked_until = _as_utc(user.locked_until)
    if locked_until and locked_until > now:
        retry_after = max(1, ceil((locked_until - now).total_seconds()))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"密码连续错误次数过多，请在 {ceil(retry_after / 60)} 分钟后重试",
            headers={"Retry-After": str(retry_after)},
        )

    if not verify_password(password, user.hashed_password):
        # 使用原子自增，避免同一账号的并发失败请求互相覆盖计数。
        db.query(User).filter(User.id == user.id).update(
            {
                User.failed_login_attempts: User.failed_login_attempts + 1,
                User.last_failed_login_at: now,
            },
            synchronize_session=False,
        )
        db.commit()
        db.refresh(user)
        if user.failed_login_attempts >= 3:
            minutes = _lock_minutes(user.failed_login_attempts)
            user.locked_until = now + timedelta(minutes=minutes)
            db.commit()
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"密码连续错误次数过多，账号已锁定 {minutes} 分钟",
                headers={"Retry-After": str(minutes * 60)},
            )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    if user.is_banned:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="该账户已被封禁"
        )

    if user.failed_login_attempts or user.locked_until or user.last_failed_login_at:
        user.failed_login_attempts = 0
        user.locked_until = None
        user.last_failed_login_at = None
        db.commit()
    
    # 创建 access token
    access_token = create_access_token(data={"sub": user.username})
    
    return Token(access_token=access_token, token_type="bearer")


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> User:
    """
    获取当前登录用户
    
    Args:
        token: JWT token
        db: 数据库会话
        
    Returns:
        当前用户对象
        
    Raises:
        HTTPException: token 无效或用户不存在
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="无法验证凭据",
        headers={"WWW-Authenticate": "Bearer"},
    )
    
    # 解码 token
    payload = decode_access_token(token)
    if payload is None:
        raise credentials_exception
    
    username: str = payload.get("sub")
    if username is None:
        raise credentials_exception
    
    # 查询用户
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        raise credentials_exception
    
    if user.is_banned:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="该账户已被封禁"
        )
    
    return user


def get_current_admin_user(current_user: User = Depends(get_current_user)) -> User:
    """
    获取当前管理员用户
    
    Args:
        current_user: 当前用户
        
    Returns:
        当前管理员用户对象
        
    Raises:
        HTTPException: 用户不是管理员
    """
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="需要管理员权限"
        )
    
    return current_user
