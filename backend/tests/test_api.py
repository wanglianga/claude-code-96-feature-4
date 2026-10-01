"""HTTP 层端到端：鉴权、角色边界、字段脱敏、患者越权访问。"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import Escalation, Patient, Staff
from app.seed import seed
from sqlalchemy import select

client = TestClient(app)


@pytest.fixture(autouse=True)
def seeded(fresh_db):
    # fresh_db 预置了单元测试用员工；API 测试改用演示种子数据
    fresh_db.query(Staff).delete()
    seed(fresh_db)
    return fresh_db


def login_staff(username: str, password: str) -> str:
    r = client.post("/api/auth/staff/login",
                    json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def login_patient(code: str, tail: str) -> str:
    r = client.post("/api/auth/patient/login",
                    json={"code": code, "id_card_tail": tail})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def auth(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


def test_login_failures():
    assert client.post("/api/auth/staff/login",
                       json={"username": "nurse.wang", "password": "wrong"}
                       ).status_code == 401
    assert client.post("/api/auth/patient/login",
                       json={"code": "P2026001", "id_card_tail": "0000"}
                       ).status_code == 401


def test_patient_submit_high_risk_and_idempotent(seeded):
    tok = login_patient("P2026002", "5678")
    payload = {"symptoms": ["胸痛", "呼吸困难"], "symptom_text": "胸口压榨痛",
               "temperature": 37.0, "idempotency_key": "http-1", "channel": "portal"}
    r1 = client.post("/api/patient/reports", json=payload, headers=auth(tok))
    assert r1.status_code == 200
    body = r1.json()
    assert body["high_risk"] is True and body["escalation_id"]
    # 同样幂等键重放
    r2 = client.post("/api/patient/reports", json=payload, headers=auth(tok))
    assert r2.json()["created"] is False
    # 未登录 401
    assert client.post("/api/patient/reports", json=payload).status_code == 401


def test_role_boundaries_enforced(seeded):
    pharma = login_staff("pharma.zhou", "pharma123")
    # 药师不能调护士初筛
    esc_id = seeded.scalar(select(Escalation)).id
    r = client.post(f"/api/nurse/escalations/{esc_id}/screen",
                    json={"action": "ed_advice", "note": "x"}, headers=auth(pharma))
    assert r.status_code == 403
    # 药师不能下医嘱
    r = client.post("/api/doctor/orders",
                    json={"patient_id": 1, "order_type": "exam", "content": "CT"},
                    headers=auth(pharma))
    assert r.status_code == 403
    # 护士不能下医嘱
    nurse = login_staff("nurse.wang", "nurse123")
    r = client.post("/api/doctor/orders",
                    json={"patient_id": 1, "order_type": "exam", "content": "CT"},
                    headers=auth(nurse))
    assert r.status_code == 403


def test_field_masking_differs_by_role(seeded):
    db = seeded
    p_zhang = db.scalar(select(Patient).where(Patient.code == "P2026001"))
    reports = client.get("/api/staff/reports", headers=auth(
        login_staff("pharma.zhou", "pharma123"))).json()
    zhang_reports = [r for r in reports if r["patient"]["id"] == p_zhang.id]
    assert zhang_reports, "应能看到高风险患者的上报条目（脱敏后）"
    item = zhang_reports[0]
    assert item["symptoms"] == []
    assert item["symptom_text"] == "（无权限查看）"
    assert item["temperature"] is None
    assert item["images"] == []
    # 患者姓名对药师掩码
    assert item["patient"]["name"].startswith("张") and "*" in item["patient"]["name"]

    # 护士看同一条目字段完整
    nurse_reports = client.get("/api/staff/reports", headers=auth(
        login_staff("nurse.wang", "nurse123"))).json()
    nurse_item = [r for r in nurse_reports if r["id"] == item["id"]][0]
    assert "胸痛" in nurse_item["symptoms"]
    assert nurse_item["patient"]["name"] == "张伟"


def test_pharmacist_cannot_read_image(seeded):
    tok = login_staff("pharma.zhou", "pharma123")
    r = client.get("/api/staff/images/1", headers=auth(tok))
    assert r.status_code == 403


def test_patient_cannot_read_others(seeded):
    tok = login_patient("P2026002", "5678")
    # 不能看别人的时间线
    r = client.get("/api/staff/patients/1/timeline", headers=auth(tok))
    assert r.status_code == 403
    # 自己的可以
    me = client.get("/api/patient/overview", headers=auth(tok)).json()
    assert me["patient"]["code"] == "P2026002"


def test_full_referral_flow_over_http(seeded):
    # 李娜高风险上报 → 护士转诊 → 医生确认 → 关闭
    ptok = login_patient("P2026002", "5678")
    r = client.post("/api/patient/reports", json={
        "symptoms": ["呕血"], "idempotency_key": "flow1", "channel": "sms"},
        headers=auth(ptok))
    esc_id = r.json()["escalation_id"]

    nurse = login_staff("nurse.wang", "nurse123")
    r = client.post(f"/api/nurse/escalations/{esc_id}/screen",
                    json={"action": "referral_request", "target": "消化内科",
                          "note": "疑似消化道出血"},
                    headers=auth(nurse))
    assert r.status_code == 200 and r.json()["referral_created"] is True
    # 重复申请被幂等拦截
    r = client.post(f"/api/nurse/escalations/{esc_id}/screen",
                    json={"action": "referral_request", "target": "消化内科"},
                    headers=auth(nurse))
    assert r.json()["referral_created"] is False

    # 待确认时不能关闭
    r = client.post(f"/api/nurse/escalations/{esc_id}/close",
                    json={"basis": "关闭试试"}, headers=auth(nurse))
    assert r.status_code == 400

    doctor = login_staff("doctor.sun", "doctor123")
    refs = client.get(f"/api/staff/escalations/{esc_id}",
                      headers=auth(doctor)).json()["referrals"]
    ref_id = refs[0]["id"]
    r = client.post(f"/api/doctor/referrals/{ref_id}/decision",
                    json={"decision": "confirm", "note": "消化内科已收住"},
                    headers=auth(doctor))
    assert r.status_code == 200

    r = client.post(f"/api/nurse/escalations/{esc_id}/close",
                    json={"basis": "患者已收住消化内科，完成闭环"}, headers=auth(nurse))
    assert r.status_code == 200

    timeline = client.get(f"/api/staff/patients/2/timeline",
                          headers=auth(nurse)).json()["events"]
    types_ = [e["event_type"] for e in timeline]
    assert "referral.requested" in types_
    assert "referral.confirmed" in types_
    assert "escalation.closed" in types_
    # 药师时间线中看不到转诊与护士细节
    ph = login_staff("pharma.zhou", "pharma123")
    ph_timeline = [e for e in client.get("/api/staff/patients/2/timeline",
                                         headers=auth(ph)).json()["events"]]
    assert all(e["event_type"] not in ("referral.requested", "nurse.referral_request")
               for e in ph_timeline)
