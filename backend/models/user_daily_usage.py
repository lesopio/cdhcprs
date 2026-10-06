"""
用户每日用量数据模型（每日配额限流）
"""
from sqlalchemy import Column, Integer, Date, DateTime, PrimaryKeyConstraint
from sqlalchemy.sql import func

from core.database import Base


class UserDailyUsage(Base):
    """用户每日用量计数：token / 图片 / 网络搜索，按 (user_id, date) 每人每天一行累计。

    计数方式见 services/usage.py：图片与搜索在动作发生前 ensure_quota 检查并计数；
    token 先检查（不计数），流式结束后按供应商统计帧或字符估算 add_usage 补记。
    """

    __tablename__ = "user_daily_usage"
    __table_args__ = (
        PrimaryKeyConstraint("user_id", "date"),
    )

    user_id = Column(Integer, nullable=False, index=True)
    date = Column(Date, nullable=False)
    tokens = Column(Integer, default=0, nullable=False)
    images = Column(Integer, default=0, nullable=False)
    web_searches = Column(Integer, default=0, nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    def __repr__(self):
        return f"<UserDailyUsage(user_id={self.user_id}, date='{self.date}', tokens={self.tokens}, images={self.images}, web_searches={self.web_searches})>"
