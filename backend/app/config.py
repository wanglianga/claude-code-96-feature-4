import os


def _bool(v: str | None) -> bool:
    return (v or "").lower() in ("1", "true", "yes", "on")


# MariaDB（docker-compose db 服务 / 本地预装 MariaDB 均可）。
# 测试时用 APP_DATABASE_URL=sqlite:// 覆盖，不触碰 MariaDB。
DEFAULT_DATABASE_URL = (
    "mysql+pymysql://ccdev:ccdev@127.0.0.1:3306/ccdev?charset=utf8mb4"
)


class Settings:
    SECRET_KEY: str = os.getenv("APP_SECRET_KEY", "dev-secret-change-me-in-prod")
    DATABASE_URL: str = os.getenv("APP_DATABASE_URL", DEFAULT_DATABASE_URL)
    TOKEN_TTL_HOURS: int = int(os.getenv("APP_TOKEN_TTL_HOURS", "12"))
    UPLOAD_DIR: str = os.getenv("APP_UPLOAD_DIR", "/data/uploads")

    # 高风险事件闭环时限（分钟）
    SLA_MINUTES_HIGH: int = int(os.getenv("APP_SLA_MINUTES_HIGH", "120"))
    # 重复上报合并窗口（秒）：同患者同内容在不同入口落入同一时间桶视为重复
    DEDUP_WINDOW_SECONDS: int = int(os.getenv("APP_DEDUP_WINDOW_SECONDS", "600"))
    # 通知重试
    NOTIFY_MAX_ATTEMPTS: int = int(os.getenv("APP_NOTIFY_MAX_ATTEMPTS", "5"))
    NOTIFY_BACKOFF_SECONDS: int = int(os.getenv("APP_NOTIFY_BACKOFF_SECONDS", "30"))
    # SLA 持续提醒间隔（秒）与升级到人工队列的提醒次数
    SLA_REMINDER_INTERVAL_SECONDS: int = int(
        os.getenv("APP_SLA_REMINDER_INTERVAL_SECONDS", "1800")
    )
    SLA_QUEUE_AFTHER_REMINDERS: int = int(os.getenv("APP_SLA_QUEUE_AFTER", "2"))
    # 后台轮询（秒）
    SWEEP_INTERVAL_SECONDS: int = int(os.getenv("APP_SWEEP_INTERVAL_SECONDS", "15"))
    AUTO_SCHEMA: bool = _bool(os.getenv("APP_AUTO_SCHEMA", "1"))
    AUTO_SEED: bool = _bool(os.getenv("APP_AUTO_SEED", "1"))
    RUN_BACKGROUND: bool = _bool(os.getenv("APP_RUN_BACKGROUND", "1"))


settings = Settings()
