export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('COORDINATOR','INSTRUCTOR','GUARDIAN','STUDENT')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 监护人 / 学生账号与学生档案的关联
CREATE TABLE IF NOT EXISTS user_student_links (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, student_id)
);

-- 诊断性原始材料：内容仅授权人员 / 监护人可读，导师不可读
CREATE TABLE IF NOT EXISTS raw_materials (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- 把原始材料转化为措施的授权；revoked_at 非空即撤回
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  grantee_id TEXT NOT NULL REFERENCES users(id),
  -- 'ALL' 或措施类型 CSV
  scope TEXT NOT NULL,
  granted_by TEXT NOT NULL REFERENCES users(id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_grants_lookup ON grants(student_id, grantee_id, revoked_at);

-- 监护人同意：仅保留版本历史，分发永远读取最新版本
CREATE TABLE IF NOT EXISTS consent_versions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  version_no INTEGER NOT NULL,
  -- 允许的措施类型 CSV；空串表示全部撤回
  allowed_types TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_student ON consent_versions(student_id, version_no);

CREATE TABLE IF NOT EXISTS measures (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  current_version_id TEXT,
  retired_at TEXT
);

-- 措施版本：操作化语言，不含诊断原文
CREATE TABLE IF NOT EXISTS measure_versions (
  id TEXT PRIMARY KEY,
  measure_id TEXT NOT NULL REFERENCES measures(id),
  version_no INTEGER NOT NULL,
  student_id TEXT NOT NULL REFERENCES students(id),
  type TEXT NOT NULL CHECK (type IN ('SEATING','COMMUNICATION','DIET','ACCOMPANIMENT')),
  instruction TEXT NOT NULL,
  review_date TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('ALL','SESSIONS')),
  visibility_kind TEXT NOT NULL CHECK (visibility_kind IN ('ALL_INSTRUCTORS','INSTRUCTORS')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mv_measure ON measure_versions(measure_id, version_no);
CREATE INDEX IF NOT EXISTS idx_mv_student ON measure_versions(student_id);

-- 版本引用的原始材料（只存引用，摘要里永不回显内容）
CREATE TABLE IF NOT EXISTS measure_version_sources (
  version_id TEXT NOT NULL REFERENCES measure_versions(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES raw_materials(id),
  PRIMARY KEY (version_id, material_id)
);

-- target_kind = 'SESSIONS' 时的适用场次
CREATE TABLE IF NOT EXISTS measure_version_sessions (
  version_id TEXT NOT NULL REFERENCES measure_versions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  PRIMARY KEY (version_id, session_id)
);

-- visibility_kind = 'INSTRUCTORS' 时的可见导师名单
CREATE TABLE IF NOT EXISTS measure_version_visibility (
  version_id TEXT NOT NULL REFERENCES measure_versions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (version_id, user_id)
);

-- 学生本人表达的偏好
CREATE TABLE IF NOT EXISTS student_preferences (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  text TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('PRIVATE','SHARE_INSTRUCTOR')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  instructor_id TEXT NOT NULL REFERENCES users(id),
  content_revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_instructor ON sessions(instructor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_at);

CREATE TABLE IF NOT EXISTS enrollments (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_enroll_student ON enrollments(student_id);

-- 重评标记：活动内容变化后自动生成，协调员解决前相关措施暂停分发
CREATE TABLE IF NOT EXISTS reassessment_flags (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  reason TEXT NOT NULL,
  note TEXT,
  content_revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_flags_open ON reassessment_flags(session_id, student_id, status);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  -- NULL 表示针对该学生当场所有待执行措施
  measure_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('OVERLAP','INFEASIBLE')),
  description TEXT NOT NULL,
  -- OVERLAP 冲突的稳定去重键：studentId + 两个排序后的 sessionId
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_conflicts_open ON conflicts(session_id, student_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conflicts_overlap_dedupe
  ON conflicts(student_id, dedupe_key) WHERE kind = 'OVERLAP' AND status = 'OPEN';

CREATE TABLE IF NOT EXISTS alternatives (
  id TEXT PRIMARY KEY,
  measure_id TEXT NOT NULL REFERENCES measures(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  type TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','CONFIRMED','REJECTED')),
  proposed_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_alt_measure ON alternatives(measure_id, status);

CREATE TABLE IF NOT EXISTS read_receipts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  snapshot_hash TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  read_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_session ON read_receipts(session_id, user_id, read_at);

-- 不可变执行记录：保存当时依据的版本与同意快照
CREATE TABLE IF NOT EXISTS execution_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  measure_id TEXT NOT NULL,
  measure_version_id TEXT NOT NULL,
  type TEXT NOT NULL,
  instruction_snapshot TEXT NOT NULL,
  consent_version_id TEXT,
  executed_by TEXT NOT NULL REFERENCES users(id),
  executed_at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_student ON execution_log(student_id, executed_at);
CREATE INDEX IF NOT EXISTS idx_exec_session ON execution_log(session_id);
`;
