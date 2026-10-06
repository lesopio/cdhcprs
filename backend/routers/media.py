from __future__ import annotations

import hashlib
import logging
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from core.database import get_db
from models.attachment import Attachment
from models.message import Message
from schemas.attachment import AttachmentResponse
from services.auth import get_current_user
from services.chat import get_conversation_by_id
from services.integrations import synthesize_speech, transcribe_audio
from services.settings import get_setting
from services.usage import ensure_quota


router = APIRouter(tags=["私有媒体"])
logger = logging.getLogger("media")
IMAGE_MIMES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


def configured(db: Session, prefix: str) -> dict[str, str]:
    values = {name: (get_setting(db, f"{prefix}_{name}") or "").strip() for name in ("enabled", "base_url", "endpoint", "api_key", "model")}
    # api_key 允许留空：回退借当前主 LLM 密钥（DashScope 同一账号体系，qwen3-tts-flash 实测通用；
    # 与 chat_v2 的 resolved_integration_key 同一约定：集成密钥未单独配置时用 LLM 那套 API）
    if not values["api_key"]:
        values["api_key"] = (get_setting(db, "llm_api_key") or "").strip()
    if values["enabled"] != "true" or not all(values[name] for name in ("base_url", "endpoint", "api_key", "model")):
        raise HTTPException(503, f"{prefix.upper()} 未配置或未启用")
    return values


@router.post("/api/chat/conversations/{conversation_id}/attachments", response_model=AttachmentResponse, status_code=201)
async def upload_attachment(conversation_id: int, file: UploadFile = File(...), analysis_file: UploadFile | None = File(None), current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    conversation = get_conversation_by_id(db, conversation_id, current_user)
    if file.content_type not in IMAGE_MIMES:
        raise HTTPException(415, "仅支持 JPEG、PNG、WebP 图片")
    max_images = int(get_setting(db, "vl_max_images") or "4")
    pending = db.query(Attachment).filter(Attachment.conversation_id == conversation_id, Attachment.user_id == current_user.id, Attachment.message_id.is_(None)).count()
    if pending >= max_images:
        raise HTTPException(400, f"每条消息最多上传 {max_images} 张图片")
    max_bytes = int(get_setting(db, "vl_max_image_mb") or "10") * 1024 * 1024
    content = await file.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise HTTPException(413, f"单张图片不能超过 {max_bytes // 1024 // 1024} MB")
    root = (get_setting(db, "medical_storage_root") or "").strip()
    if not root:
        raise HTTPException(503, "管理员尚未配置医学图片私有存储目录")
    # 每日图片配额：上传即检查并计数（聊天图片的计量点；发送消息时只校验剩余额度不重复计数）
    ensure_quota(db, current_user, "images", 1)
    target_dir = Path(root).expanduser().resolve() / str(current_user.id) / str(conversation_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{uuid.uuid4().hex}{IMAGE_MIMES[file.content_type]}"
    target.write_bytes(content)
    analysis_path = None
    if analysis_file:
        analysis_content = await analysis_file.read(max_bytes + 1)
        if len(analysis_content) <= max_bytes:
            analysis_target = target_dir / f"{target.stem}.analysis{IMAGE_MIMES[file.content_type]}"
            analysis_target.write_bytes(analysis_content)
            analysis_path = str(analysis_target)
    row = Attachment(user_id=current_user.id, conversation_id=conversation_id, patient_profile_id=conversation.patient_profile_id, mime_type=file.content_type, original_name=file.filename or target.name, storage_path=str(target), analysis_path=analysis_path, size_bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/api/attachments/{attachment_id}/content")
def attachment_content(attachment_id: int, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(Attachment).filter(Attachment.id == attachment_id, Attachment.user_id == current_user.id).first()
    if not row or not Path(row.storage_path).is_file():
        raise HTTPException(404, "附件不存在")
    return FileResponse(row.storage_path, media_type=row.mime_type, filename=row.original_name)


@router.delete("/api/attachments/{attachment_id}", status_code=204)
def delete_attachment(attachment_id: int, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(Attachment).filter(Attachment.id == attachment_id, Attachment.user_id == current_user.id).first()
    if not row:
        raise HTTPException(404, "附件不存在")
    if row.message_id is not None:
        raise HTTPException(409, "已发送附件不能单独删除")
    try:
        os.remove(row.storage_path)
    except FileNotFoundError:
        pass
    if row.analysis_path:
        try:
            os.remove(row.analysis_path)
        except FileNotFoundError:
            pass
    db.delete(row)
    db.commit()


@router.post("/api/media/asr")
async def asr(file: UploadFile = File(...), current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    config = configured(db, "asr")
    content = await file.read(25 * 1024 * 1024 + 1)
    if len(content) > 25 * 1024 * 1024:
        raise HTTPException(413, "录音文件过大")
    try:
        text = await transcribe_audio(config["base_url"], config["endpoint"], config["api_key"], config["model"], get_setting(db, "asr_language") or "zh", content, file.filename or "recording.webm", file.content_type or "audio/webm")
    except HTTPException:
        raise
    except Exception as exc:
        # 上游失败返回可读 JSON（detail 为字符串），不能裸 500——前端 toast 直读 detail
        logger.warning("语音转写上游失败：%s", str(exc)[:200])
        raise HTTPException(502, "语音识别服务暂时不可用，请稍后再试或直接打字提问")
    return {"text": text}


@router.get("/api/media/tts/messages/{message_id}")
async def tts(message_id: int, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    message = db.query(Message).filter(Message.id == message_id).first()
    if not message or message.role != "assistant":
        raise HTTPException(404, "助手消息不存在")
    get_conversation_by_id(db, message.conversation_id, current_user)
    config = configured(db, "tts")
    fmt = get_setting(db, "tts_response_format") or "mp3"
    audio, mime = await synthesize_speech(config["base_url"], config["endpoint"], config["api_key"], config["model"], get_setting(db, "tts_voice") or "", fmt, message.content[:6000])
    return Response(audio, media_type=mime, headers={"Cache-Control": "private, no-store"})


class TtsTextRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=6000)


@router.post("/api/media/tts/text")
async def tts_text(data: TtsTextRequest, current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    """任意文本朗读（长辈模式问题卡 / 健康报告用）：纯文本 ≤6000 字，返回音频字节。

    与消息朗读同口径：读启用 tts_* 配置，未配置/未启用 503，复用现有 mime 映射。
    """
    config = configured(db, "tts")
    fmt = get_setting(db, "tts_response_format") or "mp3"
    audio, mime = await synthesize_speech(
        config["base_url"], config["endpoint"], config["api_key"], config["model"],
        get_setting(db, "tts_voice") or "", fmt, data.text.strip()[:6000],
    )
    return Response(audio, media_type=mime, headers={"Cache-Control": "private, no-store"})
