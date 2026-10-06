"""
慢性病诊疗方案推荐系统 - FastAPI 应用入口
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware

from core.config import get_settings
from routers import admin, admin_settings_v2, auth, captcha, chat_v2 as chat, external_kb, model_configs, public, patient_profile as patient_router, media, senior
from services.migrations import run_schema_migrations


def create_app() -> FastAPI:
    """构建并返回 FastAPI 应用实例"""

    settings = get_settings()

    app = FastAPI(
        title=settings.APP_NAME,
        description="基于大语言模型的慢性病诊疗方案推荐系统",
        version="1.0.0",
        docs_url="/docs" if settings.DEBUG else None,
        redoc_url="/redoc" if settings.DEBUG else None,
        openapi_url="/openapi.json" if settings.DEBUG else None,
    )

    @app.on_event("startup")
    def migrate_database() -> None:
        run_schema_migrations()

    allowed_origins = [item.strip() for item in settings.CORS_ALLOWED_ORIGINS.split(",") if item.strip()]
    allowed_hosts = [item.strip() for item in settings.ALLOWED_HOSTS.split(",") if item.strip()]

    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts or ["localhost", "127.0.0.1"])
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Permissions-Policy", "camera=(), geolocation=(), payment=()")
        if request.url.path.startswith("/api/auth/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    app.include_router(auth.router)
    app.include_router(captcha.router)  # 登录滑块验证码（无需认证，登录页公开访问）
    app.include_router(public.router)
    app.include_router(chat.router)
    app.include_router(senior.router)
    app.include_router(patient_router.router)
    app.include_router(media.router)
    app.include_router(admin_settings_v2.router)
    app.include_router(model_configs.router)
    app.include_router(external_kb.router)
    app.include_router(admin.router)

    return app


app = create_app()


@app.get("/")
def root():
    """根路径"""
    settings = get_settings()
    return {
        "message": f"欢迎使用{settings.APP_NAME} API",
        "version": "1.0.0",
        "docs": "/docs",
    }


@app.get("/api/health")
def health_check():
    """健康检查接口"""
    settings = get_settings()
    return {
        "status": "healthy",
        "message": f"{settings.APP_NAME} 后端服务运行正常",
        "version": "1.0.0",
    }


def main() -> None:
    """主函数（用于 uv 兼容提示）"""
    print("请使用 'uvicorn main:app --reload' 启动服务器")


if __name__ == "__main__":
    main()
