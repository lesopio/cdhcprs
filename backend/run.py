"""
后端服务启动脚本
从环境变量读取配置并启动 uvicorn 服务器
"""
import uvicorn
from core.config import get_settings


def main():
    """主函数：从配置中读取 host 和 port 并启动服务器"""
    settings = get_settings()

    print(f"正在启动 {settings.APP_NAME} 后端服务...")
    print(f"服务地址: http://{settings.BACKEND_HOST}:{settings.BACKEND_PORT}")
    print(f"API 文档: http://{settings.BACKEND_HOST}:{settings.BACKEND_PORT}/docs")
    print(f"调试模式: {'开启' if settings.DEBUG else '关闭'}")
    print("-" * 60)

    uvicorn.run(
        "main:app",
        host=settings.BACKEND_HOST,
        port=settings.BACKEND_PORT,
        reload=settings.DEBUG,  # 调试模式下启用热重载
    )


if __name__ == "__main__":
    main()
