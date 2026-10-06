"""
患者档案数据模型
"""
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from core.database import Base


class PatientProfile(Base):
    """患者档案模型 — 支持家庭成员"""

    __tablename__ = "patient_profiles"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    # ── 基本信息 ──
    name = Column(String(50), nullable=False, default="", comment="患者姓名")
    gender = Column(String(10), nullable=False, default="", comment="性别 male/female/other")
    age = Column(String(10), nullable=False, default="", comment="年龄")
    phone = Column(String(20), nullable=True, default="", comment="联系电话")
    residence = Column(String(100), nullable=True, default="", comment="现居住地区")

    # ── 病史 ──
    diseases = Column(Text, nullable=False, default="[]", comment="疾病史（JSON 数组，疾病ID）")
    symptoms = Column(Text, nullable=False, default="[]", comment="近期症状（JSON 数组）")
    tcm_syndrome = Column(String(200), nullable=True, default="", comment="中医证型")
    chief_complaint = Column(Text, nullable=True, default="", comment="主诉")
    family_history = Column(Text, nullable=True, default="", comment="家族病史（JSON 数组）")

    # ── 成员关系 ──
    is_family_member = Column(Boolean, default=False, nullable=False, comment="是否为家庭成员")
    primary_member_id = Column(Integer, ForeignKey("patient_profiles.id", ondelete="SET NULL"), nullable=True, index=True, comment="所属主档案ID（None=本人档案）")

    # ── 元信息 ──
    is_default = Column(Boolean, default=False, nullable=False, comment="是否默认档案")
    constitution = Column(String(100), nullable=True, default="")
    source_conversation_id = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    def __repr__(self):
        return f"<PatientProfile(id={self.id}, user_id={self.user_id}, name='{self.name}', is_family={self.is_family_member})>"
