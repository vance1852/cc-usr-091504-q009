# 课后活动个别支持服务

面向融合教育协调员、课后活动导师、学生监护人及学生本人，把学生的**诊断性原始材料**
转化为具体场次中**可执行**的座位、沟通、饮食或陪同措施，并按最小必要原则分发。

NestJS 11 + TypeScript + SQLite（better-sqlite3），JWT 鉴权，角色与资源级权限。

## 要解决的问题

- 完整健康材料发给所有导师会过度泄露；不发又可能让支持落空 →
  授权人员把原文转写为**操作化措施**，导师只收到当场必须执行的条目，看不到诊断原文。
- 措施有适用场次、复核日期、可见范围。
- 活动内容改变时，自动找出需要重新评估的学生，复核完成前暂停旧措施分发。
- 措施过期、监护人调整同意范围、转化授权被撤回后，旧摘要立即停止分发；
  但**已执行记录不可变**，保留当时所依据的措施版本与同意版本。
- 协调员可确认导师提出的替代措施；家长查看本人孩子的当前版本；
  学生可表达不愿公开的偏好。
- 一次活动准备结果列出：已满足措施（含引用版本）、被拦截措施及原因、
  待确认冲突与重评、导师阅读回执、已确认替代措施。

## 角色

| 角色 | 主要能力 |
|---|---|
| `COORDINATOR` | 上传原始材料、持有/授予转化授权、把材料转为措施、登记内容变更、解决重评/冲突、确认替代措施、查看活动准备结果 |
| `INSTRUCTOR` | 只读**本场**简报并签收、登记执行、提出替代措施与上报当场不可行 |
| `GUARDIAN` | 调整本人孩子的同意范围（版本化）、查看孩子当前措施与执行记录 |
| `STUDENT` | 表达偏好（可标记为私密）、查看本人信息 |

## 分发闸门（服务端实时计算，不落快照分发）

一条措施当前版本进入某场导师简报，必须**同时**满足：

1. 学生已报名该场，且措施的适用场次覆盖该场（`ALL` 或显式包含）；
2. 措施未停用（retired）；
3. 复核日期未到（`review_date >= 今天`）；
4. 监护人**最新版**同意范围包含该措施类型（`CONSENT_MISSING` / `CONSENT_WITHDRAWN`）；
5. 该措施创建人对该学生该类型仍持有**未撤回**的转化授权（`GRANT_REVOKED`）；
6. 该生在该场没有未解决的重评标记（`REASSESSMENT_OPEN`）；
7. 没有针对该措施或该生（学生级）的未解决冲突（`CONFLICT_OPEN`）；
8. 可见范围覆盖该导师：`ALL_INSTRUCTORS`，或 `INSTRUCTORS` 名单包含该导师（`NOT_VISIBLE`）。

导师简报不返回被拦截原因、材料引用与诊断原文；这些只出现在协调员的
活动准备结果里。

## 数据模型（SQLite，见 `src/db/schema.ts`）

- `users` / `students` / `user_student_links`
- `raw_materials`：诊断性原文，导师任何接口不可读
- `grants`：把材料转化为措施的授权，可撤回
- `consent_versions`：监护人同意，**仅追加版本**，分发永远读最新版
- `measures` + `measure_versions`：措施与不可变版本（操作化语言、复核日期、
  适用场次、可见名单、引用材料）
- `measure_version_sessions` / `measure_version_visibility` / `measure_version_sources`
- `student_preferences`：`PRIVATE` 绝不进导师简报
- `sessions` / `enrollments`
- `reassessment_flags`：内容变更后自动生成
- `conflicts`：`OVERLAP`（多活动时间重叠，学生级）/ `INFEASIBLE`
- `alternatives`：导师提议、协调员确认
- `read_receipts`：签收绑定简报快照哈希与条目数
- `execution_log`：**不可变**执行记录，含 `instruction_snapshot` 与
  `consent_version_id`，事后撤回/过期不影响记录

## 运行

```bash
npm install
npm run seed          # 写入演示数据到 data.sqlite（账号口令均为 pw123456）
npm run start         # http://localhost:3000
# 或开发模式
npm run dev
npm test              # 8 个端到端场景测试
npm run build
```

环境变量：`PORT`（默认 3000）、`SUPPORT_DB_FILE`（默认 `data.sqlite`）、
`JWT_SECRET`（默认 `dev-secret`，生产必须覆盖）。

演示账号：`coord`（协调员）、`sci`（科学课导师）、`bake`（烘焙导师）、
`guard`（家长）、`pupil`（学生），口令均为 `pw123456`。

## 主要 API（均需 `Authorization: Bearer <token>`，登录除外）

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | `/auth/login` | - | 获取 JWT |
| POST | `/students` `/sessions` | C | 建档、建场 |
| POST | `/sessions/:id/enrollments` | C | 报名（同时检测时间重叠） |
| POST | `/materials` | C | 上传原始材料（原文） |
| GET | `/materials/:mid` | C/G | 原文：C 须持有效授权，G 限本人孩子；导师 403 |
| POST/DELETE | `/grants` `/grants/:gid` | C | 授予/撤回转化授权 |
| POST | `/consent` | C/G | 写入新一版同意范围（空类型=全部撤回） |
| POST | `/measures` | C | 材料→措施（须持该类型授权；可带场次/可见名单/引用材料） |
| POST | `/measures/:id/versions` | C | 新版本（立即切换分发） |
| POST | `/measures/:id/retire` | C | 停用 |
| POST | `/measures/:id/alternatives` | I/C | 提出替代措施 |
| POST | `/alternatives/:id/review` | C | 确认/拒绝替代措施 |
| POST | `/sessions/:id/content-change` | C | 内容版本+1、自动建重评标记、检测重叠 |
| POST | `/sessions/:id/conflicts/infeasible` | I/C | 上报当场不可行 |
| POST | `/sessions/conflicts/:cid/resolve` | C | 解决冲突 |
| POST | `/sessions/reassessment-flags/:fid/resolve` | C | 完成重评 |
| GET | `/sessions/:id/briefing` | I | **本场导师简报**：仅待执行措施+公开偏好 |
| GET | `/sessions/:id/preparation` | C | **活动准备结果**：满足/拦截/重评/冲突/回执/替代 |
| POST | `/sessions/:id/acknowledge` | I | 阅读回执（绑定快照） |
| POST | `/sessions/:id/executions` | I | 登记执行（写不可变快照，仅当场可执行时允许） |
| GET | `/sessions/:id/executions` | C/I | 执行记录（I 限本人场次） |
| POST/GET | `/preferences` | S/C | 学生偏好（`PRIVATE`/`SHARE_INSTRUCTOR`） |
| GET | `/guardian/children/:studentId/current-measures` | G | 本人孩子当前版本与分发状态 |
| GET | `/guardian/children/:studentId/executions` | G | 本人孩子的历史执行记录 |

## 测试场景（`test/support.e2e-spec.ts`）

1. 材料转化 → 同意 → 科学课低刺激座位与烘焙过敏原回避分别只进对应导师简报，无诊断原文
2. 活动内容改变 → 自动重评标记 → 暂停分发 → 解决后恢复
3. 同意收缩与复核到期阻断分发，已执行记录保留当时版本与同意依据
4. 转化授权撤回立即阻断旧摘要，并禁止再创建该类型措施
5. 多活动时间重叠 → 双方场次待确认冲突并拦截 → 协调员确认后恢复
6. 导师提出替代措施 → 协调员确认 → 出现在准备结果
7. 家长查看本人孩子当前版本（他人 403）；学生私密偏好不进导师简报
8. 阅读回执绑定快照，措施变化后旧回执标记为过期
