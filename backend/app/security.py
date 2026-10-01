"""极简签名 Token（演示环境足够；不引入额外依赖）。

token = base64(payload).hmac_sha256(payload)
payload: {"sub": "staff:12" 或 "patient:7", "name": "...", "ts": 签发时间}
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from .config import settings
from .database import get_db
from .models import Patient, Staff


def _sign(payload_b64: str) -> str:
    return hmac.new(
        settings.SECRET_KEY.encode(), payload_b64.encode(), hashlib.sha256
    ).hexdigest()


def issue_token(subject: str, name: str) -> str:
    payload = {"sub": subject, "name": name, "ts": int(time.time())}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    b64 = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    return f"{b64}.{_sign(b64)}"


def _parse(token: str) -> dict:
    try:
        b64, sig = token.split(".", 1)
    except ValueError:
        raise HTTPException(status_code=401, detail="无效的登录凭证")
    if not hmac.compare_digest(sig, _sign(b64)):
        raise HTTPException(status_code=401, detail="登录凭证已被篡改")
    pad = "=" * (-len(b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(b64 + pad))
    if int(time.time()) - payload["ts"] > settings.TOKEN_TTL_HOURS * 3600:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    return payload


class CurrentUser:
    def __init__(self, kind: str, id: int, name: str, role: str = ""):
        self.kind = kind  # staff / patient
        self.id = id
        self.name = name
        self.role = role

    @property
    def is_patient(self) -> bool:
        return self.kind == "patient"


def current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> CurrentUser:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    payload = _parse(authorization[7:])
    kind, raw_id = payload["sub"].split(":", 1)
    uid = int(raw_id)
    if kind == "staff":
        staff = db.get(Staff, uid)
        if not staff or not staff.active:
            raise HTTPException(status_code=401, detail="账号不存在或已停用")
        return CurrentUser("staff", staff.id, staff.name, staff.role)
    patient = db.get(Patient, uid)
    if not patient:
        raise HTTPException(status_code=401, detail="账号不存在")
    return CurrentUser("patient", patient.id, patient.name, "patient")


def require_roles(*roles: str):
    def dep(user: CurrentUser = Depends(current_user)) -> CurrentUser:
        if user.kind != "staff" or user.role not in roles:
            raise HTTPException(status_code=403, detail="当前角色无权执行该操作")
        return user

    return dep
