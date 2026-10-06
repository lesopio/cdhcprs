"""
系统设置数据模型
"""
from sqlalchemy import Column, String, Text
from core.database import Base


class SystemSetting(Base):
    """系统设置模型"""
    
    __tablename__ = "system_settings"
    
    key = Column(String, primary_key=True, index=True)
    value = Column(Text, nullable=False)
    
    def __repr__(self):
        return f"<SystemSetting(key='{self.key}')>"

