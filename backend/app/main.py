"""FastAPI 入口 + 后台巡检线程（通知重试 / SLA 持续提醒 / 死信转人工）。"""
from __future__ import annotations

import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import Base, SessionLocal, engine
from .routers import auth, doctor, nurse, patient, pharmacist, queue, staff
from .seed import seed
from .services import notifications as notify_svc
from .services import tasks as task_svc

_sweep_stop = threading.Event()


def _sweep_loop():
    # 每轮依次：投递到期通知 → SLA 超时提醒 → 死信转人工
    while not _sweep_stop.wait(settings.SWEEP_INTERVAL_SECONDS):
        try:
            db = SessionLocal()
            try:
                notify_svc.deliver_pending(db)
                task_svc.sweep_sla(db)
                task_svc.sweep_dead_notifications(db)
            finally:
                db.close()
        except Exception:
            # 巡检失败不能拖垮进程
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.AUTO_SCHEMA:
        if not settings.DATABASE_URL.startswith("sqlite"):
            # compose 中数据库由镜像 MARIADB_DATABASE 创建；这里仅在账号有权限时兜底建库，
            # 无全局 CREATE 权限（常见的最小授权）则忽略，依赖数据库已存在。
            try:
                with engine.connect() as conn:
                    from sqlalchemy import text
                    db_name = settings.DATABASE_URL.rsplit("/", 1)[-1].split("?")[0]
                    conn.execute(text(
                        f"CREATE DATABASE IF NOT EXISTS `{db_name}` "
                        "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                    ))
                    conn.commit()
            except Exception as exc:  # 权限不足或已存在：交由 create_all 验证连接
                print(f"[startup] skip CREATE DATABASE ({exc.__class__.__name__}: {exc})")
        Base.metadata.create_all(bind=engine)
    if settings.AUTO_SEED:
        db = SessionLocal()
        try:
            seed(db)
        finally:
            db.close()
    Path(settings.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)

    worker = None
    if settings.RUN_BACKGROUND:
        worker = threading.Thread(target=_sweep_loop, name="sweep", daemon=True)
        worker.start()
    yield
    _sweep_stop.set()


app = FastAPI(
    title="出院后分级随访与高风险升级处置系统",
    version="1.0.0",
    description=(
        "基于患者身份/手术/出院医嘱/过敏史/用药计划生成分级随访；"
        "患者多入口受限上报，高风险自动冻结普通随访并升级；"
        "护士初筛三动作、医生补录/撤回医嘱、药师仅用药审方；"
        "事件时间线全程可追溯，角色字段级脱敏。"
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (auth.router, patient.router, staff.router, nurse.router,
          doctor.router, pharmacist.router, queue.router):
    app.include_router(r)


@app.get("/healthz", tags=["meta"])
def healthz():
    return {"status": "ok"}
