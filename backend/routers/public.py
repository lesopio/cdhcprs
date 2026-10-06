"""
公共路由（无需认证）
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from core.database import get_db
from schemas.settings import PublicSettings
from services.settings import get_setting

router = APIRouter(prefix="/api/public", tags=["公共接口"])


class PublicSettingsWithCaptcha(PublicSettings):
    """公共设置 + 登录滑块验证码能力位。

    为什么不动 schemas/settings.py：该文件由多个功能共用，路由侧新增展示字段
    在本地子类扩展即可（同 admin_settings_v2.py 的 BorrowKey* 请求体先例）。
    """
    captcha_available: bool = False


@router.get("/settings", response_model=PublicSettingsWithCaptcha)
def get_public_settings(db: Session = Depends(get_db)):
    """
    获取公共设置（网站名称、Logo 等）
    
    Args:
        db: 数据库会话
        
    Returns:
        公共设置信息
    """
    website_name = get_setting(db, "website_name") or "慢性病诊疗方案推荐系统"
    website_logo = get_setting(db, "website_logo") or ""
    large_font_scale = float(get_setting(db, "large_font_scale") or "1.5")
    extra_large_font_scale = float(get_setting(db, "extra_large_font_scale") or "1.85")

    def available(prefix: str) -> bool:
        # api_key 允许留空：TTS/ASR 等集成的密钥未单独配置时回退借主 LLM key
        # （与 routers/media.py configured() 同一约定），能力位与实际调用口径一致
        has_key = (get_setting(db, f"{prefix}_api_key") or "").strip() or (get_setting(db, "llm_api_key") or "").strip()
        return get_setting(db, f"{prefix}_enabled") == "true" and bool(has_key) and all((get_setting(db, f"{prefix}_{key}") or "").strip() for key in ("base_url", "endpoint", "model"))

    return PublicSettingsWithCaptcha(
        website_name=website_name,
        website_logo=website_logo,
        large_font_scale=large_font_scale,
        extra_large_font_scale=extra_large_font_scale,
        asr_available=available("asr"),
        tts_available=available("tts"),
        vl_available=available("vl"),
        asr_max_seconds=int(get_setting(db, "asr_max_seconds") or "60"),
        vl_max_images=int(get_setting(db, "vl_max_images") or "4"),
        vl_max_image_mb=int(get_setting(db, "vl_max_image_mb") or "10"),
        # 登录页据此决定是否渲染滑块验证码组件（与管理端开关同一存储键）
        captcha_available=get_setting(db, "captcha_enabled") == "true",
    )
