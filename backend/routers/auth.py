"""
用户认证路由
"""
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from core.database import get_db
from schemas.user import UserCreate, UserResponse, Token, UserUpdate
from services.auth import register_user, login_user, get_current_user
from services.settings import get_setting
from core.security import hash_password, password_strength_error
# 滑块验证码与登录限流逻辑收敛在 captcha 路由模块，认证路由只消费结果
from routers.captcha import check_login_rate_limit, consume_captcha_ticket

router = APIRouter(prefix="/api/auth", tags=["认证"])


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_403_FORBIDDEN)
def register(user_data: UserCreate, db: Session = Depends(get_db)):
    """
    用户注册（已关闭）
    """
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="注册功能已关闭，请联系管理员创建账号"
    )


@router.post("/token", response_model=Token)
def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
    captcha_token: Optional[str] = Form(None),
):
    """
    用户登录

    Args:
        request: 请求对象（用于取客户端 IP 做登录限流）
        form_data: OAuth2 表单数据（包含 username 和 password）
        db: 数据库会话
        captcha_token: 滑块验证码一次性票据（管理员开启 captcha_enabled 时必填）

    Returns:
        JWT Token
    """
    # 入口先做 IP 限流：挡住高频爆破，再进入账号级锁定逻辑（login_user 内，保持不动）
    check_login_rate_limit(request)

    # 滑块验证码：system_settings.captcha_enabled == "true" 时必须先通过验证拿一次性票据；
    # 未开启时字段可空，行为与历史版本完全一致
    if get_setting(db, "captcha_enabled") == "true":
        if not consume_captcha_ticket(captcha_token):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="请先完成滑块验证",
            )

    token = login_user(db, form_data.username, form_data.password)
    return token


@router.get("/users/me", response_model=UserResponse)
def get_me(current_user = Depends(get_current_user)):
    """
    获取当前用户信息
    
    Args:
        current_user: 当前登录用户
        
    Returns:
        当前用户信息
    """
    return current_user


@router.put("/users/me/password", response_model=UserResponse)
def update_password(
    password_data: UserUpdate,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    修改当前用户密码
    
    Args:
        password_data: 包含新密码的数据
        current_user: 当前登录用户
        db: 数据库会话
        
    Returns:
        更新后的用户信息
    """
    if not password_data.password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="密码不能为空"
        )

    strength_error = password_strength_error(password_data.password)
    if strength_error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=strength_error)
    
    # 更新密码
    current_user.hashed_password = hash_password(password_data.password)
    current_user.failed_login_attempts = 0
    current_user.locked_until = None
    current_user.last_failed_login_at = None
    db.commit()
    db.refresh(current_user)
    
    return current_user
