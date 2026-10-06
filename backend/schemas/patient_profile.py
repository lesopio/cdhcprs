"""
患者档案相关的 Pydantic Schemas
"""
from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional, List


# ─── 内部辅助 Schema ───────────────────────────────────────────────

class FamilyHistoryItem(BaseModel):
    """家族病史条目"""
    relation: str = Field(..., description="亲属关系，如：父亲、母亲、兄弟")
    disease: str = Field(..., description="疾病名称")
    onset_age: Optional[str] = Field(None, description="发病年龄")


# ─── CRUD Schemas ──────────────────────────────────────────────────

class PatientProfileBase(BaseModel):
    """患者档案基础 Schema"""
    name: str = Field("", min_length=0, max_length=50, description="患者姓名")
    gender: str = Field("", description="性别 male/female/other")
    age: str = Field("", max_length=10, description="年龄")
    phone: str = Field("", max_length=20, description="联系电话")
    residence: str = Field("", max_length=100, description="现居住地区")
    diseases: List[str] = Field(default_factory=list, description="疾病史（疾病ID列表）")
    symptoms: List[str] = Field(default_factory=list, description="近期症状列表")
    tcm_syndrome: str = Field("", description="中医证型")
    chief_complaint: str = Field("", description="主诉")
    family_history: List[FamilyHistoryItem] = Field(default_factory=list, description="家族病史")
    is_family_member: bool = Field(False, description="是否为家庭成员")
    primary_member_id: Optional[int] = Field(None, description="所属主档案ID")
    is_default: bool = Field(False, description="是否默认档案")


    constitution: str = Field("", max_length=100)
    source_conversation_id: Optional[int] = None


class PatientProfileCreate(PatientProfileBase):
    """创建档案 Schema"""
    user_id: int = Field(..., description="所属用户ID")


class PatientProfileUpdate(BaseModel):
    """更新档案 Schema（全部可选）"""
    name: Optional[str] = Field(None, max_length=50)
    gender: Optional[str] = None
    age: Optional[str] = Field(None, max_length=10)
    phone: Optional[str] = Field(None, max_length=20)
    residence: Optional[str] = Field(None, max_length=100)
    diseases: Optional[List[str]] = None
    symptoms: Optional[List[str]] = None
    tcm_syndrome: Optional[str] = None
    chief_complaint: Optional[str] = None
    family_history: Optional[List[FamilyHistoryItem]] = None
    is_family_member: Optional[bool] = None
    primary_member_id: Optional[int] = None
    is_default: Optional[bool] = None


    constitution: Optional[str] = None
    source_conversation_id: Optional[int] = None


class PatientProfileResponse(PatientProfileBase):
    """档案响应 Schema"""
    id: int
    user_id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PatientProfileSummary(BaseModel):
    """档案摘要（用于对话 prompt 拼接）"""
    id: int
    name: str
    gender: str
    age: str
    residence: str = ""
    diseases: List[str] = Field(default_factory=list)
    symptoms: List[str] = Field(default_factory=list)
    tcm_syndrome: str = ""
    chief_complaint: str = ""
    family_history: List[dict] = Field(default_factory=list)
    is_family_member: bool = False
    constitution: str = ""


# ─── Prompt 格式化输出 ─────────────────────────────────────────────

class ProfilePromptInfo(BaseModel):
    """格式化后的档案信息字符串（注入 LLM prompt）"""
    text: str
