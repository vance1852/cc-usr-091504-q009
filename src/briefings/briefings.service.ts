import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../db/database.service';
import { AccessPolicyService } from '../access/access-policy.service';
import { BlockReason, Role } from '../common/enums';
import { id, now, today } from '../common/util';

interface SessionRow {
  id: string;
  name: string;
  start_at: string;
  duration_minutes: number;
  instructor_id: string;
  content_revision: number;
}

interface BriefingItem {
  measureId: string;
  versionId: string;
  versionNo: number;
  studentId: string;
  studentName: string;
  type: string;
  instruction: string;
  reviewDate: string;
  targetKind: 'ALL' | 'SESSIONS';
  visibilityKind: 'ALL_INSTRUCTORS' | 'INSTRUCTORS';
  createdBy: string;
  createdAt: string;
  retiredAt: string | null;
}

interface FlagRow {
  id: string;
  student_id: string;
  reason: string;
  note: string | null;
  content_revision: number;
  created_at: string;
}

interface ConflictRow {
  id: string;
  student_id: string;
  measure_id: string | null;
  kind: string;
  description: string;
  created_by: string;
  created_at: string;
}

@Injectable()
export class BriefingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly policy: AccessPolicyService,
  ) {}

  private session(sessionId: string): SessionRow {
    const s = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId) as SessionRow | undefined;
    if (!s) throw new NotFoundException('场次不存在');
    return s;
  }

  /**
   * 导师当场简报：只返回当场必须执行的措施。
   * 不含诊断原文、不含被拦截原因、不含学生私密偏好、不含材料引用。
   */
  instructorBriefing(user: { id: string; role: Role }, sessionId: string) {
    const session = this.session(sessionId);
    if (user.role !== Role.INSTRUCTOR || session.instructor_id !== user.id) {
      throw new ForbiddenException('只有本场导师可以读取本场简报');
    }
    const computed = this.compute(session, user.id);
    return {
      session: {
        id: session.id,
        name: session.name,
        startAt: session.start_at,
        durationMinutes: session.duration_minutes,
        contentRevision: session.content_revision,
      },
      generatedAt: now(),
      snapshotHash: computed.snapshotHash,
      items: computed.active.map((i) => ({
        studentId: i.studentId,
        studentName: i.studentName,
        type: i.type,
        instruction: i.instruction,
        measureId: i.measureId,
        versionId: i.versionId,
        versionNo: i.versionNo,
      })),
      // 学生选择公开给导师的偏好（PRIVATE 绝不出现）
      preferences: computed.sharedPreferences,
      // 导师本人可见的未决冲突（操作性信息，可能由其上报）
      pendingConflicts: computed.conflicts.map((c) => ({
        id: c.id,
        studentId: c.student_id,
        kind: c.kind,
        description: c.description,
      })),
      readReceipt: computed.latestOwnReceipt,
    };
  }

  /**
   * 协调员的一次活动准备结果：
   * 已满足措施（含所引用版本）、被拦截措施及原因、待确认冲突与重评、
   * 导师阅读回执、已确认替代措施。
   */
  preparation(user: { id: string; role: Role }, sessionId: string) {
    if (user.role !== Role.COORDINATOR) {
      throw new ForbiddenException('只有协调员可以查看活动准备结果');
    }
    const session = this.session(sessionId);
    const computed = this.compute(session, session.instructor_id);

    return {
      session: {
        id: session.id,
        name: session.name,
        startAt: session.start_at,
        durationMinutes: session.duration_minutes,
        instructorId: session.instructor_id,
        contentRevision: session.content_revision,
      },
      generatedAt: now(),
      snapshotHash: computed.snapshotHash,
      satisfied: computed.active.map((i) => ({
        studentId: i.studentId,
        studentName: i.studentName,
        type: i.type,
        instruction: i.instruction,
        measureId: i.measureId,
        versionId: i.versionId,
        versionNo: i.versionNo,
        reviewDate: i.reviewDate,
        sources: this.sources(i.versionId),
      })),
      blocked: computed.blocked.map((i) => ({
        studentId: i.studentId,
        studentName: i.studentName,
        type: i.type,
        measureId: i.measureId,
        versionId: i.versionId,
        versionNo: i.versionNo,
        reviewDate: i.reviewDate,
        blockReasons: i.blockReasons,
      })),
      pendingReassessments: computed.flags.map((f) => ({
        id: f.id,
        studentId: f.student_id,
        reason: f.reason,
        note: f.note,
        contentRevision: f.content_revision,
        createdAt: f.created_at,
      })),
      pendingConflicts: computed.conflicts.map((c) => ({
        id: c.id,
        studentId: c.student_id,
        measureId: c.measure_id,
        kind: c.kind,
        description: c.description,
        createdBy: c.created_by,
        createdAt: c.created_at,
      })),
      // 含学生明确不愿公开给导师的偏好；PRIVATE 项不会进入导师简报
      preferences: computed.allPreferences,
      confirmedAlternatives: computed.confirmedAlternatives,
      readReceipts: computed.receipts,
    };
  }

  /** 导师确认已读：回执绑定当时简报快照与条目数 */
  acknowledge(user: { id: string; role: Role }, sessionId: string) {
    const session = this.session(sessionId);
    if (user.role !== Role.INSTRUCTOR || session.instructor_id !== user.id) {
      throw new ForbiddenException('只有本场导师可以签收');
    }
    const computed = this.compute(session, user.id);
    const readAt = now();
    const receiptId = id('rcp');
    this.db
      .prepare(
        `INSERT INTO read_receipts (id, session_id, user_id, snapshot_hash, item_count, read_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(receiptId, sessionId, user.id, computed.snapshotHash, computed.active.length, readAt);
    return {
      id: receiptId,
      snapshotHash: computed.snapshotHash,
      itemCount: computed.active.length,
      readAt,
    };
  }

  /**
   * 记录措施已执行：仅当措施此刻对导师处于分发状态。
   * 保存操作说明与当时同意版本的不可变快照；之后撤回/过期不影响记录。
   */
  logExecution(
    user: { id: string; role: Role },
    sessionId: string,
    measureId: string,
    note?: string,
  ) {
    const session = this.session(sessionId);
    if (user.role !== Role.INSTRUCTOR || session.instructor_id !== user.id) {
      throw new ForbiddenException('只有本场导师可以登记执行');
    }
    const computed = this.compute(session, user.id);
    const item = computed.active.find((a) => a.measureId === measureId);
    if (!item) {
      throw new BadRequestException(
        '该措施当前不在本场可执行清单中（可能已过期、同意范围调整或需要重新评估）',
      );
    }
    const consent = this.policy.currentConsent(item.studentId);
    const executedAt = now();
    const logId = id('exe');
    this.db
      .prepare(
        `INSERT INTO execution_log
           (id, session_id, student_id, measure_id, measure_version_id, type,
            instruction_snapshot, consent_version_id, executed_by, executed_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        logId,
        sessionId,
        item.studentId,
        measureId,
        item.versionId,
        item.type,
        item.instruction,
        consent?.id ?? null,
        user.id,
        executedAt,
        note ?? null,
      );
    return {
      id: logId,
      measureId,
      versionId: item.versionId,
      consentVersionId: consent?.id ?? null,
      executedAt,
    };
  }

  listExecutions(sessionId: string, user: { id: string; role: Role }, studentId?: string) {
    const session = this.session(sessionId);
    // 导师只能查看本人负责场次的执行记录
    if (user.role === Role.INSTRUCTOR && session.instructor_id !== user.id) {
      throw new ForbiddenException('只能查看本人场次的执行记录');
    }
    const sql = `
      SELECT l.*, u.name AS executed_by_name
        FROM execution_log l JOIN users u ON u.id = l.executed_by
       WHERE l.session_id = ? ${studentId ? 'AND l.student_id = ?' : ''}
       ORDER BY l.executed_at`;
    return studentId
      ? this.db.prepare(sql).all(sessionId, studentId)
      : this.db.prepare(sql).all(sessionId);
  }

  // ---------- 核心分发计算 ----------

  private compute(session: SessionRow, instructorId: string) {
    const enrolled = new Set(
      (
        this.db
          .prepare('SELECT student_id FROM enrollments WHERE session_id = ?')
          .all(session.id) as { student_id: string }[]
      ).map((r) => r.student_id),
    );

    const candidates = (
      this.db
        .prepare(
          `SELECT m.id AS measure_id, m.retired_at,
                  mv.id AS version_id, mv.version_no, mv.student_id,
                  s.name AS student_name,
                  mv.type, mv.instruction, mv.review_date,
                  mv.target_kind, mv.visibility_kind,
                  mv.created_by, mv.created_at
             FROM measures m
             JOIN measure_versions mv ON mv.id = m.current_version_id
             JOIN students s ON s.id = mv.student_id
            WHERE mv.student_id IN (SELECT student_id FROM enrollments WHERE session_id = ?)
            ORDER BY s.name, mv.type`,
        )
        .all(session.id) as Record<string, unknown>[]
    )
      .map((v) => this.toItem(v))
      .filter(
        (v) => enrolled.has(v.studentId) && this.appliesToSession(v, session.id),
      );

    const flags = this.db
      .prepare(
        `SELECT * FROM reassessment_flags
          WHERE session_id = ? AND status = 'OPEN'`,
      )
      .all(session.id) as FlagRow[];
    const flaggedStudents = new Set(flags.map((f) => f.student_id));

    const conflicts = this.db
      .prepare(
        `SELECT * FROM conflicts
          WHERE session_id = ? AND status = 'OPEN' ORDER BY created_at`,
      )
      .all(session.id) as ConflictRow[];
    const conflictMeasures = new Set(
      conflicts.filter((c) => c.measure_id).map((c) => c.measure_id as string),
    );
    const studentLevelConflicts = new Set(
      conflicts.filter((c) => !c.measure_id).map((c) => c.student_id),
    );

    const active: BriefingItem[] = [];
    const blocked: Array<BriefingItem & { blockReasons: BlockReason[] }> = [];

    for (const v of candidates) {
      const reasons: BlockReason[] = [];

      if (v.retiredAt) reasons.push(BlockReason.RETIRED);
      if (v.reviewDate < today()) reasons.push(BlockReason.REVIEW_DUE);

      const consent = this.policy.currentConsent(v.studentId);
      if (!consent) {
        reasons.push(BlockReason.CONSENT_MISSING);
      } else if (!consent.allowed_types.split(',').includes(v.type)) {
        reasons.push(BlockReason.CONSENT_WITHDRAWN);
      }

      if (!this.policy.hasActiveGrant(v.studentId, v.createdBy, v.type as never)) {
        reasons.push(BlockReason.GRANT_REVOKED);
      }
      if (flaggedStudents.has(v.studentId)) {
        reasons.push(BlockReason.REASSESSMENT_OPEN);
      }
      if (conflictMeasures.has(v.measureId) || studentLevelConflicts.has(v.studentId)) {
        reasons.push(BlockReason.CONFLICT_OPEN);
      }
      if (
        v.visibilityKind === 'INSTRUCTORS' &&
        !this.visibleTo(v.versionId, instructorId)
      ) {
        reasons.push(BlockReason.NOT_VISIBLE);
      }

      if (reasons.length === 0) {
        active.push(v);
      } else {
        blocked.push({ ...v, blockReasons: reasons });
      }
    }

    const sharedPreferences = this.db
      .prepare(
        `SELECT p.student_id AS studentId, s.name AS studentName, p.text
           FROM student_preferences p
           JOIN students s ON s.id = p.student_id
          WHERE p.visibility = 'SHARE_INSTRUCTOR'
            AND p.student_id IN (SELECT student_id FROM enrollments WHERE session_id = ?)
          ORDER BY p.created_at`,
      )
      .all(session.id);

    // 所有偏好（含私密）仅供协调员准备结果
    const allPreferences = this.db
      .prepare(
        `SELECT p.student_id AS studentId, s.name AS studentName, p.text, p.visibility
           FROM student_preferences p
           JOIN students s ON s.id = p.student_id
          WHERE p.student_id IN (SELECT student_id FROM enrollments WHERE session_id = ?)
          ORDER BY p.created_at`,
      )
      .all(session.id);

    const confirmedAlternatives = (
      this.db
        .prepare(
          `SELECT a.id, a.student_id AS studentId, a.measure_id AS measureId,
                  a.type, a.instruction, a.reviewed_at AS reviewedAt
             FROM alternatives a
            WHERE a.status = 'CONFIRMED'
              AND a.student_id IN (SELECT student_id FROM enrollments WHERE session_id = ?)
            ORDER BY a.reviewed_at DESC`,
        )
        .all(session.id)
    );

    const snapshotHash = this.hashItems(active.map((a) => a.versionId));

    const receipts = this.db
      .prepare(
        `SELECT r.id, r.user_id, u.name AS reader_name, r.snapshot_hash,
                r.item_count, r.read_at
           FROM read_receipts r JOIN users u ON u.id = r.user_id
          WHERE r.session_id = ? ORDER BY r.read_at DESC`,
      )
      .all(session.id) as {
      id: string;
      user_id: string;
      reader_name: string;
      snapshot_hash: string;
      item_count: number;
      read_at: string;
    }[];
    const receiptList = receipts.map((r) => ({
      id: r.id,
      readerId: r.user_id,
      readerName: r.reader_name,
      snapshotHash: r.snapshot_hash,
      itemCount: r.item_count,
      readAt: r.read_at,
      current: r.snapshot_hash === snapshotHash,
    }));
    const latestOwn = receipts.find((r) => r.user_id === instructorId);
    const latestOwnReceipt = latestOwn
      ? {
          snapshotHash: latestOwn.snapshot_hash,
          itemCount: latestOwn.item_count,
          readAt: latestOwn.read_at,
          current: latestOwn.snapshot_hash === snapshotHash,
        }
      : null;

    return {
      active,
      blocked,
      flags,
      conflicts,
      sharedPreferences,
      allPreferences,
      confirmedAlternatives,
      receipts: receiptList,
      latestOwnReceipt,
      snapshotHash,
    };
  }

  private toItem(v: Record<string, unknown>): BriefingItem {
    return {
      measureId: v.measure_id as string,
      versionId: v.version_id as string,
      versionNo: v.version_no as number,
      studentId: v.student_id as string,
      studentName: v.student_name as string,
      type: v.type as string,
      instruction: v.instruction as string,
      reviewDate: v.review_date as string,
      targetKind: v.target_kind as BriefingItem['targetKind'],
      visibilityKind: v.visibility_kind as BriefingItem['visibilityKind'],
      createdBy: v.created_by as string,
      createdAt: v.created_at as string,
      retiredAt: (v.retired_at as string | null) ?? null,
    };
  }

  private appliesToSession(v: BriefingItem, sessionId: string): boolean {
    if (v.targetKind === 'ALL') return true;
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 AS hit FROM measure_version_sessions WHERE version_id = ? AND session_id = ?',
        )
        .get(v.versionId, sessionId),
    );
  }

  private visibleTo(versionId: string, instructorId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 AS hit FROM measure_version_visibility WHERE version_id = ? AND user_id = ?',
        )
        .get(versionId, instructorId),
    );
  }

  private sources(versionId: string) {
    return this.db
      .prepare(
        `SELECT m.id, m.kind, m.title, m.created_at
           FROM measure_version_sources s
           JOIN raw_materials m ON m.id = s.material_id
          WHERE s.version_id = ? ORDER BY m.created_at`,
      )
      .all(versionId);
  }

  private hashItems(versionIds: string[]): string {
    return createHash('sha256')
      .update([...versionIds].sort().join('|'))
      .digest('hex');
  }
}
