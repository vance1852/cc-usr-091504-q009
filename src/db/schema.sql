-- 个别支持措施服务数据库结构 (SQLite)
-- 设计要点:
-- 1) source_materials.raw_text 为诊断性原文,仅授权协调员可访问;
--    导师接口在任何查询中都不会选取该列。
-- 2) measures/measure_versions 只保存"可执行、非诊断"的措施文本,
--    版本通过 based_on_hash 形成哈希链,已分发简报固化当时快照。
-- 3) 授权(authorizations)撤回、同意(consent_grants)调整、复核过期、
--    活动内容变更都会让旧版本失去分发资格,但已生成的简报与执行记录保留。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  email                 TEXT UNIQUE NOT NULL,
  password_hash         TEXT NOT NULL,
  name                  TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('coordinator','mentor','guardian','student')),
  linked_student_id     TEXT,
  active                INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS students (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  user_id     TEXT UNIQUE REFERENCES users(id),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_materials (
  id          TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('medical','educational','guardian_note','student_preference')),
  title       TEXT NOT NULL,
  raw_text    TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- 学生本人表达、不愿公开的偏好;默认 restricted,导师端永不直接读取
CREATE TABLE IF NOT EXISTS student_preferences (
  id          TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'restricted' CHECK (visibility IN ('restricted','coordinator')),
  created_at  TEXT NOT NULL
);

-- 协调员对"原始材料 -> 措施"转化工作的授权,可撤回
CREATE TABLE IF NOT EXISTS authorizations (
  id              TEXT PRIMARY KEY,
  coordinator_id  TEXT NOT NULL REFERENCES users(id),
  scope           TEXT NOT NULL,
  granted_at      TEXT NOT NULL,
  revoked_at      TEXT
);

-- 监护人给出的同意范围,可调整(撤回旧的、授予新的)
CREATE TABLE IF NOT EXISTS consent_grants (
  id          TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,
  details     TEXT,
  granted_by  TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  revoked_at  TEXT,
  revoke_note TEXT
);

CREATE TABLE IF NOT EXISTS activities (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  program_code    TEXT,
  content_summary TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  allergens       TEXT NOT NULL DEFAULT '[]',
  starts_at       TEXT NOT NULL,
  ends_at         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_mentors (
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  mentor_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (activity_id, mentor_id)
);

CREATE TABLE IF NOT EXISTS activity_students (
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY (activity_id, student_id)
);

CREATE TABLE IF NOT EXISTS measures (
  id                 TEXT PRIMARY KEY,
  student_id         TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  source_material_id TEXT NOT NULL REFERENCES source_materials(id),
  type               TEXT NOT NULL CHECK (type IN ('seating','communication','dietary','accompaniment')),
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS measure_scopes (
  id           TEXT PRIMARY KEY,
  measure_id   TEXT NOT NULL REFERENCES measures(id) ON DELETE CASCADE,
  scope_type   TEXT NOT NULL CHECK (scope_type IN ('activity','program','global')),
  activity_id  TEXT REFERENCES activities(id),
  program_code TEXT
);

-- 措施版本:每次修订新增一行,旧版本置为 superseded,永不删除
CREATE TABLE IF NOT EXISTS measure_versions (
  measure_id            TEXT NOT NULL REFERENCES measures(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN
                          ('draft','active','confirmed_alternative','expired','revoked','superseded')),
  instruction           TEXT NOT NULL,
  constraints_json      TEXT NOT NULL DEFAULT '{}',
  review_date           TEXT NOT NULL,
  expires_at            TEXT,
  consent_scope         TEXT NOT NULL,
  consent_grant_id      TEXT REFERENCES consent_grants(id),
  authorization_id      TEXT NOT NULL REFERENCES authorizations(id),
  based_on_hash         TEXT NOT NULL,
  activity_content_hash TEXT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  decided_by            TEXT,
  decided_at            TEXT,
  revoke_reason         TEXT,
  PRIMARY KEY (measure_id, version)
);

-- 重新评估工作清单:活动内容变更、授权撤回、同意调整、复核过期时自动生成
CREATE TABLE IF NOT EXISTS reassessments (
  id          TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id),
  activity_id TEXT REFERENCES activities(id),
  measure_id  TEXT NOT NULL REFERENCES measures(id),
  version     INTEGER NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN
                ('content_changed','authorization_revoked','consent_withdrawn','review_due','expired')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS conflicts (
  id            TEXT PRIMARY KEY,
  activity_id   TEXT NOT NULL REFERENCES activities(id),
  activity_id_b TEXT REFERENCES activities(id),
  student_id_a  TEXT NOT NULL REFERENCES students(id),
  measure_id_a  TEXT NOT NULL REFERENCES measures(id),
  version_a     INTEGER NOT NULL,
  student_id_b  TEXT REFERENCES students(id),
  measure_id_b  TEXT REFERENCES measures(id),
  version_b     INTEGER,
  kind          TEXT NOT NULL,
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  created_at    TEXT NOT NULL,
  resolved_by   TEXT,
  resolved_at   TEXT,
  resolution_note TEXT
);

-- 活动准备批次(一次准备的不可变结果快照)
CREATE TABLE IF NOT EXISTS preps (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  snapshot    TEXT NOT NULL
);

-- 导师简报:只包含当场必须执行的非诊断措施文本
CREATE TABLE IF NOT EXISTS mentor_briefings (
  id                   TEXT PRIMARY KEY,
  prep_id              TEXT REFERENCES preps(id),
  activity_id          TEXT NOT NULL REFERENCES activities(id),
  mentor_id            TEXT NOT NULL REFERENCES users(id),
  student_id           TEXT NOT NULL REFERENCES students(id),
  measure_id           TEXT NOT NULL REFERENCES measures(id),
  version              INTEGER NOT NULL,
  instruction_snapshot TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  read_at              TEXT,
  blocked_at           TEXT,
  block_reason         TEXT,
  UNIQUE (activity_id, mentor_id, measure_id, version)
);

CREATE TABLE IF NOT EXISTS executions (
  id                   TEXT PRIMARY KEY,
  briefing_id          TEXT NOT NULL REFERENCES mentor_briefings(id),
  mentor_id            TEXT NOT NULL REFERENCES users(id),
  measure_id           TEXT NOT NULL,
  version              INTEGER NOT NULL,
  instruction_snapshot TEXT NOT NULL,
  note                 TEXT,
  executed_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mv_status ON measure_versions(status);
CREATE INDEX IF NOT EXISTS idx_briefings_mentor ON mentor_briefings(mentor_id, blocked_at);
CREATE INDEX IF NOT EXISTS idx_reassess_status ON reassessments(status);
