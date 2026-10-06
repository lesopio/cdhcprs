# 慢性病诊疗方案推荐系统

简体中文 | [English](README_en.md)

基于 FastAPI + Vue3 的智能慢性病诊疗方案推荐系统，采用大语言模型（LLM）提供专业的中医诊疗建议。

## 项目简介

本系统是一个现代化的 Web 应用程序，旨在为慢性病患者提供智能化的诊疗方案推荐服务。系统采用前后端分离架构，支持实时流式响应，提供友好的用户界面和完善的管理后台。

### 核心特性

- **国风设计**：采用中医传统配色（#f0a04b），提供优雅的用户体验
- **智能对话**：基于大语言模型的实时流式对话，支持 Markdown 渲染和代码高亮
- **安全认证**：JWT 令牌认证，完善的权限控制系统
- **灵活配置**：支持多个 LLM 提供商（DeepSeek、Qwen、OpenAI、OpenAIful），支持自动同步模型列表
- **管理后台**：用户管理、对话管理、系统设置等完整的管理功能
- **模型切换**：支持动态切换 LLM 模型，自动处理历史对话

## 技术栈

### 后端

- **框架**: FastAPI 0.118+
- **数据库**: SQLite 3 + SQLAlchemy 2.0+
- **认证**: JWT (python-jose)
- **密码加密**: bcrypt
- **LLM 集成**: OpenAI-compatible API
- **环境管理**: uv

### 前端

- **框架**: Vue 3 + TypeScript
- **构建工具**: Vite (Rolldown)
- **UI 库**: Element Plus 2.11+
- **状态管理**: Pinia 3.0+
- **路由**: Vue Router 4.5+
- **HTTP 客户端**: Axios 1.12+
- **Markdown 渲染**: markdown-it 14.1+
- **代码高亮**: highlight.js 11.11+
- **包管理**: pnpm

## 快速开始

### 环境要求

- Python 3.9+
- Node.js 18+
- pnpm 10+
- uv (Python 包管理器)

### 安装步骤

#### 1. 克隆项目

```bash
git clone https://github.com/xinyang20/CDHCPRS.git
cd CDHCPRS
```

#### 2. 配置环境变量

```bash
# 在项目根目录配置环境变量
cp .env.example .env
# 编辑 .env 文件，设置 SECRET_KEY 等配置
# 可以自定义前后端端口：BACKEND_PORT、FRONTEND_PORT
```

#### 3. 后端设置

```bash
# 进入后端目录
cd backend

# 安装依赖（使用 uv）
uv sync

# 初始化数据库
uv run python init_db.py

# 启动后端服务（推荐方式：自动从 .env 读取配置）
uv run python run.py

# 或使用传统方式（需要手动指定端口）
# uv run uvicorn main:app --reload --host 127.0.0.1 --port 8001
```

后端服务将在 http://127.0.0.1:8001 启动（可在 .env 中修改端口）

#### 4. 前端设置

```bash
# 进入前端目录
cd frontend

# 安装依赖
pnpm install

# 启动开发服务器（自动从 .env 读取端口配置）
pnpm run dev
```

前端服务将在 http://localhost:5173 启动（可在 .env 中修改端口）

### 默认账户

系统初始化后会创建默认管理员账户：

- **用户名**: admin
- **密码**: admin123

⚠️ **重要**: 首次登录后请立即修改默认密码！

## 使用指南

### 普通用户

1. **注册账户**: 访问注册页面创建新账户
2. **登录系统**: 使用用户名和密码登录
3. **创建对话**: 点击"新建对话"开始咨询
4. **发送消息**: 在输入框中输入问题，按 Ctrl+Enter 或点击发送按钮
5. **查看历史**: 在侧边栏查看和切换历史对话
6. **修改密码**: 在个人信息页面修改密码

### 管理员

1. **用户管理**: 查看所有用户，封禁/解封用户，删除用户
2. **对话管理**: 查看所有对话，删除不当对话
3. **系统设置**:
   - 修改网站名称
   - 配置系统提示词
   - 切换 LLM 提供商和模型
   - 测试 LLM 连接

## 配置说明

### 环境变量配置 (.env)

所有配置统一在项目根目录的 `.env` 文件中管理：

```env
# 服务器端口配置
BACKEND_HOST=127.0.0.1        # 后端服务器地址
BACKEND_PORT=8001              # 后端服务器端口
FRONTEND_PORT=5173             # 前端开发服务器端口
VITE_API_BASE_URL=http://127.0.0.1:8001  # 前端 API 地址（开发环境）

# 数据库配置
DATABASE_URL=sqlite:///./cdhcprs.db

# JWT 配置
SECRET_KEY=your-secret-key-here  # 请修改为随机字符串
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30

# 应用配置
APP_NAME=慢性病诊疗方案推荐系统
DEBUG=True
```

**重要提示：**
- 首次使用请复制 `.env.example` 为 `.env`
- 必须修改 `SECRET_KEY` 为随机字符串
- 修改端口后需要重启服务
- 生产环境请将 `DEBUG` 设置为 `False`，`VITE_API_BASE_URL` 留空

### LLM 配置

在管理后台的"系统设置"中配置：

- **LLM 提供商**: deepseek / qwen / openai
- **API Key**: 您的 LLM API 密钥
- **模型 ID**:
  - DeepSeek: deepseek-chat
  - Qwen: qwen-plus / qwen-turbo
  - OpenAI: gpt-3.5-turbo / gpt-4

## API 文档

后端启动后，访问以下地址查看 API 文档：

- Swagger UI: http://127.0.0.1:8001/docs
- ReDoc: http://127.0.0.1:8001/redoc

### 主要 API 端点

#### 认证相关

- `POST /api/auth/register` - 用户注册
- `POST /api/auth/token` - 用户登录
- `GET /api/auth/users/me` - 获取当前用户信息
- `PUT /api/auth/users/me/password` - 修改密码

#### 对话相关

- `POST /api/chat/conversations` - 创建对话
- `GET /api/chat/conversations` - 获取对话列表
- `GET /api/chat/conversations/{id}/messages` - 获取消息历史
- `POST /api/chat/conversations/{id}/messages` - 发送消息（流式响应）
- `DELETE /api/chat/conversations/{id}` - 删除对话

#### 管理员相关

- `GET /api/admin/users` - 获取用户列表
- `PUT /api/admin/users/{id}` - 更新用户状态
- `DELETE /api/admin/users/{id}` - 删除用户
- `GET /api/admin/conversations` - 获取所有对话
- `GET /api/admin/settings` - 获取系统设置
- `PUT /api/admin/settings` - 更新系统设置
- `POST /api/admin/settings/test-connection` - 测试 LLM 连接

## 安全特性

- ✅ JWT 令牌认证
- ✅ bcrypt 密码加密
- ✅ 基于角色的权限控制（RBAC）
- ✅ CORS 跨域保护
- ✅ SQL 注入防护（SQLAlchemy ORM）
- ✅ XSS 防护（前端输入验证）

## 开发说明

### 后端开发

```bash
# 进入后端目录
cd backend

# 安装新依赖
uv add <package-name>

# 运行开发服务器（推荐）
uv run python run.py

# 或使用 uvicorn（需要手动指定端口）
# uv run uvicorn main:app --reload --host 127.0.0.1 --port 8001
```

### 前端开发

```bash
# 进入前端目录
cd frontend

# 安装新依赖
pnpm install <package-name>

# 运行开发服务器（自动读取 .env 中的端口配置）
pnpm run dev

# 构建生产版本
pnpm run build
```

### 修改端口

如需修改前后端端口，只需编辑项目根目录的 `.env` 文件：

```env
BACKEND_PORT=8001      # 修改后端端口
FRONTEND_PORT=5173     # 修改前端端口
VITE_API_BASE_URL=http://127.0.0.1:8001  # 同步修改前端 API 地址
```

修改后重启服务即可生效。

## 许可证

本项目采用 [Apache2.0 许可证](LICENSE)。

---

**注意**: 本系统仅供学习和研究使用，不构成医疗建议。如有健康问题，请咨询专业医生。
