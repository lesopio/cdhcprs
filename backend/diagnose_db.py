"""
数据库诊断脚本
检查是否存在孤立消息和ID复用问题
"""
import sys
import sqlite3
import os


def diagnose_database(db_path="cdhcprs.db"):
    """诊断数据库问题"""
    if not os.path.exists(db_path):
        print(f"[INFO] 数据库文件不存在: {db_path}")
        print("[INFO] 这是全新安装，不存在历史数据问题")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        print("=" * 60)
        print("数据库诊断报告")
        print("=" * 60)
        print(f"数据库路径: {db_path}\n")

        # 1. 检查表结构
        print("1. 检查 conversations 表结构：")
        cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'")
        result = cursor.fetchone()
        if result:
            print(result[0])
            if "AUTOINCREMENT" in result[0]:
                print("✓ 使用了 AUTOINCREMENT，ID不会被复用")
            else:
                print("✗ 未使用 AUTOINCREMENT，ID可能被复用！")
        print()

        # 2. 检查外键约束状态
        print("2. 检查外键约束状态：")
        cursor.execute("PRAGMA foreign_keys")
        fk_status = cursor.fetchone()
        if fk_status and fk_status[0] == 1:
            print("✓ 外键约束已启用")
        else:
            print("✗ 外键约束未启用")
        print()

        # 3. 统计数据
        print("3. 数据统计：")
        cursor.execute("SELECT COUNT(*) FROM conversations")
        conv_count = cursor.fetchone()[0]
        print(f"   对话总数: {conv_count}")

        cursor.execute("SELECT COUNT(*) FROM messages")
        msg_count = cursor.fetchone()[0]
        print(f"   消息总数: {msg_count}")

        # 4. 检查孤立消息
        print("\n4. 检查孤立消息：")
        cursor.execute("""
            SELECT COUNT(*) FROM messages m
            LEFT JOIN conversations c ON m.conversation_id = c.id
            WHERE c.id IS NULL
        """)
        orphaned_count = cursor.fetchone()[0]

        if orphaned_count > 0:
            print(f"✗ 发现 {orphaned_count} 条孤立消息！")

            cursor.execute("""
                SELECT m.id, m.conversation_id, m.role,
                       substr(m.content, 1, 50) as content_preview
                FROM messages m
                LEFT JOIN conversations c ON m.conversation_id = c.id
                WHERE c.id IS NULL
                LIMIT 10
            """)
            orphaned = cursor.fetchall()
            print("   前10条孤立消息：")
            for msg_id, conv_id, role, preview in orphaned:
                print(f"     - 消息ID: {msg_id}, 对话ID: {conv_id}, 角色: {role}")
                print(f"       内容: {preview}...")
        else:
            print("✓ 没有孤立消息")
        print()

        # 5. 检查对话ID的连续性
        print("5. 检查对话ID分布：")
        cursor.execute("SELECT MIN(id), MAX(id) FROM conversations")
        result = cursor.fetchone()
        if result[0]:
            min_id, max_id = result
            print(f"   ID范围: {min_id} - {max_id}")
            expected_count = max_id - min_id + 1
            if expected_count != conv_count:
                print(f"✗ ID不连续！预期 {expected_count} 个对话，实际 {conv_count} 个")
                print(f"   可能有 {expected_count - conv_count} 个对话被删除")
            else:
                print("✓ ID连续")
        print()

        # 6. 检查是否有消息的conversation_id不存在
        print("6. 检查消息引用完整性：")
        cursor.execute("""
            SELECT DISTINCT m.conversation_id
            FROM messages m
            LEFT JOIN conversations c ON m.conversation_id = c.id
            WHERE c.id IS NULL
            ORDER BY m.conversation_id
        """)
        missing_convs = cursor.fetchall()
        if missing_convs:
            print(f"✗ 有消息引用了不存在的对话ID：")
            for (conv_id,) in missing_convs[:10]:
                cursor.execute("SELECT COUNT(*) FROM messages WHERE conversation_id = ?", (conv_id,))
                msg_count = cursor.fetchone()[0]
                print(f"   - 对话ID {conv_id}: {msg_count} 条消息")
        else:
            print("✓ 所有消息都有有效的对话引用")
        print()

        # 7. 建议
        print("=" * 60)
        print("建议措施：")
        print("=" * 60)
        if orphaned_count > 0:
            print("1. 运行清理脚本: python cleanup_db.py")
        if "AUTOINCREMENT" not in (result[0] if result else ""):
            print("2. 重建数据库表结构以使用 AUTOINCREMENT")
        if not (fk_status and fk_status[0] == 1):
            print("3. 确保应用程序启用了外键约束")

    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    db_path = sys.argv[1] if len(sys.argv) > 1 else "cdhcprs.db"
    diagnose_database(db_path)
