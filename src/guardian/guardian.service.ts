import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../db/db.service';
import { SupportLogic } from '../logic/support.logic';
import { AuthUser, nowIso, uuid } from '../common/domain';

@Injectable()
export class GuardianService {
  constructor(
    private readonly db: DbService,
    private readonly logic: SupportLogic,
  ) {}

  private childId(user: AuthUser): string {
    if (!user.linkedStudentId)
      throw new ForbiddenException('该监护人账号尚未关联学生');
    return user.linkedStudentId;
  }

  /** 监护人授予同意范围(如"可向烘焙导师分发饮食回避要求") */
  grantConsent(user: AuthUser, dto: { scope: string; details?: string }) {
    const studentId = this.childId(user);
    const id = uuid();
    this.db
      .prepare(
        `INSERT INTO consent_grants
           (id, student_id, scope, details, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, studentId, dto.scope, dto.details ?? null, user.id, nowIso());
    return { id, scope: dto.scope };
  }

  /** 监护人调整/撤回同意:旧摘要立即停止分发,并触发重新评估 */
  withdrawConsent(user: AuthUser, grantId: string, note?: string) {
    const studentId = this.childId(user);
    const g = this.db
      .prepare(`SELECT * FROM consent_grants WHERE id = ? AND student_id = ?`)
      .get(grantId, studentId) as any;
    if (!g) throw new NotFoundException('同意记录不存在或不属于您的孩子');
    if (g.revoked_at) return { ok: true, alreadyRevoked: true };
    this.db.tx(() => {
      this.db
        .prepare(
          `UPDATE consent_grants SET revoked_at = ?, revoke_note = ? WHERE id = ?`,
        )
        .run(nowIso(), note ?? null, grantId);
      this.logic.onConsentWithdrawn(grantId);
    });
    return { ok: true };
  }

  listConsents(user: AuthUser) {
    const studentId = this.childId(user);
    return this.db
      .prepare(
        `SELECT id, scope, details, granted_at, revoked_at, revoke_note
         FROM consent_grants WHERE student_id = ? ORDER BY granted_at DESC`,
      )
      .all(studentId);
  }

  /**
   * 家长视图:本人孩子各措施的"当前版本"(可执行文本,非诊断原文),
   * 以及该版本在各适用活动中的可分发状态。
   */
  currentView(user: AuthUser) {
    const studentId = this.childId(user);
    const student = this.db
      .prepare(`SELECT id, name FROM students WHERE id = ?`)
      .get(studentId) as any;

    const measures = this.db
      .prepare(
        `SELECT m.id, m.type, m.created_at,
                mv.version, mv.status, mv.instruction, mv.constraints_json,
                mv.review_date, mv.expires_at, mv.consent_scope,
                mv.based_on_hash
         FROM measures m
         JOIN measure_versions mv
           ON mv.measure_id = m.id
          AND mv.version = (
            SELECT MAX(version) FROM measure_versions WHERE measure_id = m.id
          )
         WHERE m.student_id = ?
         ORDER BY m.type`,
      )
      .all(studentId) as any[];

    const activities = this.db
      .prepare(
        `SELECT a.* FROM activity_students e
         JOIN activities a ON a.id = e.activity_id
         WHERE e.student_id = ?`,
      )
      .all(studentId) as any[];

    return {
      student: { id: student.id, name: student.name },
      measures: measures.map((m) => {
        const perActivity = activities.map((a) => {
          const applicable = this.logic
            .forStudentInActivity(studentId, a)
            .find((x) => x.measureId === m.id);
          if (!applicable) return null;
          return {
            activityId: a.id,
            title: a.title,
            distributable: applicable.distributable,
            blockReasons: applicable.blockReasons,
          };
        }).filter(Boolean);
        return {
          measureId: m.id,
          type: m.type,
          version: m.version,
          status: m.status,
          instruction: m.instruction,
          constraints: JSON.parse(m.constraints_json || '{}'),
          reviewDate: m.review_date,
          expiresAt: m.expires_at,
          consentScope: m.consent_scope,
          basedOnHash: m.based_on_hash,
          perActivity,
        };
      }),
    };
  }
}
