import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import {
  ReassessmentReason,
  VersionStatus,
  contentHash,
  nowIso,
  sha256,
  uuid,
} from '../common/domain';

export interface MeasureConstraints {
  area?: string;
  reduceStimuli?: boolean;
  avoidAllergens?: string[];
  separateUtensils?: boolean;
  escort?: string;
  toZone?: string;
  approach?: string;
  avoidSurprise?: boolean;
  note?: string;
  [k: string]: unknown;
}

export interface ApplicableMeasure {
  measureId: string;
  studentId: string;
  studentName: string;
  type: string;
  version: number;
  status: VersionStatus;
  instruction: string;
  constraints: MeasureConstraints;
  reviewDate: string;
  expiresAt: string | null;
  consentScope: string;
  consentGrantId: string | null;
  authorizationId: string;
  basedOnHash: string;
  distributable: boolean;
  blockReasons: ReassessmentReason[];
  pendingReasons: ReassessmentReason[];
}

/**
 * 支持措施的资格判定与失效传播集中于此:
 * 导师简报、活动准备、监护人视图共用同一套规则,避免各处判断不一致。
 */
@Injectable()
export class SupportLogic {
  constructor(private readonly db: DbService) {}

  scopeMatches(
    s: { scope_type: string; activity_id: string | null; program_code: string | null },
    activity: { id: string; program_code: string | null },
  ): boolean {
    if (s.scope_type === 'global') return true;
    if (s.scope_type === 'activity') return s.activity_id === activity.id;
    if (s.scope_type === 'program')
      return !!s.program_code && s.program_code === activity.program_code;
    return false;
  }

  getActivity(activityId: string) {
    return this.db
      .prepare(`SELECT * FROM activities WHERE id = ?`)
      .get(activityId) as any;
  }

  getEnrolledStudentIds(activityId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT student_id FROM activity_students WHERE activity_id = ?`,
        )
        .all(activityId) as any[]
    ).map((r) => r.student_id);
  }

  /** 取某学生在某活动适用的全部措施及其最新版本与分发资格 */
  forStudentInActivity(
    studentId: string,
    activity: any,
  ): ApplicableMeasure[] {
    const scopes = this.db
      .prepare(`SELECT * FROM measure_scopes`)
      .all() as any[];
    const enrolled = new Set(this.getEnrolledStudentIds(activity.id));
    const measureIds = new Set<string>();
    if (enrolled.has(studentId)) {
      for (const s of scopes) {
        if (this.scopeMatches(s, activity)) measureIds.add(s.measure_id);
      }
    }
    const out: ApplicableMeasure[] = [];
    for (const measureId of measureIds) {
      const m = this.db
        .prepare(
          `SELECT m.*, s.name AS student_name
           FROM measures m JOIN students s ON s.id = m.student_id
           WHERE m.id = ? AND m.student_id = ?`,
        )
        .get(measureId, studentId) as any;
      if (!m) continue;
      const v = this.latestVersion(measureId);
      if (!v) continue;
      out.push(this.evaluate(m, v, activity.id));
    }
    return out;
  }

  latestVersion(measureId: string): any {
    return this.db
      .prepare(
        `SELECT * FROM measure_versions
         WHERE measure_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(measureId);
  }

  /** 某活动全部在册学生的适用措施 */
  applicableToActivity(activity: any): ApplicableMeasure[] {
    const enrolled = this.getEnrolledStudentIds(activity.id);
    const result: ApplicableMeasure[] = [];
    for (const sid of enrolled) {
      result.push(...this.forStudentInActivity(sid, activity));
    }
    return result;
  }

  /** 判断单个版本当前是否可分发,以及阻断原因 */
  evaluate(measure: any, v: any, activityId: string): ApplicableMeasure {
    const blockReasons: ReassessmentReason[] = [];
    const pending = this.db
      .prepare(
        `SELECT reason FROM reassessments
         WHERE measure_id = ? AND activity_id = ? AND status = 'pending'`,
      )
      .all(v.measure_id, activityId) as any[];
    const pendingReasons = pending.map((p) => p.reason);

    const auth = this.db
      .prepare(`SELECT revoked_at FROM authorizations WHERE id = ?`)
      .get(v.authorization_id) as any;
    const consentOk =
      !v.consent_grant_id ||
      !(
        this.db
          .prepare(
            `SELECT revoked_at FROM consent_grants WHERE id = ?`,
          )
          .get(v.consent_grant_id) as any
      )?.revoked_at;

    const now = Date.now();
    if (!auth || auth.revoked_at)
      blockReasons.push('authorization_revoked');
    if (!consentOk) blockReasons.push('consent_withdrawn');
    if (Date.parse(v.review_date) < now) blockReasons.push('review_due');
    if (v.expires_at && Date.parse(v.expires_at) < now)
      blockReasons.push('expired');
    blockReasons.push(...pendingReasons);

    const distributable =
      (v.status === 'active' ||
        v.status === 'confirmed_alternative') &&
      blockReasons.length === 0;

    return {
      measureId: measure.id,
      studentId: measure.student_id,
      studentName: measure.student_name,
      type: measure.type,
      version: v.version,
      status: v.status,
      instruction: v.instruction,
      constraints: JSON.parse(v.constraints_json || '{}'),
      reviewDate: v.review_date,
      expiresAt: v.expires_at,
      consentScope: v.consent_scope,
      consentGrantId: v.consent_grant_id,
      authorizationId: v.authorization_id,
      basedOnHash: v.based_on_hash,
      distributable,
      blockReasons: [...new Set(blockReasons)],
      pendingReasons: [...new Set(pendingReasons)],
    };
  }

  /** 阻断旧简报继续分发(已执行记录不受影响,其快照独立保存) */
  blockBriefings(opts: {
    measureId: string;
    version?: number;
    activityId?: string;
    reason: string;
  }) {
    const rows = this.db
      .prepare(
        `SELECT id FROM mentor_briefings
         WHERE measure_id = ? AND blocked_at IS NULL
           AND (? IS NULL OR version = ?)
           AND (? IS NULL OR activity_id = ?)`,
      )
      .all(
        opts.measureId,
        opts.version ?? null,
        opts.version ?? null,
        opts.activityId ?? null,
        opts.activityId ?? null,
      ) as any[];
    const stmt = this.db.prepare(
      `UPDATE mentor_briefings SET blocked_at = ?, block_reason = ? WHERE id = ?`,
    );
    for (const r of rows) stmt.run(nowIso(), opts.reason, r.id);
  }

  raiseReassessment(opts: {
    studentId: string;
    measureId: string;
    version: number;
    reason: ReassessmentReason;
    activityId?: string | null;
  }) {
    // 同一未处理项不重复建单
    const exists = this.db
      .prepare(
        `SELECT 1 FROM reassessments
         WHERE measure_id = ? AND student_id = ?
           AND IFNULL(activity_id,'') = IFNULL(?, '')
           AND reason = ? AND status = 'pending'`,
      )
      .get(
        opts.measureId,
        opts.studentId,
        opts.activityId ?? null,
        opts.reason,
      );
    if (exists) return;
    this.db
      .prepare(
        `INSERT INTO reassessments
           (id, student_id, activity_id, measure_id, version, reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        uuid(),
        opts.studentId,
        opts.activityId ?? null,
        opts.measureId,
        opts.version,
        opts.reason,
        nowIso(),
      );
  }

  /** 活动内容变更:自动登记所有在册学生适用措施的重新评估并阻断旧简报 */
  onContentChanged(activity: any) {
    for (const a of this.applicableToActivity(activity)) {
      this.raiseReassessment({
        studentId: a.studentId,
        activityId: activity.id,
        measureId: a.measureId,
        version: a.version,
        reason: 'content_changed',
      });
      this.blockBriefings({
        measureId: a.measureId,
        activityId: activity.id,
        reason: 'content_changed',
      });
    }
  }

  /** 授权撤回:相关版本失效、建单、阻断分发 */
  onAuthorizationRevoked(authorizationId: string) {
    const versions = this.db
      .prepare(
        `SELECT DISTINCT measure_id, version FROM measure_versions
         WHERE authorization_id = ? AND status IN ('active','confirmed_alternative')`,
      )
      .all(authorizationId) as any[];
    for (const v of versions) {
      this.db
        .prepare(
          `UPDATE measure_versions SET status = 'revoked', decided_at = ?,
             revoke_reason = 'authorization_revoked'
           WHERE measure_id = ? AND version = ?`,
        )
        .run(nowIso(), v.measure_id, v.version);
      this.blockBriefings({
        measureId: v.measure_id,
        version: v.version,
        reason: 'authorization_revoked',
      });
      this.queueForAllActivities(v.measure_id, 'authorization_revoked');
    }
  }

  /** 监护人撤回同意:不改版本状态,但阻止分发并要求重新评估 */
  onConsentWithdrawn(grantId: string) {
    const versions = this.db
      .prepare(
        `SELECT DISTINCT measure_id, version FROM measure_versions
         WHERE consent_grant_id = ? AND status IN ('active','confirmed_alternative')`,
      )
      .all(grantId) as any[];
    for (const v of versions) {
      this.blockBriefings({
        measureId: v.measure_id,
        version: v.version,
        reason: 'consent_withdrawn',
      });
      this.queueForAllActivities(v.measure_id, 'consent_withdrawn');
    }
  }

  /** 为某措施在所有适用活动建立重新评估单 */
  private queueForAllActivities(
    measureId: string,
    reason: ReassessmentReason,
  ) {
    const m = this.db
      .prepare(`SELECT * FROM measures WHERE id = ?`)
      .get(measureId) as any;
    const v = this.latestVersion(measureId);
    if (!m || !v) return;
    const activities = this.db
      .prepare(`SELECT * FROM activities`)
      .all() as any[];
    for (const a of activities) {
      const applicable = this.forStudentInActivity(m.student_id, a);
      if (applicable.some((x) => x.measureId === measureId)) {
        this.raiseReassessment({
          studentId: m.student_id,
          activityId: a.id,
          measureId,
          version: v.version,
          reason,
        });
      }
    }
  }

  /** 过期/到期巡检:把到期版本置 expired 并建单、阻断分发 */
  sweep(activityId?: string) {
    const now = nowIso();
    const due = this.db
      .prepare(
        `SELECT mv.measure_id, mv.version, mv.review_date, mv.expires_at, m.student_id
         FROM measure_versions mv JOIN measures m ON m.id = mv.measure_id
         WHERE mv.status IN ('active','confirmed_alternative')
           AND (date(review_date) < date(?) OR (expires_at IS NOT NULL AND expires_at < ?))`,
      )
      .all(now, now) as any[];
    for (const d of due) {
      const reason: ReassessmentReason =
        d.expires_at && Date.parse(d.expires_at) < Date.parse(now)
          ? 'expired'
          : 'review_due';
      this.db
        .prepare(
          `UPDATE measure_versions SET status = 'expired', decided_at = ?
           WHERE measure_id = ? AND version = ? AND status IN ('active','confirmed_alternative')`,
        )
        .run(now, d.measure_id, d.version);
      this.blockBriefings({
        measureId: d.measure_id,
        version: d.version,
        reason,
      });
      const activities = activityId
        ? [this.getActivity(activityId)].filter(Boolean)
        : (this.db.prepare(`SELECT * FROM activities`).all() as any[]);
      for (const a of activities) {
        const applicable = this.forStudentInActivity(d.student_id, a);
        if (applicable.some((x) => x.measureId === d.measure_id)) {
          this.raiseReassessment({
            studentId: d.student_id,
            activityId: a.id,
            measureId: d.measure_id,
            version: d.version,
            reason,
          });
        }
      }
    }
  }

  /** 新版本生效:旧版本作废、旧简报阻断、该措施的待处理重新评估单关闭 */
  publishVersion(opts: {
    measureId: string;
    newVersion: number;
  }) {
    this.db
      .prepare(
        `UPDATE measure_versions SET status = 'superseded'
         WHERE measure_id = ? AND version < ?
           AND status IN ('active','confirmed_alternative','draft','expired','revoked')`,
      )
      .run(opts.measureId, opts.newVersion);
    this.db
      .prepare(
        `UPDATE mentor_briefings SET blocked_at = ?, block_reason = 'superseded'
         WHERE measure_id = ? AND version < ? AND blocked_at IS NULL`,
      )
      .run(nowIso(), opts.measureId, opts.newVersion);
    this.db
      .prepare(
        `UPDATE reassessments SET status = 'resolved', resolved_at = ?
         WHERE measure_id = ? AND status = 'pending'`,
      )
      .run(nowIso(), opts.measureId);
  }

  computeVersionHash(input: {
    instruction: string;
    constraints: MeasureConstraints;
    reviewDate: string;
    consentScope: string;
    prevHash: string;
    sourceMaterialId: string;
  }): string {
    return sha256(
      [
        input.prevHash,
        input.sourceMaterialId,
        input.instruction,
        JSON.stringify(input.constraints),
        input.reviewDate,
        input.consentScope,
      ].join('|'),
    );
  }

  // ---------- 多活动重叠与当场冲突 ----------

  overlaps(a: any, b: any): boolean {
    return (
      a.id !== b.id &&
      Date.parse(a.starts_at) < Date.parse(b.ends_at) &&
      Date.parse(b.starts_at) < Date.parse(a.ends_at)
    );
  }

  /** 跨活动重叠:同一学生被排进时间重叠的两场活动(陪同类措施同时执行尤甚) */
  crossActivityOverlaps(): any[] {
    const activities = this.db
      .prepare(`SELECT * FROM activities ORDER BY starts_at`)
      .all() as any[];
    const out: any[] = [];
    for (let i = 0; i < activities.length; i++) {
      for (let j = i + 1; j < activities.length; j++) {
        if (!this.overlaps(activities[i], activities[j])) continue;
        const aStudents = new Set(this.getEnrolledStudentIds(activities[i].id));
        const shared = this.getEnrolledStudentIds(activities[j].id).filter(
          (sid) => aStudents.has(sid),
        );
        for (const sid of shared) {
          const ai = this.forStudentInActivity(sid, activities[i]);
          const bj = this.forStudentInActivity(sid, activities[j]);
          const escortBoth =
            ai.some((m) => m.type === 'accompaniment') &&
            bj.some((m) => m.type === 'accompaniment');
          out.push({
            studentId: sid,
            activityA: activities[i].id,
            activityB: activities[j].id,
            titleA: activities[i].title,
            titleB: activities[j].title,
            escortConflict: escortBoth,
          });
        }
      }
    }
    return out;
  }

  /**
   * 当场待确认冲突:
   * - 饮食回避 vs 活动实际含过敏原(且协调员尚未确认替代措施版本)
   * - 低刺激座位要求 vs 活动内容标记为高刺激
   */
  detectInActivityConflicts(activity: any): any[] {
    const conflicts: any[] = [];
    const allergens: string[] = JSON.parse(activity.allergens || '[]');
    const highStim = /高刺激|嘈杂| loud|noise/i.test(
      activity.content_summary || '',
    );
    for (const m of this.applicableToActivity(activity)) {
      if (m.type === 'dietary' && Array.isArray(m.constraints.avoidAllergens)) {
        const hit = m.constraints.avoidAllergens.filter((x) =>
          allergens.includes(x),
        );
        if (hit.length > 0 && m.status !== 'confirmed_alternative') {
          conflicts.push({
            studentId: m.studentId,
            measureId: m.measureId,
            version: m.version,
            kind: 'allergen_exposure',
            description: `活动含 ${hit.join('、')};学生措施要求回避,需确认替代安排`,
          });
        }
      }
      if (m.type === 'seating' && m.constraints.reduceStimuli && highStim) {
        conflicts.push({
          studentId: m.studentId,
          measureId: m.measureId,
          version: m.version,
          kind: 'sensory_override',
          description: '活动为高刺激内容,低刺激座位安排需重新确认',
        });
      }
    }
    return conflicts;
  }

  recordConflicts(activityId: string, detected: any[]) {
    const insert = this.db.prepare(
      `INSERT INTO conflicts
         (id, activity_id, student_id_a, measure_id_a, version_a,
          kind, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    for (const c of detected) {
      const exists = this.db
        .prepare(
          `SELECT 1 FROM conflicts
           WHERE activity_id = ? AND measure_id_a = ? AND kind = ? AND status = 'pending'`,
        )
        .get(activityId, c.measureId, c.kind);
      if (!exists) {
        insert.run(
          uuid(),
          activityId,
          c.studentId,
          c.measureId,
          c.version,
          c.kind,
          c.description,
          nowIso(),
        );
      }
    }
  }

  hashContent(summary: string): string {
    return contentHash(summary);
  }
}
