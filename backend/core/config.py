"""
应用配置模块
"""
from pydantic_settings import BaseSettings
from functools import lru_cache
from pathlib import Path

# 项目根目录 .env：基于本文件定位，避免受进程工作目录（CWD）影响
PROJECT_ROOT_ENV_FILE = str(Path(__file__).resolve().parents[2] / ".env")


class Settings(BaseSettings):
    """应用配置类"""

    # 服务器配置
    BACKEND_HOST: str = "127.0.0.1"
    BACKEND_PORT: int = 8001

    # 数据库配置
    DATABASE_URL: str = "sqlite:///./cdhcprs.db"

    # JWT 配置
    SECRET_KEY: str
    SETTINGS_ENCRYPTION_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30

    # Web 安全配置。生产环境应只允许实际站点域名/IP。
    CORS_ALLOWED_ORIGINS: str = "http://127.0.0.1:5173,http://localhost:5173"
    ALLOWED_HOSTS: str = "127.0.0.1,localhost"

    # 应用配置
    APP_NAME: str = "慢性病诊疗方案推荐系统"
    DEBUG: bool = True

    class Config:
        env_file = PROJECT_ROOT_ENV_FILE  # 从项目根目录读取 .env 文件（绝对路径，与 CWD 无关）
        case_sensitive = True
        extra = "ignore"  # 忽略 .env 中未定义的字段（如前端配置）


@lru_cache()
def get_settings() -> Settings:
    """获取配置单例"""
    return Settings()
