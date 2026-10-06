"""轻量、幂等的 SQLite 结构迁移。"""
from sqlalchemy import inspect, text

from core.database import Base, SessionLocal, engine
import models  # noqa: F401 - register every model before create_all
from models.model_config import ModelConfig  # noqa: F401 - model_configs 表幂等建表依赖此注册
from models.system_setting import SystemSetting
from services.secret_settings import PREFIX, SECRET_SETTING_KEYS, encrypt_secret


MESSAGE_COLUMNS = {
    "trace_json": "TEXT",
    "citations_json": "TEXT",
    "generation_status": "VARCHAR DEFAULT 'completed' NOT NULL",
    "feedback": "VARCHAR",
    "analysis_summary": "TEXT",
}

CONVERSATION_COLUMNS = {
    "patient_profile_id": "INTEGER",
    "triage_json": "TEXT",
    "consultation_mode": "VARCHAR(20) DEFAULT 'free' NOT NULL",
    "intake_state_json": "TEXT",
}

PATIENT_COLUMNS = {
    "constitution": "VARCHAR(100)",
    "source_conversation_id": "INTEGER",
}

ATTACHMENT_COLUMNS = {"analysis_path": "TEXT"}

USER_COLUMNS = {
    "failed_login_attempts": "INTEGER DEFAULT 0 NOT NULL",
    "locked_until": "DATETIME",
    "last_failed_login_at": "DATETIME",
    # 每日配额单人 override（JSON 文本，NULL=跟随全局）；user_daily_usage 表由 create_all 幂等建表
    "quota_override_json": "TEXT",
}


def run_schema_migrations() -> None:
    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    if "messages" not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns("messages")}
    with engine.begin() as connection:
        for name, ddl in MESSAGE_COLUMNS.items():
            if name not in existing:
                connection.execute(text(f"ALTER TABLE messages ADD COLUMN {name} {ddl}"))

    if "conversations" in inspector.get_table_names():
        conversation_existing = {column["name"] for column in inspector.get_columns("conversations")}
        with engine.begin() as connection:
            for name, ddl in CONVERSATION_COLUMNS.items():
                if name not in conversation_existing:
                    connection.execute(text(f"ALTER TABLE conversations ADD COLUMN {name} {ddl}"))

    if "patient_profiles" in inspector.get_table_names():
        patient_existing = {column["name"] for column in inspector.get_columns("patient_profiles")}
        with engine.begin() as connection:
            for name, ddl in PATIENT_COLUMNS.items():
                if name not in patient_existing:
                    connection.execute(text(f"ALTER TABLE patient_profiles ADD COLUMN {name} {ddl}"))

    if "attachments" in inspector.get_table_names():
        attachment_existing = {column["name"] for column in inspector.get_columns("attachments")}
        with engine.begin() as connection:
            for name, ddl in ATTACHMENT_COLUMNS.items():
                if name not in attachment_existing:
                    connection.execute(text(f"ALTER TABLE attachments ADD COLUMN {name} {ddl}"))

    if "users" in inspector.get_table_names():
        user_existing = {column["name"] for column in inspector.get_columns("users")}
        with engine.begin() as connection:
            for name, ddl in USER_COLUMNS.items():
                if name not in user_existing:
                    connection.execute(text(f"ALTER TABLE users ADD COLUMN {name} {ddl}"))

    db = SessionLocal()
    try:
        secrets = db.query(SystemSetting).filter(SystemSetting.key.in_(SECRET_SETTING_KEYS)).all()
        changed = False
        for setting in secrets:
            if setting.value and not setting.value.startswith(PREFIX):
                setting.value = encrypt_secret(setting.value)
                changed = True
        if changed:
            db.commit()
    finally:
        db.close()
