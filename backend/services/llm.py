"""
大语言模型调用服务模块
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable,  AsyncGenerator, Dict, List, Optional, Tuple

from openai import AsyncOpenAI


class LLMServiceError(RuntimeError):
    """自定义异常：LLM 供应商配置错误"""


@dataclass(frozen=True)
class ProviderConfig:
    """LLM 供应商配置"""

    key: str
    default_base_url: Optional[str] = None
    requires_base_url: bool = False


_PROVIDER_REGISTRY: Dict[str, ProviderConfig] = {
    "deepseek": ProviderConfig(
        key="deepseek",
        default_base_url="https://api.deepseek.com/v1",
    ),
    "qwen": ProviderConfig(
        key="qwen",
        default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    ),
    "openai": ProviderConfig(
        key="openai",
        default_base_url="https://api.openai.com/v1",
    ),
    "openaiful": ProviderConfig(
        key="openaiful",
        requires_base_url=True,
    ),
    "dify": ProviderConfig(
        key="dify",
        requires_base_url=True,
    ),
}


def _normalize_base_url(raw: str) -> str:
    """清洗并标准化 Base URL"""

    cleaned = raw.strip()
    if not cleaned:
        raise LLMServiceError("Base URL 不能为空")

    cleaned = cleaned.rstrip("/")
    if not cleaned.lower().endswith("/v1"):
        cleaned = f"{cleaned}/v1"
    return cleaned


def _resolve_base_url(provider: str, override: Optional[str]) -> str:
    """获取最终使用的 Base URL"""

    normalized_provider = provider.lower().strip()

    if override and override.strip():
        return _normalize_base_url(override)

    config = _PROVIDER_REGISTRY.get(normalized_provider)
    if not config:
        raise LLMServiceError("未配置的 LLM 供应商，请在系统设置中填写完整的连接信息。")

    if config.default_base_url:
        return config.default_base_url

    if config.requires_base_url:
        raise LLMServiceError("该供应商需要填写 Base URL，请前往系统设置补全后重试。")

    raise LLMServiceError("无法解析 Base URL，请检查供应商配置。")


def _create_async_client(
    provider: str,
    api_key: str,
    base_url: Optional[str] = None,
) -> AsyncOpenAI:
    """构建异步 OpenAI 客户端"""

    resolved_base_url = _resolve_base_url(provider, base_url)
    return AsyncOpenAI(api_key=api_key, base_url=resolved_base_url)


async def stream_llm_response(
    provider: str,
    api_key: str,
    model: str,
    system_prompt: str,
    messages: List[Dict[str, str]],
    base_url: Optional[str] = None,
    temperature: float = 0.35,
    enable_thinking: bool = False,
    thinking_budget: Optional[int] = None,
    on_reasoning: Optional[Callable[[str], Any]] = None,
    on_usage: Optional[Callable[[int], Any]] = None,
) -> AsyncGenerator[str, None]:
    """流式调用大语言模型，返回内容片段。

    temperature 默认 0.35：报告生成需要稳定、一致的输出，高温度是偶发乱码和
    "同问不同答"的主因。需要多样性的调用（如 intake 追问）可显式传更高值。

    on_usage：流结束时回调本次实际 token 用量（prompt+completion 总和，来自
    include_usage 统计帧）；拿不到统计帧不回调，由调用方按字符估算。无回调也正常返回。
    """

    full_messages = [{"role": "system", "content": system_prompt}]
    full_messages.extend(messages)

    try:
        client = _create_async_client(provider, api_key, base_url)
    except LLMServiceError as exc:
        yield f"\n\n[错误] {exc}"
        return

    # 思考模式：enable_thinking 控制是否输出 reasoning_content（流式经 on_reasoning 回传）。
    # 分平台参数（实测）：qwen/DashScope 用 extra_body enable_thinking(+thinking_budget)；
    # DeepSeek 用 thinking.type（"disabled" 实测关思考生效，enable_thinking 对它无效）。
    # 降级重试：部分端点不认识参数时逐级退化（去 budget → 去 extra_body）。
    is_deepseek = "deepseek" in (base_url or "").lower() or model.lower().startswith("deepseek")
    if is_deepseek:
        base_body: Dict[str, Any] = {"thinking": {"type": "enabled" if enable_thinking else "disabled"}}
    else:
        base_body = {"enable_thinking": enable_thinking}
        if enable_thinking and thinking_budget:
            base_body["thinking_budget"] = int(thinking_budget)
    candidate_bodies: List[Optional[Dict[str, Any]]] = [base_body]
    if "thinking_budget" in base_body:
        candidate_bodies.append({"enable_thinking": base_body["enable_thinking"]})
    candidate_bodies.append(None)

    # stream_options.include_usage：请求流尾统计帧（choices=[] 且带 usage），用于 token 精确计量；
    # 个别端点不认识该参数会 400，并入 extra_body 降级链——每个 body 先带 include_usage 试一次，
    # 失败再去掉（OpenAI 兼容端点与 DeepSeek/DashScope 均支持）。
    stream = None
    last_error: Optional[Exception] = None
    for body in candidate_bodies:
        for stream_options in ({"include_usage": True}, None):
            try:
                stream = await client.chat.completions.create(
                    model=model,
                    messages=full_messages,
                    stream=True,
                    temperature=temperature,
                    extra_body=body,
                    stream_options=stream_options,
                )
                break
            except Exception as exc:  # noqa: BLE001
                last_error = exc
        if stream is not None:
            break
    if stream is None:
        yield f"\n\n[错误] 调用大模型失败: {last_error}"
        return

    usage_total = 0
    try:
        async for chunk in stream:
            # 统计帧：部分平台（DashScope qwen 系）在流尾发 choices=[] 的帧，不能取 [0]；
            # include_usage 开启时 usage 挂在该帧上（个别供应商挂在末尾正常帧上，一并兼容）
            chunk_usage = getattr(chunk, "usage", None)
            if chunk_usage is not None:
                prompt_tokens = getattr(chunk_usage, "prompt_tokens", 0) or 0
                completion_tokens = getattr(chunk_usage, "completion_tokens", 0) or 0
                usage_total = (prompt_tokens + completion_tokens) or (getattr(chunk_usage, "total_tokens", 0) or 0)
            if not chunk.choices:
                continue
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
            elif getattr(chunk.choices[0].delta, "reasoning_content", None):
                if on_reasoning:
                    on_reasoning(chunk.choices[0].delta.reasoning_content)
                else:
                    yield chunk.choices[0].delta.reasoning_content

    except Exception as exc:  # noqa: BLE001
        yield f"\n\n[错误] 调用大模型失败: {exc}"

    # 流结束后回调实际 token 用量（拿到统计帧才回调；拿不到由调用方按字符估算）
    if on_usage is not None and usage_total > 0:
        try:
            on_usage(usage_total)
        except Exception:  # noqa: BLE001 - 计量回调失败不影响内容输出
            pass


async def test_llm_connection(
    provider: str,
    api_key: str,
    model: str,
    base_url: Optional[str] = None,
) -> Tuple[bool, str]:
    """测试与 LLM 供应商的连通性"""

    try:
        client = _create_async_client(provider, api_key, base_url)
    except LLMServiceError as exc:
        return False, str(exc)

    try:
        await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "你好"}],
            max_tokens=10,
        )
        return True, "连接成功，模型响应正常。"
    except Exception as exc:  # noqa: BLE001
        return False, f"连接失败: {exc}"


async def list_llm_models(
    provider: str,
    api_key: str,
    base_url: Optional[str] = None,
) -> Tuple[bool, List[Dict[str, Optional[str]]], Optional[str]]:
    """从供应商获取模型列表"""

    try:
        client = _create_async_client(provider, api_key, base_url)
    except LLMServiceError as exc:
        return False, [], str(exc)

    try:
        response = await client.models.list()
        models: List[Dict[str, Optional[str]]] = []

        for model in response.data:
            model_id = getattr(model, "id", None)
            model_name = getattr(model, "name", None) or model_id
            models.append(
                {
                    "id": model_id,
                    "name": model_name,
                    "owned_by": getattr(model, "owned_by", None),
                }
            )

        if not models:
            return False, [], "未获取到任何模型，请检查 API Key 与权限配置。"

        return True, models, None
    except Exception as exc:  # noqa: BLE001
        return False, [], f"获取模型列表失败: {exc}"


async def generate_suggested_questions(
    provider: str,
    api_key: str,
    model: str,
    system_prompt: str,
    messages: List[Dict[str, str]],
    count: int = 3,
    base_url: Optional[str] = None,
    max_retries: int = 1,
) -> Tuple[bool, List[str], Optional[str]]:
    """
    生成推荐问题

    Args:
        provider: LLM 提供商
        api_key: API 密钥
        model: 模型名称
        system_prompt: 系统提示词
        messages: 历史消息列表
        count: 需要生成的问题数量
        base_url: API Base URL
        max_retries: 最大重试次数（默认1次）

    Returns:
        Tuple[是否成功, 问题列表, 错误消息]
    """

    def extract_questions(text: str, expected_count: int) -> Optional[List[str]]:
        """从大模型返回的文本中提取问题列表"""

        # 尝试解析 JSON 格式
        try:
            # 查找 JSON 数组
            json_match = re.search(r'\[[\s\S]*?\]', text)
            if json_match:
                questions = json.loads(json_match.group())
                if isinstance(questions, list) and all(isinstance(q, str) for q in questions):
                    return questions[:expected_count]
        except (json.JSONDecodeError, ValueError):
            pass

        # 尝试解析编号列表格式（如：1. 问题1\n2. 问题2）
        numbered_pattern = r'^\s*\d+[.、]\s*(.+)$'
        numbered_questions = []
        for line in text.split('\n'):
            match = re.match(numbered_pattern, line.strip())
            if match:
                numbered_questions.append(match.group(1).strip())

        if len(numbered_questions) >= expected_count:
            return numbered_questions[:expected_count]

        # 尝试解析无序列表格式（如：- 问题1\n- 问题2）
        bullet_pattern = r'^\s*[-*•]\s*(.+)$'
        bullet_questions = []
        for line in text.split('\n'):
            match = re.match(bullet_pattern, line.strip())
            if match:
                bullet_questions.append(match.group(1).strip())

        if len(bullet_questions) >= expected_count:
            return bullet_questions[:expected_count]

        # 如果都无法解析，返回 None
        return None

    for attempt in range(max_retries + 1):
        try:
            client = _create_async_client(provider, api_key, base_url)
        except LLMServiceError as exc:
            return False, [], str(exc)

        try:
            # 构建完整的消息列表
            full_messages = [{"role": "system", "content": system_prompt}]
            full_messages.extend(messages)

            # 调用大模型
            response = await client.chat.completions.create(
                model=model,
                messages=full_messages,
                temperature=0.8,
                max_tokens=500,
            )

            if not response.choices or not response.choices[0].message.content:
                if attempt < max_retries:
                    continue
                return False, [], "大模型未返回有效内容"

            content = response.choices[0].message.content.strip()

            # 提取问题
            questions = extract_questions(content, count)

            if questions:
                return True, questions, None

            # 如果提取失败且还有重试机会，继续重试
            if attempt < max_retries:
                continue

            return False, [], f"无法从大模型返回中提取推荐问题，原始返回：{content[:200]}"

        except Exception as exc:  # noqa: BLE001
            if attempt < max_retries:
                continue
            return False, [], f"调用大模型失败: {exc}"

    return False, [], "生成推荐问题失败"
