# 课后活动个别支持服务

面向融合教育协调员、课后活动导师、学生监护人及学生本人的个别支持措施管理服务。
将**诊断性原始健康材料**转化为**具体活动中可执行的非诊断措施**，按最小可见范围分发，
并在活动内容、授权、同意或复核状态变化时自动阻断旧摘要、触发重新评估。

## 核心原则

| 原则 | 实现方式 |
| --- | --- |
| 最小可见 | `source_materials.raw_text` 诊断原文仅协调员接口可取；导师简报只固化当场可执行文本，任何导师查询都不选取原始材料列 |
| 适用场次 | 措施范围支持 `activity` / `program` / `global`，另设复核日期、过期时间、可见(同意)范围 |
| 版本可溯 | 每次修订/确认替代生成新版本，哈希纳入前版哈希与依据形成哈希链；旧版置 `superseded`/`revoked` 不删除 |
| 失效即停分发 | 授权撤回、同意调整、复核过期、活动内容变更 → 旧简报 `blocked_at` 落戳，导师无法再据旧版执行 |
| 已执行留痕 | `executions` 独立保存当时版本与指令快照，不受后续阻断影响 |
| 自动重评 | 内容变更/撤回/过期自动为受影响学生×活动生成 `reassessments` 待办 |
| 学生意愿 | 学生偏好默认 `restricted`，仅协调员可见，绝不进入导师输出 |

## 技术栈

- NestJS 11（模块化、守卫、管道、过滤器）
- SQLite（Node 22 内置 `node:sqlite`，无需原生编译；`--experimental-sqlite`）
- JWT 鉴权 + 基于角色的访问控制（coordinator / mentor / guardian / student）
- class-validator 请求校验；bcrypt 口令哈希

## 运行

```bash
npm install
npm run dev                 # 编译并启动 http://localhost:3000
# 或
npm run build && npm start

# 验证场景(内存库,无需起服务)
npm run test:scenario
```

环境变量：`PORT`（默认 3000）、`DB_PATH`（默认 `./data.sqlite`）、`JWT_SECRET`。

## 角色与主要接口

### 认证
- `POST /auth/register` `POST /auth/login`（公开）

### 协调员 `/coordination`（role=coordinator）
- 学生：`POST /students`、`PUT /students/:id/guardian`、`PUT /students/:id/student-user`
- 原始材料（诊断原文）：`POST|GET /students/:id/source-materials`
- 授权：`POST /authorizations`、`POST /authorizations/:id/revoke`
- 活动：`POST /activities`、`PUT /activities/:id/content`（内容变更触发自动重评）、`GET /overlaps`
- 措施：`POST /students/:id/measures`、`POST /measures/:id/revise`、
  `POST /measures/:id/confirm-alternative`、`GET /measures/:id/versions`
- 重评/冲突：`GET /reassessments`、`POST /reassessments/:id/resolve`、
  `GET /conflicts`、`POST /conflicts/:id/resolve`
- 活动准备：`POST /activities/:id/prepare`

`prepare` 的返回即"一次活动准备结果"：

```jsonc
{
  "prepId": "...",              // 不可变快照
  "satisfied": [ /* 已满足可分发措施(非诊断文本) */ ],
  "blocked":   [ /* {measureId, blockReasons:[content_changed|consent_withdrawn|...]} */ ],
  "pendingConflicts": [ /* 待确认冲突,如过敏原暴露、感官安排被高刺激内容覆盖 */ ],
  "receipts":  [ /* 每位导师每条简报的 read_at 阅读回执 */ ],
  "citedVersions": [ /* {measureId, version, basedOnHash, reviewDate, expiresAt} */ ]
}
```

冲突检测包括：活动过敏原 ∩ 饮食回避、高刺激内容 ∩ 低刺激座位要求、
同一学生被排入时间重叠活动（多活动重叠，含陪同措施同时执行冲突）。

### 导师 `/mentor`（role=mentor）
- `GET /mentor/briefings?activityId=` 仅本人、当场、可执行或标记失效的简报
- `POST /mentor/briefings/:id/read` 阅读回执
- `POST /mentor/briefings/:id/execute` 执行登记（已阻断简报返回 403；记录固化当时依据）
- `GET /mentor/executions` 历史执行记录

### 监护人 `/guardian`（role=guardian，须关联孩子）
- `GET /guardian/child/current` 本人孩子各措施**当前版本**及各活动可分发状态
- `POST /guardian/consents`、`POST /guardian/consents/:id/revoke`
  撤回同意立即阻断相关旧简报并触发重评

### 学生 `/student`（role=student）
- `POST|GET /student/preferences` 表达偏好，默认 `restricted`（不愿公开），仅协调员可见

## 数据模型要点

`src/db/schema.sql`：`authorizations`（可撤回）、`consent_grants`（可调整）、
`measure_versions`（版本状态机 + `based_on_hash`）、`reassessments`、`conflicts`、
`preps`（准备快照）、`mentor_briefings`（分发与阻断/回执）、`executions`（留痕）。

## 验证

- `npm run test:scenario`：47 项领域断言，覆盖最小分发、诊断隔离、内容变更重评、
  授权/同意撤回、过期阻断、执行留痕、多活动重叠、家长视图、学生受限偏好、HTTP 401/403。
- 另可启动服务后运行 `src/test/http-smoke.ts`（真实 HTTP + 权限栈）。
