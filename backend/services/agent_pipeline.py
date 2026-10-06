"""真实检索与证据整合 Agent 管线。"""
from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass
from typing import Any, AsyncGenerator, Callable

import httpx

from services.llm import _create_async_client, stream_llm_response


@dataclass
class Citation:
    id: int
    source: str
    title: str
    url: str
    snippet: str = ""
    score: float | None = None


def responses_url(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    return f"{base}/responses" if base.endswith("/v1") else f"{base}/v1/responses"


def _report_usage(on_usage: Callable[[int], Any] | None, total: Any) -> None:
    """把本次补全的实际 token 用量回调给调用方（用于每日配额事后计量）。

    total 拿不到（None/0）时不回调，由调用方按字符估算；回调异常不外抛。
    """
    if on_usage is None or not total:
        return
    try:
        on_usage(int(total))
    except Exception:  # noqa: BLE001 - 计量失败不影响主流程
        pass


def _responses_usage_total(data: dict) -> int | None:
    """从 Responses API 响应中提取 token 用量（total_tokens 或 input+output 之和）。"""
    usage = data.get("usage") or {}
    if not isinstance(usage, dict):
        return None
    total = usage.get("total_tokens")
    if total:
        return int(total)
    combined = (usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0)
    return combined or None


async def complete_llm(config: dict, system_prompt: str, prompt: str, max_tokens: int = 1200, on_usage: Callable[[int], Any] | None = None) -> str:
    if config.get("provider") == "responses" or config.get("model") == "deepseek-v4-flash":
        payload = {
            "model": config["model"], "instructions": system_prompt, "input": prompt,
            "max_output_tokens": max(max_tokens, 1200), "stream": False,
        }
        async with httpx.AsyncClient(timeout=90) as http:
            response = await http.post(
                responses_url(config.get("base_url") or ""),
                headers={"Authorization": f"Bearer {config['api_key']}", "Content-Type": "application/json"},
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
        _report_usage(on_usage, _responses_usage_total(data))
        text = "".join(
            content.get("text", "")
            for item in data.get("output") or [] if item.get("type") == "message"
            for content in item.get("content") or [] if content.get("type") == "output_text"
        ).strip()
        if not text:
            raise RuntimeError("Responses API 未返回有效文本")
        return text
    client = _create_async_client(config["provider"], config["api_key"], config.get("base_url"))
    # 短任务（检索词/标题/intake 追问）不需要思考；分平台参数：qwen 用 enable_thinking=False
    # （默认偷开思考实测白等一倍时间），DeepSeek 用 thinking.type=disabled（deepseek-flash/
    # reasoner 类思考模型在小 max_tokens 下会思考占满导致正文为空 → "模型未返回有效内容"）
    is_deepseek = "deepseek" in (config.get("base_url") or "").lower() or (config.get("model") or "").lower().startswith("deepseek")
    response = await client.chat.completions.create(
        model=config["model"],
        messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}],
        temperature=0.2,
        max_tokens=max_tokens,
        extra_body={"thinking": {"type": "disabled"}} if is_deepseek else {"enable_thinking": False},
    )
    _report_usage(on_usage, getattr(getattr(response, "usage", None), "total_tokens", 0))
    if not response.choices or not response.choices[0].message.content:
        raise RuntimeError("模型未返回有效内容")
    return response.choices[0].message.content.strip()


async def generate_intake_turn(
    config: dict,
    history: list[dict],
    user_message: str,
    patient_context: str,
    intake_system_prompt: str,
    on_usage: Callable[[int], Any] | None = None,
) -> dict:
    """生成一轮 AI 主动问诊：短回应 + 选项，或判定症状已收集完成。

    返回结构：{"reply": str, "options": [{"label": str, "multi": bool}], "complete": bool}
    这是与"一次性大段回答"问答式 AI 的核心区别——每轮只给少量文字和可点选的下一步症状选项。
    on_usage：透传给 complete_llm 的 token 用量回调（每日配额事后计量）。
    """
    history_text = (
        "\n\n".join(f"{item['role']}: {item['content']}" for item in history)
        if history
        else "（首轮问诊，尚无历史对话）"
    )
    context_section = f"\n\n患者档案：\n{patient_context}" if patient_context else ""
    prompt = (
        f"历史对话：\n{history_text}{context_section}\n\n"
        f"患者本次输入：{user_message}\n\n"
        "请按规则给出本轮 JSON 回复。"
    )
    raw = await complete_llm(config, intake_system_prompt, prompt, 700, on_usage=on_usage)
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        # 无法解析为 JSON 时，降级为直接收尾并把原文作为回应
        return {"reply": raw.strip()[:400], "options": [], "complete": True}
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {"reply": raw.strip()[:400], "options": [], "complete": True}

    reply = str(data.get("reply") or "").strip()
    options: list[dict] = []
    for opt in (data.get("options") or [])[:8]:
        if isinstance(opt, str):
            options.append({"label": opt.strip(), "multi": False})
        elif isinstance(opt, dict):
            label = str(opt.get("label") or opt.get("text") or "").strip()
            if label:
                options.append({"label": label, "multi": bool(opt.get("multi", False))})
    complete = bool(data.get("complete", False))
    if not reply and not options:
        complete = True
    return {"reply": reply, "options": options, "complete": complete}


async def generate_search_queries(config: dict, question: str, patient_context: str) -> list[str]:
    raw = await complete_llm(
        config,
        "你是医疗检索规划器。只输出 JSON 字符串数组，不要解释。",
        f"根据患者问题和档案生成 2-4 个简洁、互补、适合医学检索的中文检索词。\n患者档案：{patient_context}\n问题：{question}",
        300,
    )
    match = re.search(r"\[[\s\S]*?\]", raw)
    if match:
        try:
            values = json.loads(match.group(0))
            if isinstance(values, list):
                cleaned = [str(value).strip() for value in values if str(value).strip()]
                if cleaned:
                    return cleaned[:4]
        except json.JSONDecodeError:
            pass
    cleaned = [line.strip(" -•0123456789.、") for line in raw.splitlines() if line.strip()]
    return cleaned[:4] or [question[:120]]


def _extract_links(text: str) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for title, url in re.findall(r"\[([^\]]+)\]\((https?://[^)]+)\)", text):
        found.append((title.strip(), url.strip()))
    for url in re.findall(r"(?<!\()https?://[^\s)>]+", text):
        clean = url.rstrip(".,，。；;")
        if not any(existing == clean for _, existing in found):
            found.append((clean, clean))
    return found


async def search_deepseek(base_url: str, api_key: str, queries: list[str], model: str = "deepseek-v4-flash", timeout_seconds: int = 30) -> tuple[str, list[Citation]]:
    # search_mode=performance_first（DashScope 搜索工具性能优先档）：实测 20.5s vs 默认 balanced 25.4s
    is_qwen = (model or "").startswith("qwen")
    payload = {
        "model": model or "deepseek-v4-flash",
        "input": "必须使用网络搜索工具。检索以下医疗问题，给出简洁结论，并为每条事实附可访问的来源链接：\n" + "\n".join(f"- {q}" for q in queries),
        "tools": [{"type": "web_search", **({"web_search": {"search_mode": "performance_first"}} if is_qwen else {})}],
        "stream": False,
    }
    # qwen3.8 系列在 thinking 模式下不支持 tool_choice:"required"（实测 400 InvalidParameter），
    # 依赖提示词强制走搜索即可；DeepSeek 官方 Responses 保持 required 确保必搜
    if not (model or "").startswith("qwen3.8"):
        payload["tool_choice"] = "required"
    # 抓网页本质耗时 20-30s 且有波动（实测 performance_first 20.5s，线上偶发 >30s），
    # 超时下限 60s 防误杀；配置值更大则尊重配置
    async with httpx.AsyncClient(timeout=max(60, int(timeout_seconds or 60))) as client:
        response = await client.post(
            responses_url(base_url),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()

    text_parts: list[str] = []
    sources: list[tuple[str, str, str]] = []
    for item in data.get("output") or []:
        if item.get("type") == "web_search_call":
            for source in (item.get("action") or {}).get("sources") or []:
                sources.append((source.get("title") or source.get("url") or "网络来源", source.get("url") or "", source.get("snippet") or ""))
        if item.get("type") == "message":
            for content in item.get("content") or []:
                if content.get("type") == "output_text" and content.get("text"):
                    text_parts.append(content["text"])
                    for annotation in content.get("annotations") or []:
                        if annotation.get("url"):
                            sources.append((annotation.get("title") or annotation["url"], annotation["url"], ""))
    summary = "\n".join(text_parts).strip()
    if not sources:
        sources = [(title, url, "") for title, url in _extract_links(summary)]
    unique: list[Citation] = []
    seen: set[str] = set()
    for title, url, snippet in sources:
        if not url or url in seen:
            continue
        seen.add(url)
        unique.append(Citation(len(unique) + 1, "web", title, url, snippet))
    return summary, unique[:8]


async def search_tavily(base_url: str, api_key: str, queries: list[str], options: dict | None = None) -> tuple[str, list[Citation]]:
    options = options or {}
    endpoint = (base_url or "https://api.tavily.com").rstrip("/")
    if not endpoint.endswith("/search"):
        endpoint += "/search"
    payload = {
        "query": "；".join(queries),
        "search_depth": options.get("search_depth", "fast"),
        "max_results": max(1, min(20, int(options.get("max_results", 8)))),
        "include_answer": False,
        "include_raw_content": False,
        "topic": "general",
    }
    timeout = max(3, min(60, int(options.get("timeout_seconds", 15))))
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(endpoint, headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, json=payload)
        response.raise_for_status()
        data = response.json()
    citations = []
    summaries = []
    for item in data.get("results") or []:
        title = item.get("title") or item.get("url") or "网络来源"
        url = item.get("url") or ""
        snippet = item.get("content") or ""
        if not url:
            continue
        citations.append(Citation(len(citations) + 1, "web", title, url, snippet, item.get("score")))
        summaries.append(f"{title}：{snippet}")
    return "\n".join(summaries), citations


async def search_web(provider: str, base_url: str, api_key: str, queries: list[str], options: dict | None = None) -> tuple[str, list[Citation]]:
    options = options or {}
    if provider == "tavily":
        return await search_tavily(base_url, api_key, queries, options)
    return await search_deepseek(
        base_url, api_key, queries,
        model=str(options.get("model") or "deepseek-v4-flash"),
        timeout_seconds=int(options.get("timeout_seconds") or 60),
    )


async def search_knowledge_base(url: str, api_key: str, query: str, top_k: int) -> list[Citation]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(url, headers=headers, json={"query": query, "top_k": top_k})
        response.raise_for_status()
        data = response.json()
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise RuntimeError("知识库响应缺少 items 数组")
    citations: list[Citation] = []
    for item in items[:top_k]:
        if not isinstance(item, dict):
            continue
        citations.append(Citation(0, "knowledge", str(item.get("title") or "知识库资料"), str(item.get("url") or ""), str(item.get("snippet") or ""), item.get("score")))
    return citations


async def stream_evidence_summary(
    config: dict,
    question: str,
    citations: list[Citation],
    web_summary: str,
    on_reasoning: Optional[Callable[[str], Any]] = None,
    enable_thinking: bool = False,
    thinking_budget: Optional[int] = None,
    on_usage: Optional[Callable[[int], Any]] = None,
) -> AsyncGenerator[str, None]:
    """证据整合摘要的真流式版本：逐段 yield 累计文本（供 trace.stage 增量推送）。

    与 build_evidence_summary 同 prompt 同参数，但走 stream_llm_response 流式聚合。
    LLM 异常时 yield 一条简短的失败说明（调用方继续生成最终回答，不中断整条 SSE）。
    on_usage：透传 stream_llm_response 的 token 用量回调。
    """
    evidence = "\n".join(f"[{c.id}] {c.title}\n{c.snippet}\n{c.url}" for c in citations)
    prompt = (
        f"问题：{question}\n网络检索摘要：{web_summary}\n证据：\n{evidence or '本次没有外部证据。'}\n"
        "请输出不超过 220 字的证据整合摘要。"
    )
    full = ""
    try:
        async for chunk in stream_llm_response(
            config.get("provider", "openai"),
            config.get("api_key", ""),
            config.get("model") or config.get("model_id", ""),
            "你是医疗证据编辑。只总结可核验的证据、冲突、适用边界和安全风险，不展示内部推理过程。",
            [{"role": "user", "content": prompt}],
            base_url=config.get("base_url"),
            on_reasoning=on_reasoning,
            enable_thinking=enable_thinking,
            thinking_budget=thinking_budget,
            on_usage=on_usage,
        ):
            if chunk.startswith("\n\n[错误]"):
                if not full:
                    yield "证据摘要生成失败，可继续提问。"
                    return
                break
            full += chunk
            yield full
    except Exception:
        if not full:
            yield "证据摘要生成失败，可继续提问。"


async def build_evidence_summary(config: dict, question: str, citations: list[Citation], web_summary: str) -> str:
    evidence = "\n".join(f"[{c.id}] {c.title}\n{c.snippet}\n{c.url}" for c in citations)
    return await complete_llm(
        config,
        "你是医疗证据编辑。只总结可核验的证据、冲突、适用边界和安全风险，不展示内部推理过程。",
        f"问题：{question}\n网络检索摘要：{web_summary}\n证据：\n{evidence or '本次没有外部证据。'}\n请输出不超过 220 字的证据整合摘要。",
        500,
    )


async def stream_final_answer(
    config: dict,
    system_prompt: str,
    history: list[dict],
    question: str,
    patient_context: str,
    evidence_summary: str,
    citations: list[Citation],
    on_reasoning: Optional[Callable[[str], Any]] = None,
    enable_thinking: bool = False,
    thinking_budget: Optional[int] = None,
    on_usage: Optional[Callable[[int], Any]] = None,
) -> AsyncGenerator[str, None]:
    evidence = "\n".join(f"[{c.id}] {c.title}\n摘要：{c.snippet}\n链接：{c.url}" for c in citations)
    user_prompt = f"""患者档案：
{patient_context or '未关联患者档案'}

问题：{question}

证据整合摘要：{evidence_summary}

可引用来源：
{evidence or '无外部来源'}

请给出结构清晰、审慎、可执行的中医慢病辅助诊疗建议。仅对上面存在的来源使用 [1] 形式编号引用；不得编造引用。结尾提醒不能替代医生诊断与处方。"""
    if config.get("provider") == "responses" or config.get("model") == "deepseek-v4-flash":
        history_text = "\n\n".join(f"{item['role']}: {item['content']}" for item in history)
        payload = {
            "model": config["model"], "instructions": system_prompt,
            "input": f"历史对话：\n{history_text}\n\n当前任务：\n{user_prompt}", "stream": True,
        }
        async with httpx.AsyncClient(timeout=120) as http:
            async with http.stream(
                "POST", responses_url(config.get("base_url") or ""),
                headers={"Authorization": f"Bearer {config['api_key']}", "Content-Type": "application/json", "Accept": "text/event-stream"},
                json=payload,
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    event = json.loads(raw)
                    if event.get("type") == "response.output_text.delta" and event.get("delta"):
                        yield event["delta"]
        return
    messages = history + [{"role": "user", "content": user_prompt}]
    async for chunk in stream_llm_response(
        provider=config["provider"], api_key=config["api_key"], model=config["model"],
        system_prompt=system_prompt, messages=messages, base_url=config.get("base_url"),
        on_reasoning=on_reasoning,
        enable_thinking=enable_thinking,
        thinking_budget=thinking_budget,
        on_usage=on_usage,
    ):
        yield chunk


def citation_dicts(citations: list[Citation]) -> list[dict]:
    return [asdict(citation) for citation in citations]


def elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)
