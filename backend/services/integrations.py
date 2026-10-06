from __future__ import annotations

import base64
import io
import os
import struct
import wave
from pathlib import Path
from typing import Any

import httpx


def integration_url(base_url: str, endpoint: str) -> str:
    if not base_url.strip():
        raise RuntimeError("未配置 Base URL")
    return f"{base_url.rstrip('/')}/{endpoint.lstrip('/')}"


def auth_headers(api_key: str) -> dict[str, str]:
    if not api_key:
        raise RuntimeError("未配置 API Key")
    return {"Authorization": f"Bearer {api_key}"}


def silent_wav() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(struct.pack("<h", 0) * 3200)
    return output.getvalue()


async def transcribe_audio(base_url: str, endpoint: str, api_key: str, model: str, language: str, content: bytes, filename: str, content_type: str) -> str:
    """语音转写，按端点自动切协议：
    - endpoint 含 /chat/completions：多模态 chat 转写（qwen3-omni-flash 实测 200）——
      音频 base64 作 input_audio 传入，模型输出即转写文本（DashScope compatible-mode
      不开放 /audio/transcriptions，实测 404，omni chat 是可用替代）。
    - 其余走 OpenAI 兼容 /audio/transcriptions 文件上传。"""
    if "/chat/completions" in endpoint:
        b64 = base64.b64encode(content).decode('ascii')
        fmt = (filename.rsplit('.', 1)[-1] or 'wav').lower()
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                integration_url(base_url, endpoint),
                headers={**auth_headers(api_key), "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": [
                        {"type": "input_audio", "input_audio": {"data": f"data:{content_type or 'audio/wav'};base64,{b64}", "format": fmt}},
                        {"type": "text", "text": "请逐字转写这段音频的内容，只输出转写文本，不要解释。"},
                    ]}],
                    "modalities": ["text"],
                    "stream": False,
                },
            )
            response.raise_for_status()
            data = response.json()
        text = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        if not text:
            raise RuntimeError("语音识别未返回文本")
        return text
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(
            integration_url(base_url, endpoint), headers=auth_headers(api_key),
            data={"model": model, "language": language},
            files={"file": (filename, content, content_type)},
        )
        response.raise_for_status()
        data = response.json()
    text = str(data.get("text") or "").strip()
    if not text:
        raise RuntimeError("ASR 未返回转写文本")
    return text


async def synthesize_speech(base_url: str, endpoint: str, api_key: str, model: str, voice: str, response_format: str, text: str) -> tuple[bytes, str]:
    """语音合成，按端点自动切协议：
    - DashScope 原生 Qwen-TTS（endpoint 含 multimodal-generation，qwen3-tts-flash 实测 200）：
      {model, input:{text, voice}} → output.audio.data（b64 WAV）或 output.audio.url（24h OSS），强制 WAV。
      qwen-audio-3.1-tts-flash 属 Audiogen 系（需参考音频 URL，标准格式 400），不适用朗读场景。
    - 其余端点走 OpenAI 兼容 /audio/speech 二进制音频。"""
    url = integration_url(base_url, endpoint)
    async with httpx.AsyncClient(timeout=90) as client:
        if "multimodal-generation" in url:
            payload: dict[str, Any] = {"model": model, "input": {"text": text[:600]}}
            if voice:
                payload["input"]["voice"] = voice
            response = await client.post(url, headers={**auth_headers(api_key), "Content-Type": "application/json"}, json=payload)
            response.raise_for_status()
            audio = ((response.json().get("output") or {}).get("audio")) or {}
            if audio.get("data"):
                return base64.b64decode(audio["data"]), "audio/wav"
            if audio.get("url"):
                audio_resp = await client.get(audio["url"])
                audio_resp.raise_for_status()
                return audio_resp.content, "audio/wav"
            raise RuntimeError("TTS 未返回音频")
        response = await client.post(
            url, headers={**auth_headers(api_key), "Content-Type": "application/json"},
            json={"model": model, "voice": voice, "input": text, "response_format": response_format},
        )
        response.raise_for_status()
    mime = {"mp3": "audio/mpeg", "wav": "audio/wav", "opus": "audio/ogg", "aac": "audio/aac", "flac": "audio/flac"}.get(response_format, "application/octet-stream")
    return response.content, mime


async def rerank_documents(base_url: str, endpoint: str, api_key: str, model: str, query: str, documents: list[str], top_n: int) -> list[int]:
    """重排：endpoint 为空时默认 OpenAI 风格 /v1/rerank；
    endpoint 配置为完整 URL（含 /services/rerank 等路径）或 base_url 指向 dashscope 原生域时，
    自动切 DashScope 原生格式（实测 gte-rerank-v2 200：{"input":{query,documents},"parameters":{top_n}}
    → {"output":{"results":[{index,relevance_score}]}}）。"""
    if not documents:
        return []
    full_url = integration_url(base_url, endpoint)
    dashscope_native = "dashscope.aliyuncs.com" in full_url or "/services/rerank" in full_url
    async with httpx.AsyncClient(timeout=45) as client:
        if dashscope_native:
            payload = {
                "model": model,
                "input": {"query": query, "documents": documents},
                "parameters": {"return_documents": False, "top_n": top_n},
            }
        else:
            payload = {"model": model, "query": query, "documents": documents, "top_n": top_n}
        response = await client.post(
            full_url, headers={**auth_headers(api_key), "Content-Type": "application/json"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
    results = (data.get("output") or {}).get("results") or data.get("results") or data.get("data") or []
    indices = [int(item["index"]) for item in results if isinstance(item, dict) and "index" in item]
    if not indices:
        raise RuntimeError("重排接口未返回有效 results")
    return indices


async def analyze_images(base_url: str, endpoint: str, api_key: str, model: str, system_prompt: str, question: str, images: list[tuple[bytes, str]]) -> str:
    content: list[dict[str, Any]] = [{"type": "input_text", "text": question or "请识别并分析这些医学图片。"}]
    for raw, mime in images:
        content.append({"type": "input_image", "image_url": f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"})
    payload = {"model": model, "instructions": system_prompt or "识别图片类型，仅给出可核验的医学辅助观察和风险边界，不做确诊。", "input": [{"role": "user", "content": content}]}
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(integration_url(base_url, endpoint), headers={**auth_headers(api_key), "Content-Type": "application/json"}, json=payload)
        # Responses API 不可用（如 qianwenai compatible-mode 无 /v1/responses）时，
        # 回退 OpenAI chat completions 多模态格式（qwen VL 系列标准调用法）
        if response.status_code in (404, 405):
            chat_content = [{"type": "text", "text": question or "请识别并分析这些医学图片。"}]
            for raw, mime in images:
                chat_content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"}})
            chat_payload = {
                "model": model,
                "messages": [{"role": "user", "content": chat_content}],
                "system": system_prompt or "识别图片类型，仅给出可核验的医学辅助观察和风险边界，不做确诊。",
            }
            response = await client.post(
                integration_url(base_url, "/chat/completions"),
                headers={**auth_headers(api_key), "Content-Type": "application/json"},
                json=chat_payload,
            )
            response.raise_for_status()
            data = response.json()
            text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "").strip()
            if not text:
                raise RuntimeError("VL 未返回图片分析")
            return text
        response.raise_for_status()
        data = response.json()
    text = "".join(block.get("text", "") for item in data.get("output") or [] for block in item.get("content") or [] if block.get("type") == "output_text").strip()
    if not text:
        raise RuntimeError("VL 未返回图片分析")
    return text


def test_storage_root(root: str) -> str:
    if not root.strip():
        raise RuntimeError("未配置私有存储目录")
    path = Path(root).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True)
    if not os.access(path, os.W_OK):
        raise RuntimeError("目录不可写")
    return f"存储目录可用：{path}"


async def test_asr_service(base_url: str, endpoint: str, api_key: str, model: str) -> str:
    await transcribe_audio(base_url, endpoint, api_key, model, "zh", silent_wav(), "connection-test.wav", "audio/wav")
    return "ASR 连接成功"


async def test_tts_service(base_url: str, endpoint: str, api_key: str, model: str, voice: str) -> str:
    audio, _ = await synthesize_speech(base_url, endpoint, api_key, model, voice, "mp3", "连接测试")
    if not audio:
        raise RuntimeError("TTS 未返回音频")
    return "TTS 连接成功"


async def test_vl_service(base_url: str, endpoint: str, api_key: str, model: str) -> str:
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
    await analyze_images(base_url, endpoint, api_key, model, "只判断图片是否可读取。", "连接测试", [(png, "image/png")])
    return "VL 连接成功"


async def test_rerank_service(base_url: str, endpoint: str, api_key: str, model: str) -> str:
    await rerank_documents(base_url, endpoint, api_key, model, "高血压", ["高血压管理", "无关内容"], 1)
    return "重排连接成功"
