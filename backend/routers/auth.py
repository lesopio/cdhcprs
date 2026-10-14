"""
用户认证路由
"""
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from core.database import get_db
from schemas.user import UserCreate, UserResponse, Token, UserUpdate
from schemas.registration_code import RegisterWithCodeRequest
from services.auth import register_user, login_user, get_current_user
from services.settings import get_setting
from services.registration_code import register_with_code
from core.security import hash_password, password_strength_error, create_access_token
from services import turnstile
from routers.captcha import check_login_rate_limit

router = APIRouter(prefix="/api/auth", tags=["认证"])


@router.post("/register", response_model=Token)
def register(
    payload: RegisterWithCodeRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """
    用户注册（需注册码 + CF Turnstile）

    注册成功后直接返回 JWT Token（前端拿到即登录，无需再跳登录页）
    """
    # CF Turnstile 验证
    if turnstile.configured():
        turnstile.verify_register(payload.captcha_token)

    # 注册码校验 + 创建用户
    new_user = register_with_code(
        db,
        username=payload.username,
        password=payload.password,
        confirm_password=payload.confirm_password,
        registration_code=payload.registration_code,
        nickname=payload.nickname,
    )

    # 注册成功即登录：返回 Token
    access_token = create_access_token(data={"sub": new_user.username})
    return Token(access_token=access_token, token_type="bearer")


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
        captcha_token: CF Turnstile token（turnstile 已配置时必填）

    Returns:
        JWT Token
    """
    # 入口先做 IP 限流：挡住高频爆破，再进入账号级锁定逻辑（login_user 内，保持不动）
    check_login_rate_limit(request)

    # CF Turnstile 验证：环境变量配置了 site/secret key 时启用，前端登录页通过
    # /api/public/settings.turnstile 拿 siteKey 渲染 widget；
    # 未配置时字段可空，行为与无验证码完全一致
    if turnstile.configured():
        turnstile.verify_login(captcha_token)

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
