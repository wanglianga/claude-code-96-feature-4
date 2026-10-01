import os
import tempfile

# 必须在导入 app.* 之前设置：测试全程使用独立 SQLite，不触碰 MariaDB
_tmp = tempfile.mkdtemp(prefix="fu-test-")
os.environ.setdefault("APP_DATABASE_URL", f"sqlite:///{_tmp}/test.db")
os.environ.setdefault("APP_UPLOAD_DIR", tempfile.mkdtemp(prefix="fu-upload-"))
os.environ.setdefault("APP_RUN_BACKGROUND", "0")
os.environ.setdefault("APP_AUTO_SCHEMA", "0")
os.environ.setdefault("APP_AUTO_SEED", "0")
os.environ.setdefault("APP_SLA_MINUTES_HIGH", "120")
os.environ.setdefault("APP_DEDUP_WINDOW_SECONDS", "600")
os.environ.setdefault("APP_NOTIFY_BACKOFF_SECONDS", "1")
os.environ.setdefault("APP_SLA_REMINDER_INTERVAL_SECONDS", "0")
os.environ.setdefault("APP_SLA_QUEUE_AFTER", "2")

from datetime import datetime, timedelta  # noqa: E402

import pytest  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.models import FollowUpTask, Patient, Staff  # noqa: E402
from app.routers.auth import hash_password  # noqa: E402
from app.services.discharge import discharge_and_plan  # noqa: E402


from sqlalchemy import text  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db():
    # 存在 escalations↔reports 循环外键，清库时临时关闭 FK 检查
    with engine.begin() as conn:
        conn.execute(text("PRAGMA foreign_keys=OFF"))
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    db = SessionLocal()
    db.add_all([
        Staff(username="n1", name="王护士", role="nurse",
              password_hash=hash_password("x")),
        Staff(username="n2", name="陈护士", role="nurse",
              password_hash=hash_password("x")),
        Staff(username="d1", name="李医生", role="doctor",
              password_hash=hash_password("x")),
        Staff(username="p1", name="周药师", role="pharmacist",
              password_hash=hash_password("x")),
        Staff(username="n3", name="坏通道护士", role="nurse",
              password_hash=hash_password("x"), notify_failing=True),
    ])
    db.commit()
    yield db
    db.close()


def make_patient(db, **kw) -> Patient:
    now = datetime.utcnow()
    n = db.query(Patient).count() + 1
    defaults = dict(
        code=f"P{n:04d}", name="测试患者", gender="男", birth_date="1980-01-01",
        phone="13800001111", id_card_tail="1111", department="普外科",
        surgery_type="腹腔镜阑尾切除", surgery_date="2026-09-25",
        discharge_date="2026-09-28", discharge_orders="保持伤口干燥",
        allergy="青霉素", consent_until=now + timedelta(days=30),
        contact_refused=False,
    )
    defaults.update(kw)
    p = Patient(**defaults)
    db.add(p)
    db.commit()
    discharge_and_plan(db, p, now - timedelta(days=1))
    db.commit()
    return p


def staff(db, username):
    return db.scalar(select(Staff).where(Staff.username == username))
