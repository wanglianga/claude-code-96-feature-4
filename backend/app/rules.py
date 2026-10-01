"""分级随访规则与高风险症状规则。

规则以数据形式声明，便于审计与扩展。命中高风险即冻结普通自动随访并升级。
"""
from __future__ import annotations

from datetime import datetime, timedelta

# 出院后自动随访分级：依据手术类型 + 出院医嘱关键词 + 过敏史
# 返回 (level, 计划相对出院日的小时偏移列表, 标题模板)
GRADE_RULES: list[dict] = [
    {
        "match": {"surgery_keywords": ["心脏搭桥", "支架", "开胸", "器官移植"]},
        "level": "L3",
        "hours": [24, 48, 72, 7 * 24, 14 * 24],
        "title": "高危手术随访（{surgery}）",
    },
    {
        "match": {"surgery_keywords": ["腹腔镜", "关节置换", "剖宫产", "甲状腺", "乳腺"]},
        "level": "L2",
        "hours": [48, 72, 7 * 24],
        "title": "中风险手术随访（{surgery}）",
    },
    {
        "match": {"order_keywords": ["抗凝", "胰岛素", "化疗"]},
        "level": "L2",
        "hours": [24, 72, 7 * 24],
        "title": "重点用药随访（{surgery}）",
    },
    {
        "match": {},
        "level": "L1",
        "hours": [72, 7 * 24],
        "title": "常规出院随访（{surgery}）",
    },
]

# 高风险规则：症状关键词 + 生命体征阈值
SYMPTOM_RULES: list[dict] = [
    {"code": "CHEST_PAIN", "keywords": ["胸痛", "胸闷", "呼吸困难", "喘憋"], "label": "胸痛/呼吸困难"},
    {"code": "BLEEDING", "keywords": ["出血", "渗血不止", "呕血", "黑便", "咯血"], "label": "活动性出血"},
    {"code": "WOUND_INFECT", "keywords": ["伤口流脓", "红肿热痛加重", "刀口裂开"], "label": "伤口严重感染/裂开"},
    {"code": "NEURO", "keywords": ["意识模糊", "抽搐", "偏瘫", "言语不清"], "label": "意识/神经异常"},
    {"code": "ALLERGY", "keywords": ["喉头紧", "全身风团", "面唇肿胀", "严重过敏"], "label": "严重过敏反应"},
    {"code": "FEVER_HIGH", "keywords": [], "label": "高热≥39℃"},
    {"code": "BP_EXTREME", "keywords": [], "label": "血压危急值"},
]

HIGH_TEMP = 39.0
SYS_HIGH, SYS_LOW = 180, 90
DIA_HIGH, DIA_LOW = 110, 50

# 用药相互作用简表（药师审方演示）
INTERACTIONS: dict[tuple[str, str], str] = {
    ("华法林", "阿司匹林"): "显著增加出血风险（INR 升高、胃肠出血）",
    ("华法林", "布洛芬"): "INR 升高，出血风险增加",
    ("氯吡格雷", "奥美拉唑"): "降低氯吡格雷抗血小板疗效",
    ("降压药", "布洛芬"): "削弱降压效果，水钠潴留",
    ("二甲双胍", "造影剂"): "乳酸酸中毒风险，建议造影前后暂停",
}


def grade_followup(surgery_type: str, discharge_orders: str) -> dict:
    text = f"{surgery_type} {discharge_orders}"
    for rule in GRADE_RULES[:-1]:
        m = rule["match"]
        if any(k in surgery_type for k in m.get("surgery_keywords", [])):
            return rule
        if any(k in text for k in m.get("order_keywords", [])):
            return rule
    return GRADE_RULES[-1]


def build_plan(patient, discharge_dt: datetime) -> list[dict]:
    """根据分级生成自动随访任务草案。"""
    rule = grade_followup(patient.surgery_type, patient.discharge_orders)
    plan = []
    for i, hours in enumerate(rule["hours"], 1):
        plan.append(
            {
                "level": rule["level"],
                "title": rule["title"].format(surgery=patient.surgery_type) + f" · 第{i}次",
                "due_at": discharge_dt + timedelta(hours=hours),
                "reason": f"按 {rule['level']} 分级规则：手术“{patient.surgery_type}”出院后 {hours}h",
            }
        )
    return plan


def evaluate_risk(
    symptoms: list[str],
    symptom_text: str,
    temperature: float | None,
    systolic: int | None,
    diastolic: int | None,
    allergy: str = "",
) -> list[dict]:
    """返回命中的高风险规则列表（空列表=普通）。"""
    text = " ".join(symptoms) + " " + symptom_text
    hits: list[dict] = []
    for rule in SYMPTOM_RULES:
        if rule["code"] == "FEVER_HIGH":
            if temperature is not None and temperature >= HIGH_TEMP:
                hits.append({"code": "FEVER_HIGH", "label": rule["label"], "value": temperature})
            continue
        if rule["code"] == "BP_EXTREME":
            if (
                systolic is not None
                and (systolic >= SYS_HIGH or systolic <= SYS_LOW)
                or diastolic is not None
                and (diastolic >= DIA_HIGH or diastolic <= DIA_LOW)
            ):
                hits.append(
                    {
                        "code": "BP_EXTREME",
                        "label": rule["label"],
                        "value": f"{systolic}/{diastolic}",
                    }
                )
            continue
        if any(k in text for k in rule["keywords"]):
            # 过敏类规则若患者有相关过敏史，提高置信标注
            hint = ""
            if rule["code"] == "ALLERGY" and allergy:
                hint = f"（患者过敏史：{allergy}）"
            hits.append({"code": rule["code"], "label": rule["label"], "value": hint})
    return hits


def check_interactions(drugs: list[str]) -> list[str]:
    findings = []
    upper = [d.strip() for d in drugs]
    for (a, b), detail in INTERACTIONS.items():
        if any(a in d for d in upper) and any(b in d for d in upper):
            findings.append(f"{a} × {b}：{detail}")
    return findings
