"""演示种子数据：建表后若库为空则写入。"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    FollowUpTask, MedicationPlan, Patient, Staff,
)
from .routers.auth import hash_password
from .services.discharge import discharge_and_plan
from .services.reports import submit_report


STAFF = [
    # username, name, role, dept, password, notify_failing
    ("nurse.wang", "王敏", "nurse", "随访中心", "nurse123", False),
    ("nurse.chen", "陈静", "nurse", "急诊护理", "nurse123", True),   # 通知通道故障（演示重试/死信）
    ("doctor.li", "李建国", "doctor", "心外科", "doctor123", False),
    ("doctor.sun", "孙磊", "doctor", "普外科", "doctor123", False),
    ("pharma.zhou", "周药", "pharmacist", "药剂科", "pharma123", False),
    ("admin", "管理员", "admin", "运营", "admin123", False),
]

# code, name, tail, dept, surgery, discharge offset 天, 出院医嘱, 过敏, 用药, consent days, refused
PATIENTS = [
    {
        "code": "P2026001", "name": "张伟", "gender": "男", "birth": "1968-03-11",
        "phone": "13800001234", "tail": "1234", "dept": "心外科",
        "surgery": "心脏搭桥（CABG）", "surgery_offset": 3, "discharge_offset": 2,
        "orders": "口服华法林抗凝，每日监测；伤口换药；控制血压",
        "allergy": "青霉素",
        "meds": [("华法林钠片", "3mg", "每日1次", 30), ("美托洛尔", "25mg", "每日2次", 30)],
        "consent_days": 30, "refused": False,
    },
    {
        "code": "P2026002", "name": "李娜", "gender": "女", "birth": "1985-09-02",
        "phone": "13900005678", "tail": "5678", "dept": "普外科",
        "surgery": "腹腔镜胆囊切除术", "surgery_offset": 4, "discharge_offset": 3,
        "orders": "保持切口干燥；布洛芬必要时止痛；清淡饮食",
        "allergy": "无",
        "meds": [("布洛芬缓释胶囊", "0.3g", "每12小时1次", 5)],
        "consent_days": 14, "refused": False,
    },
    {
        "code": "P2026003", "name": "王芳", "gender": "女", "birth": "1992-12-20",
        "phone": "13700009012", "tail": "9012", "dept": "妇产科",
        "surgery": "剖宫产", "surgery_offset": 5, "discharge_offset": 4,
        "orders": "产后42天复查；母乳喂养指导；发热随诊",
        "allergy": "磺胺类",
        "meds": [("益母草颗粒", "1袋", "每日2次", 7)],
        "consent_days": 21, "refused": False,
    },
    {
        "code": "P2026004", "name": "刘强", "gender": "男", "birth": "1979-06-30",
        "phone": "13600003456", "tail": "3456", "dept": "普外科",
        "surgery": "背部脂肪瘤切除术", "surgery_offset": 2, "discharge_offset": 1,
        "orders": "保持伤口干燥，7天拆线",
        "allergy": "无",
        "meds": [("头孢克洛", "0.25g", "每日3次", 3)],
        "consent_days": -2, "refused": False,  # 授权已过期（演示人工队列）
    },
    {
        "code": "P2026005", "name": "赵敏", "gender": "女", "birth": "1971-08-08",
        "phone": "13500007890", "tail": "7890", "dept": "骨科",
        "surgery": "膝关节置换术", "surgery_offset": 6, "discharge_offset": 5,
        "orders": "抗凝预防血栓；康复训练；术后2周复诊",
        "allergy": "阿司匹林诱发哮喘",
        "meds": [("利伐沙班", "10mg", "每日1次", 14)],
        "consent_days": 30, "refused": True,  # 患者拒绝电话联系
    },
]


def seed(db: Session) -> bool:
    if db.scalar(select(Staff.id).limit(1)):
        return False
    now = datetime.utcnow()

    for username, name, role, dept, pwd, failing in STAFF:
        db.add(Staff(username=username, name=name, role=role, department=dept,
                     password_hash=hash_password(pwd), notify_failing=failing))

    for spec in PATIENTS:
        discharge_dt = (now - timedelta(days=spec["discharge_offset"])).replace(
            hour=10, minute=0, second=0, microsecond=0
        )
        discharge_str = discharge_dt.date().isoformat()
        surgery_date = (now - timedelta(days=spec["surgery_offset"])).date().isoformat()
        p = Patient(
            code=spec["code"], name=spec["name"], gender=spec["gender"],
            birth_date=spec["birth"], phone=spec["phone"], id_card_tail=spec["tail"],
            department=spec["dept"], surgery_type=spec["surgery"],
            surgery_date=surgery_date,
            discharge_date=discharge_str,
            discharge_orders=spec["orders"], allergy=spec["allergy"],
            consent_until=now + timedelta(days=spec["consent_days"]),
            contact_refused=spec["refused"],
        )
        db.add(p)
        db.flush()
        for drug, dosage, freq, days in spec["meds"]:
            db.add(MedicationPlan(
                patient_id=p.id, drug_name=drug, dosage=dosage, frequency=freq,
                start_date=discharge_str,
                end_date=(discharge_dt + timedelta(days=days)).date().isoformat(),
            ))
        discharge_and_plan(db, p, discharge_dt)

    db.commit()

    # 预置一个进行中的高风险场景：张伟上报胸痛 → 已升级、普通随访冻结
    zhang = db.scalar(select(Patient).where(Patient.code == "P2026001"))
    submit_report(db, zhang, {
        "symptoms": ["胸痛", "呼吸困难"],
        "symptom_text": "出院后第二天，胸口压榨样痛，伴出汗",
        "temperature": 37.2, "systolic": 165, "diastolic": 98,
        "adherence": "partial", "contact_ok": True, "channel": "mini_app",
        "idempotency_key": "seed-zhang-chestpain",
    })
    return True
