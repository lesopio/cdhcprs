"""
数据库初始化脚本
创建所有表并插入默认数据
"""
from core.database import engine, Base, SessionLocal
from models import User, SystemSetting
import bcrypt


def hash_password(password: str) -> str:
    """哈希密码"""
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
    return hashed.decode('utf-8')


def init_database():
    """初始化数据库"""
    print("开始初始化数据库...")

    # 创建所有表
    Base.metadata.create_all(bind=engine)
    print("[OK] 数据库表创建成功")

    # 创建数据库会话
    db = SessionLocal()

    try:
        # 检查是否已有管理员账户
        admin = db.query(User).filter(User.username == "admin").first()
        if not admin:
            # 创建默认管理员账户
            hashed_password = hash_password("admin123")
            admin = User(
                username="admin",
                hashed_password=hashed_password,
                role="admin",
                is_banned=False
            )
            db.add(admin)
            print("[OK] 默认管理员账户创建成功 (用户名: admin, 密码: admin123)")
        else:
            print("[OK] 管理员账户已存在")
        
        # 设置默认系统配置
        default_settings = {
            "website_name": "慢性病诊疗方案推荐系统",
            "website_logo": "",
            "system_prompt": "你是一位专业的中医医生，擅长诊断和治疗各种慢性病。请根据患者提供的档案信息，给出专业的诊疗建议。回答时请标注参考文献来源。",
            "intake_system_prompt": (
                "你是中医慢病问诊助手。你的任务是通过主动提问，像医生面诊一样逐步收集患者的症状信息，"
                "而不是一次性给出诊断结论或长篇建议。\n\n"
                "每一轮你必须做到：\n"
                "1. 先用 1-2 句话回应患者刚才说的内容，让患者感受到你在认真倾听；\n"
                "2. 给出 3-6 个下一步需要确认的选项（症状、部位、性质、诱因、加重或缓解因素、伴随表现等），"
                "让患者像做选择题一样点选；\n"
                "3. 绝不在本轮就给出最终诊断、用药或大段科普。\n\n"
                "选项设计原则：\n"
                "- 每个选项简短通俗（5-15 个字），是普通患者能看懂的口语，避免专业术语；\n"
                "- 围绕当前主诉的可能病因、发病部位、症状性质、诱发因素、加重或缓解条件、伴随症状展开；\n"
                "- 可以混合单选与多选，但要让患者一眼就知道怎么选；\n"
                "- 不要重复患者已经明确告诉过你的信息。\n\n"
                "当你认为已经收集到足够症状信息、可以给出初步辅助诊疗建议时，把 complete 设为 true。\n"
                "在未收齐之前，complete 必须为 false。\n\n"
                "你只能输出下面的 JSON 格式，不要输出任何额外文字、解释或 Markdown 代码块标记：\n"
                "{\n"
                '  "reply": "回应患者的 1-2 句话",\n'
                '  "options": [\n'
                '    {"label": "选项文字", "multi": false}\n'
                "  ],\n"
                '  "complete": false\n'
                "}"
            ),
            "llm_provider": "deepseek",
            "llm_base_url": "https://api.deepseek.com/v1",
            "llm_api_key": "",
            "llm_model_id": "deepseek-chat",
            "large_font_scale": "1.5",
            # 推荐问题配置
            "suggested_questions_enabled": "false",
            "suggested_questions_provider": "deepseek",
            "suggested_questions_base_url": "",
            "suggested_questions_api_key": "",
            "suggested_questions_model_id": "",
            "suggested_questions_system_prompt": """你是一个智能助手，负责根据用户的对话历史，推测用户接下来可能想问的问题。
请仔细分析对话内容，生成3个用户可能感兴趣的后续问题。这些问题应该：
1. 与当前对话主题紧密相关
2. 具有延续性和深入性
3. 简洁明了，易于理解
请以 JSON 数组格式返回问题列表，例如：
["问题1", "问题2", "问题3"]""",
            "suggested_questions_count": "3",
            "suggested_questions_max_rounds": "5",
            "suggested_questions_template_questions": '["如何改善症状？", "需要注意什么饮食？", "有什么锻炼建议？", "药物治疗的副作用有哪些？", "病情恢复需要多长时间？"]',
            # 联网搜索配置
            "web_search_enabled": "true",
            "web_search_max_results": "5",
        }
        
        for key, value in default_settings.items():
            setting = db.query(SystemSetting).filter(SystemSetting.key == key).first()
            if not setting:
                setting = SystemSetting(key=key, value=value)
                db.add(setting)
        
        print("[OK] 默认系统配置设置成功")

        # 提交更改
        db.commit()
        print("\n数据库初始化完成！")
        print("\n默认管理员账户信息：")
        print("  用户名: admin")
        print("  密码: admin123")
        print("\n请在生产环境中立即修改默认密码！")

    except Exception as e:
        print(f"[ERROR] 初始化失败: {e}")
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    init_database()

