/* eslint-disable no-console */
import Database from 'better-sqlite3';
import { SCHEMA } from './db/schema';
import { hashPassword } from './auth/password';
import { id, now, today, toCsv } from './common/util';
import { ALL_MEASURE_TYPES, Role } from './common/enums';

/**
 * 演示种子：向空库写入一套可直接登录体验的数据。
 * 运行：npm run seed （默认 data.sqlite，可用 SUPPORT_DB_FILE 覆盖）
 */
function run() {
  const file = process.env.SUPPORT_DB_FILE || 'data.sqlite';
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const ts = now();

  const existing = db.prepare("SELECT COUNT(*) AS n FROM users").get() as {
    n: number;
  };
  if (existing.n > 0) {
    console.log('数据库已有用户，跳过种子。文件:', file);
    return;
  }

  const user = (login: string, name: string, role: Role) => {
    const userId = id('usr');
    db.prepare(
      `INSERT INTO users (id, login, password_hash, name, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, login, hashPassword('pw123456'), name, role, ts);
    return userId;
  };
  const link = (userId: string, studentId: string) =>
    db
      .prepare(
        'INSERT INTO user_student_links (user_id, student_id) VALUES (?, ?)',
      )
      .run(userId, studentId);

  const coord = user('coord', '王协调', Role.COORDINATOR);
  const sci = user('sci', '科学课李导师', Role.INSTRUCTOR);
  const bake = user('bake', '烘焙张导师', Role.INSTRUCTOR);
  const guardian = user('guard', '小明家长', Role.GUARDIAN);
  const pupil = user('pupil', '小明', Role.STUDENT);

  const studentId = id('stu');
  db.prepare('INSERT INTO students (id, name, created_at) VALUES (?, ?, ?)').run(
    studentId,
    '小明',
    ts,
  );
  link(guardian, studentId);
  link(pupil, studentId);

  db.prepare(
    `INSERT INTO grants (id, student_id, grantee_id, scope, granted_by, granted_at)
     VALUES (?, ?, ?, 'ALL', ?, ?)`,
  ).run(id('grn'), studentId, coord, coord, ts);

  db.prepare(
    `INSERT INTO consent_versions
       (id, student_id, version_no, allowed_types, note, created_by, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id('cns'),
    studentId,
    toCsv(ALL_MEASURE_TYPES),
    '初始同意范围',
    guardian,
    ts,
  );

  const mat = id('mat');
  db.prepare(
    `INSERT INTO raw_materials (id, student_id, kind, title, content, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mat,
    studentId,
    '医疗评估',
    '感官处理评估',
    '诊断性原文（仅授权人员/监护人可读）',
    coord,
    ts,
  );

  const future = (days: number) =>
    new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

  const sciSession = id('ses');
  const bakeSession = id('ses');
  const session = (
    sessionId: string,
    name: string,
    instructorId: string,
    day: number,
  ) =>
    db
      .prepare(
        `INSERT INTO sessions
           (id, name, description, location, start_at, duration_minutes,
            instructor_id, content_revision, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        sessionId,
        name,
        '',
        '',
        new Date(Date.now() + day * 86400_000).toISOString(),
        60,
        instructorId,
        coord,
        ts,
      );
  session(sciSession, '科学实验课', sci, 7);
  session(bakeSession, '烘焙活动', bake, 8);

  const enroll = (sessionId: string) =>
    db
      .prepare(
        'INSERT INTO enrollments (session_id, student_id, created_at) VALUES (?, ?, ?)',
      )
      .run(sessionId, studentId, ts);
  enroll(sciSession);
  enroll(bakeSession);

  const measure = (
    type: string,
    instruction: string,
    reviewDays: number,
    sessionId: string,
    visibleInstructors: string[] | null,
  ) => {
    const measureId = id('msr');
    const versionId = id('mv_');
    db.prepare(
      `INSERT INTO measures (id, student_id, current_version_id, retired_at)
       VALUES (?, ?, ?, NULL)`,
    ).run(measureId, studentId, versionId);
    db.prepare(
      `INSERT INTO measure_versions
         (id, measure_id, version_no, student_id, type, instruction,
          review_date, target_kind, visibility_kind, created_by, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, 'SESSIONS', ?, ?, ?)`,
    ).run(
      versionId,
      measureId,
      studentId,
      type,
      instruction,
      future(reviewDays),
      visibleInstructors ? 'INSTRUCTORS' : 'ALL_INSTRUCTORS',
      coord,
      ts,
    );
    db.prepare(
      'INSERT INTO measure_version_sessions (version_id, session_id) VALUES (?, ?)',
    ).run(versionId, sessionId);
    db.prepare(
      'INSERT INTO measure_version_sources (version_id, material_id) VALUES (?, ?)',
    ).run(versionId, mat);
    for (const ins of visibleInstructors ?? []) {
      db.prepare(
        'INSERT INTO measure_version_visibility (version_id, user_id) VALUES (?, ?)',
      ).run(versionId, ins);
    }
  };

  measure(
    'SEATING',
    '安排在远离音响与门口的角落座位，减少声光刺激',
    30,
    sciSession,
    [sci],
  );
  measure(
    'DIET',
    '全程避免坚果及含坚果成分食材，使用专属案板',
    60,
    bakeSession,
    null,
  );

  console.log('种子完成。文件:', file);
  console.log('账号（口令均为 pw123456）：');
  console.log('  coord  协调员 / sci 科学课导师 / bake 烘焙导师 / guard 家长 / pupil 学生');
  console.log('科学课场次:', sciSession, ' 烘焙场次:', bakeSession, ' 今天:', today());
}

run();
