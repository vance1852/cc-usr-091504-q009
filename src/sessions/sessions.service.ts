import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { ConflictKind, ReassessReason, Role } from '../common/enums';
import { id, now, overlaps } from '../common/util';

interface SessionInput {
  name: string;
  description?: string;
  location?: string;
  startAt: string;
  durationMinutes: number;
  instructorId: string;
}

interface SessionRow {
  id: string;
  name: string;
  description: string;
  location: string;
  start_at: string;
  duration_minutes: number;
  instructor_id: string;
  content_revision: number;
}

@Injectable()
export class SessionsService {
  constructor(private readonly db: DatabaseService) {}

  create(user: { id: string }, input: SessionInput) {
    this.assertInstructor(input.instructorId);
    if (input.durationMinutes <= 0) {
      throw new BadRequestException('时长必须为正数');
    }
    const sessionId = id('ses');
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, name, description, location, start_at, duration_minutes,
            instructor_id, content_revision, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        sessionId,
        input.name,
        input.description ?? '',
        input.location ?? '',
        new Date(input.startAt).toISOString(),
        input.durationMinutes,
        input.instructorId,
        user.id,
        now(),
      );
    return this.get(sessionId);
  }

  get(sessionId: string): SessionRow {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId) as SessionRow | undefined;
    if (!row) throw new NotFoundException('场次不存在');
    return row;
  }

  list(upcomingOnly = false) {
    const sql = `SELECT * FROM sessions ${
      upcomingOnly ? 'WHERE start_at >= ?' : ''
    } ORDER BY start_at`;
    const rows = upcomingOnly
      ? (this.db.prepare(sql).all(now()) as SessionRow[])
      : (this.db.prepare(sql).all() as SessionRow[]);
    return rows;
  }

  enroll(sessionId: string, studentId: string, userId: string) {
    const session = this.get(sessionId);
    const student = this.db
      .prepare('SELECT 1 AS hit FROM students WHERE id = ?')
      .get(studentId);
    if (!student) throw new BadRequestException('学生不存在');
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO enrollments (session_id, student_id, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(sessionId, studentId, now());
      // 报名时即检测与该生其他场次的时间重叠
      this.detectOverlapConflicts(sessionId, studentId, session, userId);
      return { sessionId, studentId };
    });
  }

  enrolledStudents(sessionId: string): string[] {
    return (
      this.db
        .prepare('SELECT student_id FROM enrollments WHERE session_id = ?')
        .all(sessionId) as { student_id: string }[]
    ).map((r) => r.student_id);
  }

  /**
   * 活动内容改变：
   * 1. 场次内容版本号 +1；
   * 2. 为每位报名学生生成 OPEN 重评标记（已存在未解决标记则不重复）；
   * 3. 同时检测该学生时间重叠的其他场次，记录 OVERLAP 冲突供协调员确认。
   * 返回受影响学生与标记。
   */
  changeContent(
    user: { id: string; role: Role },
    sessionId: string,
    patch: { name?: string; description?: string; location?: string; startAt?: string; durationMinutes?: number },
    note?: string,
  ) {
    if (user.role !== Role.COORDINATOR) {
      throw new ForbiddenException('只有协调员可以登记活动内容变更');
    }
    const session = this.get(sessionId);

    if (patch.startAt && Number.isNaN(Date.parse(patch.startAt))) {
      throw new BadRequestException('开始时间无效');
    }
    if (patch.durationMinutes !== undefined && patch.durationMinutes <= 0) {
      throw new BadRequestException('时长必须为正数');
    }

    return this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE sessions SET name = ?, description = ?, location = ?,
             start_at = ?, duration_minutes = ?, content_revision = content_revision + 1
            WHERE id = ?`,
        )
        .run(
          patch.name ?? session.name,
          patch.description ?? session.description,
          patch.location ?? session.location,
          patch.startAt ? new Date(patch.startAt).toISOString() : session.start_at,
          patch.durationMinutes ?? session.duration_minutes,
          sessionId,
        );

      const updated = this.get(sessionId);
      const studentIds = this.enrolledStudents(sessionId);
      const flags: unknown[] = [];

      for (const studentId of studentIds) {
        const existingOpen = this.db
          .prepare(
            `SELECT 1 AS hit FROM reassessment_flags
              WHERE session_id = ? AND student_id = ? AND status = 'OPEN'`,
          )
          .get(sessionId, studentId);
        if (!existingOpen) {
          const flagId = id('flg');
          this.db
            .prepare(
              `INSERT INTO reassessment_flags
                 (id, session_id, student_id, reason, note, content_revision,
                  status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
            )
            .run(
              flagId,
              sessionId,
              studentId,
              ReassessReason.SESSION_CONTENT_CHANGED,
              note ?? null,
              updated.content_revision,
              now(),
            );
          flags.push({ id: flagId, studentId });
        }

        this.detectOverlapConflicts(sessionId, studentId, updated, user.id);
      }

      return {
        sessionId,
        contentRevision: updated.content_revision,
        flaggedStudents: studentIds,
        newFlags: flags,
      };
    });
  }

  /**
   * 多活动重叠验证：找出与本场时间重叠、且同一学生也报名的其他场次，
   * 为每个尚处于 OPEN 的重叠对建立一条 OVERLAP 冲突（去重）。
   */
  private detectOverlapConflicts(
    sessionId: string,
    studentId: string,
    session: SessionRow,
    userId: string,
  ) {
    const others = this.db
      .prepare(
        `SELECT se.* FROM sessions se
           JOIN enrollments e ON e.session_id = se.id
          WHERE e.student_id = ? AND se.id != ?`,
      )
      .all(studentId, sessionId) as SessionRow[];

    for (const other of others) {
      if (
        !overlaps(
          session.start_at,
          session.duration_minutes,
          other.start_at,
          other.duration_minutes,
        )
      ) {
        continue;
      }
      const pairKey = [sessionId, other.id].sort().join('|');
      // 每个场次一侧各生成一条 OPEN 冲突，使两场准备结果都能看到
      for (const sideSessionId of [sessionId, other.id]) {
        const dedupeKey = `${studentId}#${sideSessionId}#${pairKey}`;
        const dup = this.db
          .prepare(
            `SELECT 1 AS hit FROM conflicts
              WHERE student_id = ? AND kind = 'OVERLAP' AND status = 'OPEN'
                AND dedupe_key = ?`,
          )
          .get(studentId, dedupeKey);
        if (dup) continue;
        this.db
          .prepare(
            `INSERT INTO conflicts
               (id, session_id, student_id, measure_id, kind, description,
                dedupe_key, status, created_by, created_at)
             VALUES (?, ?, ?, NULL, 'OVERLAP', ?, ?, 'OPEN', ?, ?)`,
          )
          .run(
            id('cnf'),
            sideSessionId,
            studentId,
            `场次时间重叠[${pairKey}]：${session.name} 与 ${other.name} 时间冲突，需确认饮食/陪同安排`,
            dedupeKey,
            userId,
            now(),
          );
      }
    }
  }

  /** 导师报告当场无法执行（非重叠类冲突） */
  reportInfeasible(
    user: { id: string; role: Role },
    sessionId: string,
    studentId: string,
    measureId: string | null,
    description: string,
  ) {
    this.get(sessionId);
    if (user.role !== Role.INSTRUCTOR && user.role !== Role.COORDINATOR) {
      throw new ForbiddenException();
    }
    const conflictId = id('cnf');
    this.db
      .prepare(
        `INSERT INTO conflicts
           (id, session_id, student_id, measure_id, kind, description,
            status, created_by, created_at)
         VALUES (?, ?, ?, ?, 'INFEASIBLE', ?, 'OPEN', ?, ?)`,
      )
      .run(conflictId, sessionId, studentId, measureId, description, user.id, now());
    return { id: conflictId, kind: ConflictKind.INFEASIBLE, status: 'OPEN' };
  }

  resolveConflict(
    user: { id: string },
    conflictId: string,
    note: string,
  ) {
    const conflict = this.db
      .prepare('SELECT * FROM conflicts WHERE id = ?')
      .get(conflictId) as { status: string } | undefined;
    if (!conflict) throw new NotFoundException();
    this.db
      .prepare(
        `UPDATE conflicts SET status = 'RESOLVED', resolved_at = ?,
           resolved_by = ?, resolution_note = ? WHERE id = ?`,
      )
      .run(now(), user.id, note, conflictId);
    return { id: conflictId, status: 'RESOLVED' };
  }

  resolveFlag(user: { id: string }, flagId: string, note: string) {
    const flag = this.db
      .prepare('SELECT * FROM reassessment_flags WHERE id = ?')
      .get(flagId) as { status: string } | undefined;
    if (!flag) throw new NotFoundException();
    this.db
      .prepare(
        `UPDATE reassessment_flags SET status = 'RESOLVED', resolved_at = ?,
           resolved_by = ?, resolution_note = ? WHERE id = ?`,
      )
      .run(now(), user.id, note, flagId);
    return { id: flagId, status: 'RESOLVED' };
  }

  openFlags(sessionId: string, studentId?: string) {
    if (studentId) {
      return this.db
        .prepare(
          `SELECT * FROM reassessment_flags
            WHERE session_id = ? AND student_id = ? AND status = 'OPEN'
            ORDER BY created_at`,
        )
        .all(sessionId, studentId);
    }
    return this.db
      .prepare(
        `SELECT * FROM reassessment_flags
          WHERE session_id = ? AND status = 'OPEN' ORDER BY created_at`,
      )
      .all(sessionId);
  }

  openConflicts(sessionId: string) {
    return this.db
      .prepare(
        `SELECT * FROM conflicts
          WHERE session_id = ? AND status = 'OPEN' ORDER BY created_at`,
      )
      .all(sessionId);
  }

  private assertInstructor(userId: string) {
    const user = this.db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(userId) as { role: string } | undefined;
    if (!user) throw new BadRequestException('导师不存在');
    if (user.role !== Role.INSTRUCTOR) {
      throw new BadRequestException('该账号不是导师');
    }
  }
}
