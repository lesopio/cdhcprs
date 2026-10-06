"""网络镜像库：把每次网络搜索抓到的来源（标题/URL/摘要）按 URL 去重沉淀成
独立的本地知识底座——非权威知识库（与外部知识源的指南共识权威库相对）。

同一 URL 只存一份（首见时间 + 命中次数），问诊时思维链新增「网络镜像」
步骤检索此库，命中的历史来源作为补充证据并入。
"""
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, Text

from core.database import Base


class WebMirrorItem(Base):
    __tablename__ = "web_mirror_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # 去重键：来源 URL（同 URL 跨多次搜索只留一份，命中次数累加）
    url = Column(Text, nullable=False, unique=True, index=True)
    title = Column(Text, nullable=False, default="")
    snippet = Column(Text, nullable=False, default="")
    # 域名（来源列表展示用）
    host = Column(String(200), nullable=False, default="")
    # 首次入库时的检索词（溯源）
    source_query = Column(Text, nullable=False, default="")
    hit_count = Column(Integer, nullable=False, default=1)
    first_seen_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    last_seen_at = Column(DateTime, nullable=False, default=datetime.utcnow)
