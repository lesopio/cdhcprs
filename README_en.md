# Chronic Disease Healthcare Plan Recommendation System

[简体中文](README.md) | English

An intelligent chronic disease healthcare plan recommendation system based on FastAPI + Vue3, powered by Large Language Models (LLM) to provide professional Traditional Chinese Medicine (TCM) treatment recommendations.

## Project Overview

This system is a modern web application designed to provide intelligent healthcare plan recommendation services for chronic disease patients. It adopts a frontend-backend separation architecture, supports real-time streaming responses, and offers a user-friendly interface with a comprehensive management backend.

### Core Features

- **Traditional Chinese Design**: Adopts TCM traditional color scheme (#f0a04b) for an elegant user experience
- **Intelligent Dialogue**: Real-time streaming conversation based on Large Language Models, with Markdown rendering and code highlighting
- **Secure Authentication**: JWT token authentication with comprehensive permission control system
- **Flexible Configuration**: Supports multiple LLM providers (DeepSeek, Qwen, OpenAI, OpenAIful) with automatic model list sync
- **Management Backend**: Complete management features including user management, conversation management, and system settings
- **Model Switching**: Supports dynamic LLM model switching with automatic conversation history handling

## Technology Stack

### Backend

- **Framework**: FastAPI 0.118+
- **Database**: SQLite 3 + SQLAlchemy 2.0+
- **Authentication**: JWT (python-jose)
- **Password Encryption**: bcrypt
- **LLM Integration**: OpenAI-compatible API
- **Environment Management**: uv

### Frontend

- **Framework**: Vue 3 + TypeScript
- **Build Tool**: Vite (Rolldown)
- **UI Library**: Element Plus 2.11+
- **State Management**: Pinia 3.0+
- **Router**: Vue Router 4.5+
- **HTTP Client**: Axios 1.12+
- **Markdown Rendering**: markdown-it 14.1+
- **Code Highlighting**: highlight.js 11.11+
- **Package Manager**: pnpm

## Quick Start

### Requirements

- Python 3.9+
- Node.js 18+
- pnpm 10+
- uv (Python package manager)

### Installation

#### 1. Clone the Repository

```bash
git clone https://github.com/xinyang20/CDHCPRS.git
cd CDHCPRS
```

#### 2. Backend Setup

```bash
# Navigate to backend directory
cd backend

# Install dependencies (using uv)
uv sync

# Configure environment variables
cp .env.example .env
# Edit .env file to set SECRET_KEY and other configurations

# Initialize database
uv run python init_db.py

# Start backend service
uv run uvicorn main:app --reload --host 127.0.0.1 --port 8001
```

Backend service will start at http://127.0.0.1:8001

#### 3. Frontend Setup

```bash
# Navigate to frontend directory
cd frontend

# Install dependencies
pnpm install

# Start development server
pnpm run dev
```

Frontend service will start at http://localhost:5173

### Default Account

After system initialization, a default administrator account will be created:

- **Username**: admin
- **Password**: admin123

⚠️ **Important**: Please change the default password immediately after first login!

## User Guide

### Regular Users

1. **Register Account**: Visit the registration page to create a new account
2. **Login**: Use username and password to login
3. **Create Conversation**: Click "New Conversation" to start consultation
4. **Send Messages**: Enter your question in the input box, press Ctrl+Enter or click the send button
5. **View History**: View and switch between historical conversations in the sidebar
6. **Change Password**: Modify password in the personal information page

### Administrators

1. **User Management**: View all users, ban/unban users, delete users
2. **Conversation Management**: View all conversations, delete inappropriate conversations
3. **System Settings**:
   - Modify website name
   - Configure system prompts
   - Switch LLM providers and models
   - Test LLM connection

## Configuration

### Backend Configuration (.env)

```env
# Database configuration
DATABASE_URL=sqlite:///./cdhcprs.db

# JWT configuration
SECRET_KEY=your-secret-key-here  # Please change to a random string
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30

# Application configuration
APP_NAME=慢性病诊疗方案推荐系统
```

### LLM Configuration

Configure in the "System Settings" section of the management backend:

- **LLM Provider**: deepseek / qwen / openai
- **API Key**: Your LLM API key
- **Model ID**:
  - DeepSeek: deepseek-chat
  - Qwen: qwen-plus / qwen-turbo
  - OpenAI: gpt-3.5-turbo / gpt-4

## API Documentation

After starting the backend, visit the following URLs to view API documentation:

- Swagger UI: http://127.0.0.1:8001/docs
- ReDoc: http://127.0.0.1:8001/redoc

### Main API Endpoints

#### Authentication

- `POST /api/auth/register` - User registration
- `POST /api/auth/token` - User login
- `GET /api/auth/users/me` - Get current user information
- `PUT /api/auth/users/me/password` - Change password

#### Conversations

- `POST /api/chat/conversations` - Create conversation
- `GET /api/chat/conversations` - Get conversation list
- `GET /api/chat/conversations/{id}/messages` - Get message history
- `POST /api/chat/conversations/{id}/messages` - Send message (streaming response)
- `DELETE /api/chat/conversations/{id}` - Delete conversation

#### Administration

- `GET /api/admin/users` - Get user list
- `PUT /api/admin/users/{id}` - Update user status
- `DELETE /api/admin/users/{id}` - Delete user
- `GET /api/admin/conversations` - Get all conversations
- `GET /api/admin/settings` - Get system settings
- `PUT /api/admin/settings` - Update system settings
- `POST /api/admin/settings/test-connection` - Test LLM connection

## Security Features

- ✅ JWT token authentication
- ✅ bcrypt password encryption
- ✅ Role-Based Access Control (RBAC)
- ✅ CORS protection
- ✅ SQL injection protection (SQLAlchemy ORM)
- ✅ XSS protection (frontend input validation)

## Development

### Backend Development

```bash
# Install new dependencies
uv add <package-name>

# Run development server
uv run uvicorn main:app --reload --host 127.0.0.1 --port 8001
```

### Frontend Development

```bash
# Install new dependencies
pnpm install <package-name>

# Run development server
pnpm run dev

# Build for production
pnpm run build
```

## License

This project is licensed under the [Apache 2.0 License](LICENSE).

---

**Note**: This system is for educational and research purposes only and does not constitute medical advice. For health concerns, please consult a professional healthcare provider.
