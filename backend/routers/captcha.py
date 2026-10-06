"""
登录滑块验证码路由（协议参考 anji-plus/AJ-Captcha 行为验证，FastAPI 栈内零依赖实现）

为什么不用 AJ-Captcha 原版：它是 Java/Spring 生态组件；本项目的验证闭环
（服务端签发缺口位置 → 前端滑动比对 → 一次性票据放行登录）用 Python 标准库
hashlib/hmac 即可实现同等安全语义，无需引入任何新依赖。

安全设计：
- 缺口位置 target_x 只在服务端保存并 HMAC 签名下发 sig，前端仅拿 puzzle_x 画图，
  verify 时以服务端存的 target_x 为准，客户端传值不可信。
- 验证通过签发一次性 verify_ticket（HMAC，5 分钟有效、用后即焚），登录端点消费票据，
  避免"验证一次、爆破多次"。
- 除落点容差外还校验轨迹（时长/点数/非匀速），拦截纯脚本直线瞬移。
- 状态存内存字典 + 线程锁：单进程 uvicorn 部署下足够（多 worker 需换 Redis，当前架构不做）。
"""
import hashlib
import hmac
import random
import threading
import time
import uuid
from collections import defaultdict, deque
from statistics import pstdev
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from core.config import get_settings

router = APIRouter(prefix="/api/captcha", tags=["滑块验证码"])

# ---- 参数（为什么是这些值：兼顾正常用户手感与防脚本爆破）----
CHALLENGE_TTL_SECONDS = 120       # 题目有效期：与返回给前端的 ttl 一致
TICKET_TTL_SECONDS = 300          # 票据有效期：验证通过后 5 分钟内完成登录
TOLERANCE = 0.05                  # 归一化落点容差：320px 滑轨约合 ±16px
MAX_ATTEMPTS = 5                  # 单题最多尝试次数：防止对同一题反复试探落点
MIN_TRACK_POINTS = 8              # 轨迹最少采样点：真人拖动轻松超过，脚本难以伪造加减速
MIN_TRACK_MS = 300                # 轨迹最短时长：毫秒级"瞬移"必拒
MAX_TRACK_MS = 15000              # 轨迹最长时长：超长视为挂起异常
LOGIN_RATE_LIMIT = 10             # 登录 IP 限流阈值：每 IP 每 5 分钟 10 次
LOGIN_RATE_WINDOW_SECONDS = 300   # 登录限流滑动窗口

# ---- 内存状态（单进程 uvicorn；线程锁保护，sync 端点跑在线程池里必须加锁）----
_lock = threading.Lock()
_challenges: Dict[str, dict] = {}                 # challenge_id -> 题目状态
_tickets: Dict[str, dict] = {}                    # ticket -> {exp, used}
_login_attempts: Dict[str, deque] = defaultdict(deque)  # ip -> 时间戳滑动窗口


def _sign(message: str) -> str:
    """用全局 SECRET_KEY 做 HMAC-SHA256：题目与票据的防篡改签名，密钥复用 JWT 配置避免新增配置项。"""
    key = get_settings().SECRET_KEY.encode("utf-8")
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).hexdigest()


def _cleanup_locked(now: float) -> None:
    """清理过期题目与票据（调用方必须已持有 _锁）。放在写入路径顺带执行，避免单独起后台线程。"""
    for cid in [c for c, v in _challenges.items() if now - v["created_at"] > CHALLENGE_TTL_SECONDS]:
        _challenges.pop(cid, None)
    for tk in [t for t, v in _tickets.items() if v["exp"] < now]:
        _tickets.pop(tk, None)


class TrackPoint(BaseModel):
    """轨迹采样点：t 为相对拖动开始的毫秒数，dx 为相对滑轨起点的像素位移。"""
    t: int
    dx: float


class VerifyRequest(BaseModel):
    challenge_id: str
    sig: str
    x: float = Field(ge=0, le=1)  # 归一化落点 0-1
    track: List[TrackPoint]


@router.get("/challenge")
def get_challenge():
    """下发滑块题目：随机缺口位置 + HMAC 签名。puzzle_x 仅用于前端画缺口，校验以服务端存的值为准。"""
    challenge_id = uuid.uuid4().hex
    target_x = random.uniform(0.25, 0.75)  # 缺口避开两端：保证滑块有足够拖动距离
    exp_ts = int(time.time()) + CHALLENGE_TTL_SECONDS
    sig = _sign(f"{challenge_id}:{target_x:.4f}:{exp_ts}")

    with _lock:
        _cleanup_locked(time.time())
        _challenges[challenge_id] = {
            "target_x": target_x,
            "sig": sig,
            "created_at": time.time(),
            "verified": False,
            "attempts": 0,
        }

    return {"challenge_id": challenge_id, "puzzle_x": round(target_x, 4), "sig": sig, "ttl": CHALLENGE_TTL_SECONDS}


@router.post("/verify")
def verify(data: VerifyRequest):
    """校验滑块落点与轨迹；通过后签发一次性登录票据。"""
    now = time.time()
    with _lock:
        _cleanup_locked(now)
        challenge = _challenges.get(data.challenge_id)
        if challenge is None:
            raise HTTPException(400, "验证码已过期或不存在，请刷新后重试")
        if challenge["verified"]:
            # 理论上不会走到（通过即删题），双保险防止复用
            _challenges.pop(data.challenge_id, None)
            raise HTTPException(400, "验证码已被使用，请刷新后重试")
        if now - challenge["created_at"] > CHALLENGE_TTL_SECONDS:
            _challenges.pop(data.challenge_id, None)
            raise HTTPException(400, "验证码已过期，请刷新后重试")
        # 先记尝试次数再校验：无论哪种失败都计数，防同一题穷举落点
        challenge["attempts"] += 1
        if challenge["attempts"] > MAX_ATTEMPTS:
            _challenges.pop(data.challenge_id, None)
            raise HTTPException(400, "尝试次数过多，验证码已作废，请刷新")

        # sig 必须与服务端签发的一致：防止拿旧题的签名套新 challenge_id
        if data.sig != challenge["sig"]:
            raise HTTPException(400, "验证码签名不匹配，请刷新后重试")

        target_x = challenge["target_x"]
        track = data.track

        # 1) 落点容差
        if abs(data.x - target_x) > TOLERANCE:
            raise HTTPException(400, "滑块位置不正确，请重试")

        # 2) 轨迹合理性：点数 / 时长
        if len(track) < MIN_TRACK_POINTS:
            raise HTTPException(400, "滑动轨迹异常，请重试")
        duration = track[-1].t - track[0].t
        if not (MIN_TRACK_MS <= duration <= MAX_TRACK_MS):
            raise HTTPException(400, "滑动轨迹异常，请重试")

        # 3) 非匀速：相邻采样点位移差的总体标准差为 0 说明是恒速直线（脚本特征）
        deltas = [track[i + 1].dx - track[i].dx for i in range(len(track) - 1)]
        if not deltas or pstdev(deltas) <= 0:
            raise HTTPException(400, "滑动轨迹异常，请重试")

        # 全部通过：删题（一次性）+ 签发 5 分钟一次性票据
        _challenges.pop(data.challenge_id, None)
        exp = int(time.time()) + TICKET_TTL_SECONDS
        ticket = _sign(f"ok:{data.challenge_id}:{exp}")
        _tickets[ticket] = {"exp": exp, "used": False}

    return {"token": ticket}


def consume_captcha_ticket(token: Optional[str]) -> bool:
    """登录端点消费验证票据：存在、未过期且未用过 → 标记已用并放行。

    一次性语义：无论登录最终成功与否票据都作废，防止一次验证反复尝试密码。
    """
    if not token:
        return False
    now = time.time()
    with _lock:
        _cleanup_locked(now)
        entry = _tickets.get(token)
        if not entry or entry["used"] or entry["exp"] < now:
            return False
        entry["used"] = True
        return True


def check_login_rate_limit(request: Request) -> None:
    """登录 IP 限流：每 IP 每 5 分钟最多 10 次（内存滑动窗口）。

    在校验用户名密码之前执行，挡住高频爆破；正常用户 5 分钟 10 次登录已足够宽裕。
    超限抛 429，前端提示稍后再试。
    """
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    with _lock:
        window = _login_attempts[ip]
        while window and window[0] <= now - LOGIN_RATE_WINDOW_SECONDS:
            window.popleft()
        if len(window) >= LOGIN_RATE_LIMIT:
            raise HTTPException(429, "尝试过于频繁，请稍后再试")
        window.append(now)
