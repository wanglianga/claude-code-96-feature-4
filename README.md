# 出院后分级随访与高风险升级处置平台

患者出院后，系统依据**患者身份、手术类型、出院医嘱、过敏史、用药计划和既往随访记录**自动生成分级随访任务；
患者可通过网页门户 / 小程序 / 短信三类入口提交症状、体温、血压、用药依从性与图片；
护士、医生、药师看到的字段**按角色授权与脱敏**呈现。患者上报一旦命中高风险规则，
系统先**冻结普通自动随访**并创建升级任务，由护士初筛（电话回访 / 急诊建议 / 转诊申请），
医生补充或撤回医嘱，药师仅处理用药相互作用与用药建议。所有处置以**事件时间线**为准，全程可追溯。

---

## 一、一键启动（Docker Compose，推荐）

依赖：Docker 20+ / Docker Compose v2。启动三个服务：`mariadb:11`（数据库）、后端（FastAPI，:8000 仅容器内网）、Web（Nginx 托管前端并反代 API）。

```bash
cp .env.example .env          # 可修改发布端口/数据库账号/密钥
docker compose up -d --build
# 打开
#   前端：       http://localhost:3001
#   Swagger UI： http://localhost:3001/docs
#   OpenAPI：    http://localhost:3001/openapi.json
docker compose logs -f backend   # 观察“等待数据库→建表→种子数据”
```

健康检查：`curl http://localhost:3001/healthz` → `ok`。
停止：`docker compose down`；连数据卷一起清除：`docker compose down -v`。

> 首次启动后端会自动建表并写入演示种子数据（5 名患者、6 名员工、1 个进行中的高风险场景）。
> 数据库字符集为 utf8mb4。

---

## 二、测试账号

### 医护（工号 / 密码）

| 工号 | 密码 | 角色 | 说明 |
|---|---|---|---|
| `nurse.wang` | `nurse123` | 护士 | 初筛三动作、任务执行、关闭升级单 |
| `nurse.chen` | `nurse123` | 护士 | **通知通道故障**（用于演示异步通知重试→死信→转人工） |
| `doctor.li` | `doctor123` | 医生 | 心外科，补录/撤回医嘱、确认转诊 |
| `doctor.sun` | `doctor123` | 医生 | 普外科 |
| `pharma.zhou` | `pharma123` | 药师 | 仅用药审方，字段脱敏 |
| `admin` | `admin123` | 管理员 | 人工队列、手动触发后台巡检、查看通知投递 |

### 患者受限入口（病案号 + 身份证后 4 位）

| 病案号 | 后4位 | 患者 | 预置场景 |
|---|---|---|---|
| `P2026001` | `1234` | 张伟 | 心脏搭桥，**已因胸痛升级、普通随访冻结中**；华法林用药 |
| `P2026002` | `5678` | 李娜 | 腹腔镜胆囊切除 |
| `P2026003` | `9012` | 王芳 | 剖宫产 |
| `P2026004` | `3456` | 刘强 | **随访授权已过期**（上报即转人工队列） |
| `P2026005` | `7890` | 赵敏 | **已标注拒绝电话联系**（上报即转人工队列） |

---

## 三、本地开发（不用 Docker）

需要 Python 3.11+、Node 18+；数据库可使用任意 MariaDB 10.6+/MySQL 8（或开发用 SQLite）。

### 后端

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt

# 方式 A：连接本机/远端 MariaDB（默认读 127.0.0.1:3306，账号 ccdev/ccdev，库 ccdev）
uvicorn app.main:app --reload --port 8000

# 方式 B：无本地数据库时用 SQLite（仅开发/测试，功能一致）
APP_DATABASE_URL="sqlite:///$PWD/dev.db" APP_UPLOAD_DIR=/tmp/fu-uploads \
  uvicorn app.main:app --reload --port 8000
```

接口文档：http://127.0.0.1:8000/docs （FastAPI 自动生成的 OpenAPI 3.x + Swagger UI）。

### 前端

```bash
npm install
npm run dev          # http://127.0.0.1:5173 ，/api 自动代理到 127.0.0.1:8000
npm run build        # 类型检查 + 产物到 dist/
```

### 运行测试

```bash
cd backend
pip install -r requirements-dev.txt
pytest -q            # 使用独立临时 SQLite，不触碰本机 MariaDB
```

---

## 四、核心业务规则与对照验证

### 1. 出院分级随访
按手术类型/出院医嘱匹配 L1（常规，72h/7d）、L2（中风险，48h/72h/7d 等）、
L3（高危手术，24h/48h/72h/7d/14d）。规则在 `backend/app/rules.py`。

### 2. 高风险判定 → 冻结 + 升级
症状关键词（胸痛/呼吸困难、活动性出血、严重感染/裂开、意识异常、严重过敏）+
体征阈值（体温 ≥39℃、收缩压 ≥180/≤90、舒张压 ≥110/≤50）。命中后在**同一事务内**：
写入上报 → 冻结该患者全部未完成的普通自动随访任务 → 建升级单（SLA 默认 120 分钟）→ 通知护士。

### 3. 题目四个难点的处理

| 难点 | 实现方式 |
|---|---|
| 新医嘱与既有随访计划冲突 | 医生下“随访计划调整”医嘱时，未完成旧任务统一置 `cancelled` 并写 `superseded_by_order_id` 与 `task.cancelled/task.supersedes` 事件，再生成替代任务 |
| 患者在不同入口重复上报 | 内容签名 + 10 分钟时间窗跨 `portal/mini_app/sms` 去重，重复单记为 `merged` 指向原单，不再分诊/升级；前端另用幂等键防双击 |
| 医生补录时间早于护士记录 | 每条记录区分 `event_time`（业务时间，可补录）与 `recorded_at`（落库时间）；时间线按 `event_time` 排序并标“补录”，原记录不移动不改写 |
| 转诊未确认又报恶化 | 每患者唯一活跃升级（`active_guard` 唯一约束）；新上报挂接同一升级单记 `escalation.worsening` 并紧急提醒，不重复升级/转诊；转诊未确认禁止关闭升级单 |

### 4. 不可覆盖的审计语义
- `events` 表只追加（append-only），系统无更新/删除事件的接口；
- 医嘱撤回只追加 `order.withdrawn`，`orders.content` 原文永久保留（界面划线展示）；
- 任务取消/恢复/完成/冻结均带来源与依据；关闭升级单必须填关闭依据。

### 5. 并发与幂等兜底
- 上报：`(patient_id, idempotency_key)` 唯一约束；
- 升级：`escalations.active_guard = patient:{id}`（关闭后置 NULL，NULL 不参与唯一）；
- 转诊：`referrals.active_guard = esc:{id}`（终态释放，允许之后重新申请）；
- 冲突路径用 **SAVEPOINT** 局部回滚，不回滚整笔业务；MariaDB 连接使用 READ COMMITTED；
- 测试 `test_parallel_high_risk_reports_single_escalation` 用两个真实线程并发上报验证。

### 6. 人工队列与持续提醒
患者**拒绝联系**、**随访授权过期**、**图片无法读取**（空文件/魔数损坏/JPEG、PNG 截断均在上传时检出）
自动入人工队列；高风险事件超 SLA 未闭环，后台线程按间隔**持续提醒**（默认 2 次后转人工）；
异步通知走 outbox，失败指数退避重试，耗尽（死信）也转人工，**通知失败绝不回滚业务**。
管理员可在“通知与巡检”页手动触发一次巡检。

### 7. 角色字段脱敏（集中实现于 `backend/app/serializers.py`）
- 药师：患者姓名掩码（张*）、手机 `138****1234`、隐藏症状/体征/描述/图片、非用药医嘱内容；
  过敏史与用药依从性可见（用药安全必需）；不能读图片、不能做护士/医生动作；
- 护士/医生：字段完整，但身份证号一律不展示；
- 患者：仅能访问本人数据，时间线只返回与其相关的事件类型。

### 8. 可追溯页面
任意患者“档案与时间线”按业务时间展示：上报 → 分诊 → 医嘱（含撤回）→ 转诊 → 回访 →
冻结/恢复/取消/替代 → 关闭依据；药师视角同一时间线自动过滤掉无权查看的事件。

---

## 五、建议的手工验证路径

1. 用 `P2026002/5678` 登录患者端，上报「呕血」→ 提示高风险；再用同样内容从“小程序”入口提交一次 → 提示已合并。
2. 护士登录，高风险台处理该升级单：转诊申请 → 消化内科；再点一次申请 → 提示转诊单已存在。
3. 医生登录确认转诊；护士在关闭依据中填写“已收住”关闭；查看患者时间线全链路。
4. 医生对同一患者下“随访计划调整”医嘱 → 任务板可见旧任务“被医嘱 #N 替代”与新替代任务。
5. 药师登录：列表姓名脱敏，打开该患者看不到症状与图片，只能提交用药审方；直接访问图片 URL 返回 403。
6. `P2026004` 上报任意症状 → 人工队列出现“授权过期”；上传一个被截断的图片文件 → 出现“图片无法读取”。
7. 管理员页“立即执行巡检”：通知列表可见 `nurse.chen` 的失败→重试→死信→转人工全过程。

---

## 六、工程结构

```
backend/
  app/
    main.py            FastAPI 入口、生命周期、后台巡检线程
    config.py          环境配置（SLA/去重窗/重试参数）
    database.py  models.py  rules.py  security.py  serializers.py
    events.py          统一 append-only 事件记录
    seed.py            演示种子
    routers/           auth / patient / staff / nurse / doctor / pharmacist / queue
    services/          discharge / reports / escalation / pharmacy / queue / notifications / tasks
  tests/               39 个 pytest 用例（业务、脱敏、跨线程并发、幂等、HTTP 端到端）
  Dockerfile  entrypoint.sh  requirements.txt
src/                   React + TypeScript（患者端 / 护士 / 医生 / 药师 / 时间线）
docker-compose.yml     db(mariadb:11) + backend + web(nginx)
```

## 七、说明

- 本机沙箱未安装 Docker/MariaDB，交付前的自动化验证基于 SQLite（SQLAlchemy 方言中性）完成；
  生产/Compose 目标数据库为 MariaDB 11，唯一约束、READ COMMITTED 与事务行为均按 MariaDB 编写。
- 认证使用演示用 HMAC 签名 Token（非生产级 IAM）；图片保存在容器卷 `/data/uploads`。
