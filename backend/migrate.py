"""
数据库迁移脚本 — 版本 1.1.0
新增：患者档案表 + 对话/消息 updated_at 字段
"""
import sqlite3
import os
from pathlib import Path


def get_db_path() -> str:
    """获取数据库文件路径（与 main.py 配置一致）"""
    # 默认使用 backend/cdhcprs.db
    backend_dir = Path(__file__).parent
    return str(backend_dir / "cdhcprs.db")


def run_migration():
    """执行迁移"""
    db_path = get_db_path()

    if not os.path.exists(db_path):
        print(f"[SKIP] 数据库文件不存在: {db_path}")
        print("       如需初始化数据库，请先运行: uv run python init_db.py")
        return

    print(f"正在连接数据库: {db_path}")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        # ── 检查 migrations 版本表 ──
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS _migration_version (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version TEXT NOT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        cursor.execute("SELECT version FROM _migration_version WHERE id = 1")
        row = cursor.fetchone()
        current_version = row[0] if row else "0.0.0"
        print(f"当前迁移版本: {current_version}")

        # ── 版本 0.0.0 → 1.1.0 ──
        if current_version < "1.1.0":
            print("\n[迁移 1.1.0] 患者档案系统 + updated_at 字段")

            # 1. conversations.updated_at
            print("  → 添加 conversations.updated_at ...", end=" ")
            try:
                cursor.execute("ALTER TABLE conversations ADD COLUMN updated_at TIMESTAMP")
                # SQLite 不支持 ADD COLUMN 带非恒定默认值，先加列再回填
                cursor.execute("UPDATE conversations SET updated_at = created_at WHERE updated_at IS NULL")
                print("OK")
            except sqlite3.OperationalError as e:
                if "duplicate column" in str(e).lower():
                    print("已存在，跳过")
                else:
                    raise

            # 2. messages.updated_at
            print("  → 添加 messages.updated_at ...", end=" ")
            try:
                cursor.execute("ALTER TABLE messages ADD COLUMN updated_at TIMESTAMP")
                cursor.execute("UPDATE messages SET updated_at = created_at WHERE updated_at IS NULL")
                print("OK")
            except sqlite3.OperationalError as e:
                if "duplicate column" in str(e).lower():
                    print("已存在，跳过")
                else:
                    raise

            # 3. patient_profiles 表
            print("  → 创建 patient_profiles 表 ...", end=" ")
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS patient_profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    name VARCHAR(50) NOT NULL DEFAULT '',
                    gender VARCHAR(10) NOT NULL DEFAULT '',
                    age VARCHAR(10) NOT NULL DEFAULT '',
                    phone VARCHAR(20) DEFAULT '',
                    residence VARCHAR(100) DEFAULT '',
                    diseases TEXT NOT NULL DEFAULT '[]',
                    symptoms TEXT NOT NULL DEFAULT '[]',
                    tcm_syndrome VARCHAR(200) DEFAULT '',
                    chief_complaint TEXT DEFAULT '',
                    family_history TEXT DEFAULT '[]',
                    is_family_member BOOLEAN NOT NULL DEFAULT 0,
                    primary_member_id INTEGER,
                    is_default BOOLEAN NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (primary_member_id) REFERENCES patient_profiles(id) ON DELETE SET NULL
                )
            """)
            print("OK")

            # 4. 索引
            print("  → 创建索引 ...", end=" ")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_patient_profiles_user_id ON patient_profiles(user_id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_patient_profiles_primary ON patient_profiles(primary_member_id)")
            print("OK")

            # 5. updated_at 自动更新触发器
            print("  → 创建 updated_at 触发器 ...", end=" ")
            cursor.execute("""
                CREATE TRIGGER IF NOT EXISTS trg_conversations_updated_at
                AFTER UPDATE ON conversations
                FOR EACH ROW
                BEGIN
                    UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
                END
            """)
            cursor.execute("""
                CREATE TRIGGER IF NOT EXISTS trg_messages_updated_at
                AFTER UPDATE ON messages
                FOR EACH ROW
                BEGIN
                    UPDATE messages SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
                END
            """)
            cursor.execute("""
                CREATE TRIGGER IF NOT EXISTS trg_patient_profiles_updated_at
                AFTER UPDATE ON patient_profiles
                FOR EACH ROW
                BEGIN
                    UPDATE patient_profiles SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
                END
            """)
            print("OK")

            # 6. 回填 existing rows 的 updated_at
            print("  → 回填现有行 updated_at ...", end=" ")
            cursor.execute("UPDATE conversations SET updated_at = created_at WHERE updated_at IS NULL")
            cursor.execute("UPDATE messages SET updated_at = created_at WHERE updated_at IS NULL")
            cursor.execute("UPDATE patient_profiles SET updated_at = created_at WHERE updated_at IS NULL")
            print("OK")

            # 更新版本
            cursor.execute("UPDATE _migration_version SET version = '1.1.0', applied_at = CURRENT_TIMESTAMP WHERE id = 1")
            if cursor.rowcount == 0:
                cursor.execute("INSERT INTO _migration_version (id, version) VALUES (1, '1.1.0')")
            print("  → 版本已更新至 1.1.0")

        conn.commit()
        print("\n✅ 迁移完成")

    except Exception as exc:
        conn.rollback()
        print(f"\n❌ 迁移失败: {exc}")
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    run_migration()
