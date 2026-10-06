"""
数据库清理脚本
清理孤立的消息记录（对应的对话已被删除）

使用方法：
    python cleanup_db.py [数据库路径]

示例：
    python cleanup_db.py                    # 使用默认路径 ./cdhcprs.db
    python cleanup_db.py /path/to/db.db    # 使用指定路径
"""
import sys
import sqlite3
import os


def get_database_path():
    """获取数据库路径"""
    if len(sys.argv) > 1:
        return sys.argv[1]
    return "cdhcprs.db"


def cleanup_orphaned_messages(db_path):
    """清理孤立的消息记录"""
    if not os.path.exists(db_path):
        print(f"[ERROR] 数据库文件不存在: {db_path}")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        print("开始清理孤立的消息记录...")

        # 查找所有孤立的消息（conversation_id 不存在于 conversations 表中）
        cursor.execute("""
            SELECT m.id, m.conversation_id
            FROM messages m
            LEFT JOIN conversations c ON m.conversation_id = c.id
            WHERE c.id IS NULL
        """)

        orphaned_messages = cursor.fetchall()
        count = len(orphaned_messages)

        if count == 0:
            print("[OK] 没有发现孤立的消息记录")
            return

        print(f"[INFO] 发现 {count} 条孤立的消息记录")

        # 删除孤立的消息
        for msg_id, conv_id in orphaned_messages:
            print(f"  - 删除消息 ID: {msg_id}, 对话 ID: {conv_id}")
            cursor.execute("DELETE FROM messages WHERE id = ?", (msg_id,))

        conn.commit()
        print(f"[OK] 成功清理 {count} 条孤立的消息记录")

    except Exception as e:
        print(f"[ERROR] 清理失败: {e}")
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()


def verify_foreign_keys(db_path):
    """验证外键约束是否已启用"""
    if not os.path.exists(db_path):
        print(f"[ERROR] 数据库文件不存在: {db_path}")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        print("\n检查外键约束状态...")
        cursor.execute("PRAGMA foreign_keys")
        result = cursor.fetchone()

        if result and result[0] == 1:
            print("[OK] 外键约束已启用")
        else:
            print("[WARNING] 外键约束未启用！")
            print("  提示：从现在开始，应用程序会自动启用外键约束")

    finally:
        cursor.close()
        conn.close()


def show_statistics(db_path):
    """显示数据库统计信息"""
    if not os.path.exists(db_path):
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        print("\n数据库统计信息：")

        # 统计对话数
        cursor.execute("SELECT COUNT(*) FROM conversations")
        conv_count = cursor.fetchone()[0]
        print(f"  - 对话总数: {conv_count}")

        # 统计消息数
        cursor.execute("SELECT COUNT(*) FROM messages")
        msg_count = cursor.fetchone()[0]
        print(f"  - 消息总数: {msg_count}")

        # 统计用户数
        cursor.execute("SELECT COUNT(*) FROM users")
        user_count = cursor.fetchone()[0]
        print(f"  - 用户总数: {user_count}")

    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    print("=" * 50)
    print("数据库清理工具")
    print("=" * 50)

    db_path = get_database_path()
    print(f"数据库路径: {db_path}")

    verify_foreign_keys(db_path)
    cleanup_orphaned_messages(db_path)
    show_statistics(db_path)

    print("\n清理完成！")
