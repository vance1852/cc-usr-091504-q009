import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../db/db.service';
import { SupportLogic, MeasureConstraints } from '../logic/support.logic';
import {
  AuthUser,
  MeasureType,
  ScopeType,
  VersionStatus,
  contentHash,
  daysFromNow,
  nowIso,
  sha256,
  uuid,
} from '../common/domain';

interface ScopeDto {
  scopeType: ScopeType;
  activityId?: string;
  programCode?: string;
}

@Injectable()
export class CoordinationService {
  constructor(
    private readonly db: DbService,
    private readonly logic: SupportLogic,
  ) {}

  // ---------------- 学生 / 账号关联 ----------------

  createStudent(user: AuthUser, name: string) {
    const id = uuid();
    this.db
      .prepare(
        `INSERT INTO students (id, name, created_by, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, name, user.id, nowIso());
    return { id, name };
  }

  linkGuardian(studentId: string, guardianUserId: string) {
    const u = this.db
      .prepare(`SELECT role FROM users WHERE id = ?`)
      .get(guardianUserId) as any;
    if (!u || u.role !== 'guardian')
      throw new BadRequestException('目标账号不是监护人');
    this.db
      .prepare(`UPDATE users SET linked_student_id = ? WHERE id = ?`)
      .run(studentId, guardianUserId);
    return { ok: true };
  }

  linkStudentUser(studentId: string, userId: string) {
    const u = this.db
      .prepare(`SELECT role FROM users WHERE id = ?`)
      .get(userId) as any;
    if (!u || u.role !== 'student')
      throw new BadRequestException('目标账号不是学生');
    this.db
      .prepare(`UPDATE students SET user_id = ? WHERE id = ?`)
      .run(userId, studentId);
    this.db
      .prepare(`UPDATE users SET linked_student_id = ? WHERE id = ?`)
      .run(studentId, userId);
    return { ok: true };
  }

  // ---------------- 原始健康材料(仅协调员) ----------------

  addSourceMaterial(
    user: AuthUser,
    studentId: string,
    dto: {
      kind: 'medical' | 'educational' | 'guardian_note' | 'student_preference';
      title: string;
      rawText: string;
    },
  ) {
    this.requireStudent(studentId);
    const id = uuid();
    this.db
      .prepare(
        `INSERT INTO source_materials
           (id, student_id, kind, title, raw_text, received_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        studentId,
        dto.kind,
        dto.title,
        dto.rawText,
        nowIso(),
        user.id,
        nowIso(),
      );
    return { id };
  }

  listSourceMaterials(studentId: string) {
    this.requireStudent(studentId);
    return this.db
      .prepare(
        `SELECT id, kind, title, raw_text, received_at, created_at
         FROM source_materials WHERE student_id = ? ORDER BY received_at`,
      )
      .all(studentId);
  }

  listPreferences(studentId: string) {
    this.requireStudent(studentId);
    return this.db
      .prepare(
        `SELECT id, text, visibility, created_at
         FROM student_preferences WHERE student_id = ? ORDER BY created_at`,
      )
      .all(studentId);
  }

  // ---------------- 授权 ----------------

  grantAuthorization(user: AuthUser, scope: string) {
    const id = uuid();
    this.db
      .prepare(
        `INSERT INTO authorizations (id, coordinator_id, scope, granted_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, user.id, scope, nowIso());
    return { id, scope };
  }

  revokeAuthorization(id: string) {
    const auth = this.db
      .prepare(`SELECT * FROM authorizations WHERE id = ?`)
      .get(id) as any;
    if (!auth) throw new NotFoundException('授权不存在');
    if (auth.revoked_at) return { ok: true, alreadyRevoked: true };
    this.db.tx(() => {
      this.db
        .prepare(
          `UPDATE authorizations SET revoked_at = ? WHERE id = ?`,
        )
        .run(nowIso(), id);
      this.logic.onAuthorizationRevoked(id);
    });
    return { ok: true };
  }

  private activeAuthorization(userId: string): any {
    const auth = this.db
      .prepare(
        `SELECT * FROM authorizations
         WHERE coordinator_id = ? AND revoked_at IS NULL
         ORDER BY granted_at DESC LIMIT 1`,
      )
      .get(userId) as any;
    if (!auth)
      throw new ForbiddenException(
        '当前没有有效授权,无法转化原始材料为措施',
      );
    return auth;
  }

  private chooseAuth(userId: string, authorizationId?: string) {
    if (!authorizationId) return this.activeAuthorization(userId);
    const auth = this.db
      .prepare(
        `SELECT * FROM authorizations WHERE id = ? AND coordinator_id = ?`,
      )
      .get(authorizationId, userId) as any;
    if (!auth)
      throw new BadRequestException('授权不存在或不属于当前协调员');
    if (auth.revoked_at)
      throw new BadRequestException('该授权已撤回,不能用于新措施');
    return auth;
  }

  // ---------------- 活动 ----------------

  createActivity(user: AuthUser, dto: {
    title: string;
    programCode?: string;
    contentSummary: string;
    allergens?: string[];
    startsAt: string;
    endsAt: string;
    studentIds?: string[];
    mentorIds?: string[];
  }) {
    if (Date.parse(dto.startsAt) >= Date.parse(dto.endsAt))
      throw new BadRequestException('时间区间无效');
    const id = uuid();
    const t = nowIso();
    this.db.tx(() => {
      this.db
        .prepare(
          `INSERT INTO activities
             (id, title, program_code, content_summary, content_hash, allergens,
              starts_at, ends_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          dto.title,
          dto.programCode ?? null,
          dto.contentSummary,
          contentHash(dto.contentSummary),
          JSON.stringify(dto.allergens ?? []),
          dto.startsAt,
          dto.endsAt,
          t,
          t,
        );
      this.setEnrollment(id, dto.studentIds ?? [], dto.mentorIds ?? []);
    });
    return { id };
  }

  setEnrollment(activityId: string, studentIds: string[], mentorIds: string[]) {
    this.db.prepare(`DELETE FROM activity_students WHERE activity_id = ?`).run(activityId);
    this.db.prepare(`DELETE FROM activity_mentors WHERE activity_id = ?`).run(activityId);
    const insS = this.db.prepare(
      `INSERT OR IGNORE INTO activity_students (activity_id, student_id) VALUES (?, ?)`,
    );
    const insM = this.db.prepare(
      `INSERT OR IGNORE INTO activity_mentors (activity_id, mentor_id) VALUES (?, ?)`,
    );
    for (const sid of studentIds) insS.run(activityId, sid);
    for (const mid of mentorIds) insM.run(activityId, mid);
  }

  /** 活动内容改变:内容哈希变化时自动登记重新评估并阻断旧摘要 */
  updateActivityContent(
    activityId: string,
    dto: { contentSummary?: string; allergens?: string[] },
  ) {
    const a = this.requireActivity(activityId);
    const newSummary = dto.contentSummary ?? a.content_summary;
    const newAllergens =
      dto.allergens ?? JSON.parse(a.allergens || '[]');
    const newHash = contentHash(newSummary);
    const changed =
      newHash !== a.content_hash ||
      JSON.stringify([...newAllergens].sort()) !==
        JSON.stringify([...JSON.parse(a.allergens || '[]')].sort());
    if (!changed) return { changed: false };

    this.db.tx(() => {
      this.db
        .prepare(
          `UPDATE activities SET content_summary = ?, content_hash = ?,
             allergens = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          newSummary,
          newHash,
          JSON.stringify(newAllergens),
          nowIso(),
          activityId,
        );
      this.logic.onContentChanged({ ...a, content_hash: newHash });
    });
    return { changed: true, contentHash: newHash };
  }

  listActivities() {
    return this.db
      .prepare(
        `SELECT id, title, program_code, starts_at, ends_at, updated_at
         FROM activities ORDER BY starts_at`,
      )
      .all();
  }

  getActivityView(activityId: string) {
    const a = this.requireActivity(activityId);
    return {
      ...a,
      students: this.db
        .prepare(
          `SELECT s.id, s.name FROM activity_students e
           JOIN students s ON s.id = e.student_id WHERE e.activity_id = ?`,
        )
        .all(activityId),
      mentors: this.db
        .prepare(
          `SELECT u.id, u.name FROM activity_mentors e
           JOIN users u ON u.id = e.mentor_id WHERE e.activity_id = ?`,
        )
        .all(activityId),
    };
  }

  // ---------------- 措施与版本 ----------------

  createMeasure(
    user: AuthUser,
    studentId: string,
    dto: {
      sourceMaterialId: string;
      type: MeasureType;
      scopes: ScopeDto[];
      instruction: string;
      constraints?: MeasureConstraints;
      reviewDate?: string;
      expiresAt?: string;
      consentScope: string;
      consentGrantId?: string;
      status?: VersionStatus;
      authorizationId?: string;
    },
  ) {
    this.requireStudent(studentId);
    const material = this.db
      .prepare(
        `SELECT * FROM source_materials WHERE id = ? AND student_id = ?`,
      )
      .get(dto.sourceMaterialId, studentId) as any;
    if (!material) throw new BadRequestException('原始材料不存在或不属于该学生');
    if (!dto.scopes?.length) throw new BadRequestException('至少设置一个适用场次');
    if (dto.consentGrantId) this.requireValidConsent(studentId, dto.consentGrantId);
    const auth = this.chooseAuth(user.id, dto.authorizationId);

    const measureId = uuid();
    this.db.tx(() => {
      this.db
        .prepare(
          `INSERT INTO measures (id, student_id, source_material_id, type, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(measureId, studentId, dto.sourceMaterialId, dto.type, user.id, nowIso());
      this.insertScopes(measureId, dto.scopes);
      this.insertVersion(user, {
        measureId,
        sourceRaw: material.raw_text,
        type: dto.type,
        instruction: dto.instruction,
        constraints: dto.constraints ?? {},
        reviewDate: dto.reviewDate ?? daysFromNow(90),
        expiresAt: dto.expiresAt,
        consentScope: dto.consentScope,
        consentGrantId: dto.consentGrantId ?? null,
        authorizationId: auth.id,
        status: dto.status ?? 'active',
      });
    });
    return { measureId };
  }

  reviseMeasure(
    user: AuthUser,
    measureId: string,
    dto: {
      instruction: string;
      constraints?: MeasureConstraints;
      reviewDate?: string;
      expiresAt?: string;
      consentScope: string;
      consentGrantId?: string;
      scopes?: ScopeDto[];
    },
  ) {
    const m = this.requireMeasure(measureId);
    if (dto.consentGrantId)
      this.requireValidConsent(m.student_id, dto.consentGrantId);
    const material = this.db
      .prepare(`SELECT raw_text FROM source_materials WHERE id = ?`)
      .get(m.source_material_id) as any;
    const auth = this.activeAuthorization(user.id);
    const prev = this.logic.latestVersion(measureId);

    return this.db.tx(() => {
      if (dto.scopes) {
        this.db.prepare(`DELETE FROM measure_scopes WHERE measure_id = ?`).run(measureId);
        this.insertScopes(measureId, dto.scopes);
      }
      const version = this.insertVersion(user, {
        measureId,
        sourceRaw: material.raw_text,
        type: m.type,
        instruction: dto.instruction,
        constraints: dto.constraints ?? JSON.parse(prev.constraints_json),
        reviewDate: dto.reviewDate ?? daysFromNow(90),
        expiresAt: dto.expiresAt,
        consentScope: dto.consentScope,
        consentGrantId: dto.consentGrantId ?? prev.consent_grant_id,
        authorizationId: auth.id,
        status: 'active',
      });
      this.logic.publishVersion({ measureId, newVersion: version });
      return { measureId, version };
    });
  }

  /** 协调员确认替代措施(如烘焙活动改用独立器具与替代点心) */
  confirmAlternative(
    user: AuthUser,
    measureId: string,
    dto: {
      instruction: string;
      constraints?: MeasureConstraints;
      reviewDate?: string;
      consentScope: string;
      consentGrantId?: string;
    },
  ) {
    const m = this.requireMeasure(measureId);
    if (dto.consentGrantId)
      this.requireValidConsent(m.student_id, dto.consentGrantId);
    const material = this.db
      .prepare(`SELECT raw_text FROM source_materials WHERE id = ?`)
      .get(m.source_material_id) as any;
    const auth = this.activeAuthorization(user.id);
    const prev = this.logic.latestVersion(measureId);

    return this.db.tx(() => {
      const version = this.insertVersion(user, {
        measureId,
        sourceRaw: material.raw_text,
        type: m.type,
        instruction: dto.instruction,
        constraints: dto.constraints ?? JSON.parse(prev.constraints_json),
        reviewDate: dto.reviewDate ?? daysFromNow(90),
        expiresAt: null,
        consentScope: dto.consentScope,
        consentGrantId: dto.consentGrantId ?? prev.consent_grant_id,
        authorizationId: auth.id,
        status: 'confirmed_alternative',
      });
      this.logic.publishVersion({ measureId, newVersion: version });
      // 该措施相关的待处理冲突随替代确认关闭
      this.db
        .prepare(
          `UPDATE conflicts SET status = 'resolved', resolved_by = ?, resolved_at = ?,
             resolution_note = '已确认替代措施 v' || ?
           WHERE measure_id_a = ? AND status = 'pending'`,
        )
        .run(user.id, nowIso(), version, measureId);
      return { measureId, version, status: 'confirmed_alternative' };
    });
  }

  listVersions(measureId: string) {
    this.requireMeasure(measureId);
    return this.db
      .prepare(
        `SELECT measure_id, version, status, instruction, constraints_json,
                review_date, expires_at, consent_scope, consent_grant_id,
                authorization_id, based_on_hash, created_by, created_at,
                decided_by, decided_at, revoke_reason
         FROM measure_versions WHERE measure_id = ? ORDER BY version`,
      )
      .all(measureId);
  }

  private insertVersion(
    user: AuthUser,
    v: {
      measureId: string;
      sourceRaw: string;
      type: string;
      instruction: string;
      constraints: MeasureConstraints;
      reviewDate: string;
      expiresAt?: string | null;
      consentScope: string;
      consentGrantId: string | null;
      authorizationId: string;
      status: VersionStatus;
    },
  ): number {
    const prev = this.logic.latestVersion(v.measureId);
    const prevHash = prev
      ? prev.based_on_hash
      : sha256('source:' + v.sourceRaw);
    const version = prev ? prev.version + 1 : 1;
    const hash = this.logic.computeVersionHash({
      instruction: v.instruction,
      constraints: v.constraints,
      reviewDate: v.reviewDate,
      consentScope: v.consentScope,
      prevHash,
      sourceMaterialId: v.measureId,
    });
    this.db
      .prepare(
        `INSERT INTO measure_versions
           (measure_id, version, status, instruction, constraints_json,
            review_date, expires_at, consent_scope, consent_grant_id,
            authorization_id, based_on_hash, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.measureId,
        version,
        v.status,
        v.instruction,
        JSON.stringify(v.constraints),
        v.reviewDate,
        v.expiresAt ?? null,
        v.consentScope,
        v.consentGrantId,
        v.authorizationId,
        hash,
        user.id,
        nowIso(),
      );
    return version;
  }

  private insertScopes(measureId: string, scopes: ScopeDto[]) {
    const stmt = this.db.prepare(
      `INSERT INTO measure_scopes (id, measure_id, scope_type, activity_id, program_code)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const s of scopes) {
      if (s.scopeType === 'activity' && !s.activityId)
        throw new BadRequestException('场次范围缺少 activityId');
      if (s.scopeType === 'program' && !s.programCode)
        throw new BadRequestException('项目范围缺少 programCode');
      stmt.run(
        uuid(),
        measureId,
        s.scopeType,
        s.scopeType === 'activity' ? s.activityId! : null,
        s.scopeType === 'program' ? s.programCode! : null,
      );
    }
  }

  // ---------------- 重新评估 / 冲突 ----------------

  listReassessments(status?: string) {
    if (status)
      return this.db
        .prepare(
          `SELECT r.*, s.name AS student_name
           FROM reassessments r JOIN students s ON s.id = r.student_id
           WHERE r.status = ? ORDER BY r.created_at DESC`,
        )
        .all(status);
    return this.db
      .prepare(
        `SELECT r.*, s.name AS student_name
         FROM reassessments r JOIN students s ON s.id = r.student_id
         ORDER BY r.created_at DESC`,
      )
      .all();
  }

  resolveReassessment(id: string) {
    const r = this.db
      .prepare(`SELECT * FROM reassessments WHERE id = ?`)
      .get(id) as any;
    if (!r) throw new NotFoundException('重新评估单不存在');
    this.db
      .prepare(
        `UPDATE reassessments SET status = 'resolved', resolved_at = ? WHERE id = ?`,
      )
      .run(nowIso(), id);
    return { ok: true };
  }

  listConflicts(activityId?: string) {
    if (activityId)
      return this.db
        .prepare(`SELECT * FROM conflicts WHERE activity_id = ? ORDER BY created_at`)
        .all(activityId);
    return this.db
      .prepare(`SELECT * FROM conflicts ORDER BY created_at`)
      .all();
  }

  resolveConflict(user: AuthUser, id: string, note: string) {
    const c = this.db
      .prepare(`SELECT * FROM conflicts WHERE id = ?`)
      .get(id) as any;
    if (!c) throw new NotFoundException('冲突不存在');
    this.db
      .prepare(
        `UPDATE conflicts SET status = 'resolved', resolved_by = ?, resolved_at = ?,
           resolution_note = ? WHERE id = ?`,
      )
      .run(user.id, nowIso(), note, id);
    return { ok: true };
  }

  // ---------------- 活动准备 ----------------

  /**
   * 一次活动准备:固化快照,返回
   * 已满足措施 / 待确认冲突 / 导师阅读回执 / 所引用版本。
   */
  prepareActivity(user: AuthUser, activityId: string) {
    const activity = this.requireActivity(activityId);
    return this.db.tx(() => {
      // 先跑过期/复核巡检,使判断基于最新资格状态
      this.logic.sweep(activityId);

      const applicable = this.logic.applicableToActivity(activity);
      const satisfied = applicable.filter((m) => m.distributable);
      const blocked = applicable
        .filter((m) => !m.distributable)
        .map((m) => ({
          measureId: m.measureId,
          studentId: m.studentId,
          studentName: m.studentName,
          type: m.type,
          version: m.version,
          status: m.status,
          blockReasons: m.blockReasons,
        }));

      // 当场冲突检测并落库
      const detected = this.logic.detectInActivityConflicts(activity);
      this.logic.recordConflicts(activityId, detected);
      const pendingConflicts = this.db
        .prepare(`SELECT * FROM conflicts WHERE activity_id = ? AND status = 'pending'`)
        .all(activityId);

      const mentors = this.db
        .prepare(
          `SELECT u.id, u.name FROM activity_mentors m
           JOIN users u ON u.id = m.mentor_id WHERE m.activity_id = ?`,
        )
        .all(activityId) as any[];

      // 为每位导师生成/同步当场必须执行的简报(只含可分发、非诊断文本)
      const upsert = this.db.prepare(
        `INSERT INTO mentor_briefings
           (id, prep_id, activity_id, mentor_id, student_id, measure_id,
            version, instruction_snapshot, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (activity_id, mentor_id, measure_id, version) DO NOTHING`,
      );
      for (const mentor of mentors) {
        for (const m of satisfied) {
          upsert.run(
            uuid(),
            activityId,
            mentor.id,
            m.studentId,
            m.measureId,
            m.version,
            m.instruction,
            nowIso(),
          );
        }
      }

      // 资格已丧失但仍未阻断的简报立即阻断
      const blockStmt = this.db.prepare(
        `UPDATE mentor_briefings SET blocked_at = ?, block_reason = ?
         WHERE id = ? AND blocked_at IS NULL`,
      );
      for (const m of blocked) {
        const rows = this.db
          .prepare(
            `SELECT id FROM mentor_briefings
             WHERE activity_id = ? AND measure_id = ? AND blocked_at IS NULL`,
          )
          .all(activityId, m.measureId) as any[];
        for (const r of rows)
          blockStmt.run(nowIso(), m.blockReasons[0] ?? 'ineligible', r.id);
      }

      // 导师阅读回执
      const receipts = this.db
        .prepare(
          `SELECT b.mentor_id, u.name AS mentor_name, b.measure_id,
                  b.student_id, b.version, b.created_at, b.read_at,
                  b.blocked_at, b.block_reason
           FROM mentor_briefings b JOIN users u ON u.id = b.mentor_id
           WHERE b.activity_id = ?
           ORDER BY u.name, b.measure_id`,
        )
        .all(activityId);

      // 所引用版本(含哈希链锚点,可核验简报依据)
      const citedVersions = satisfied.map((m) => ({
        measureId: m.measureId,
        studentId: m.studentId,
        type: m.type,
        version: m.version,
        status: m.status,
        basedOnHash: m.basedOnHash,
        reviewDate: m.reviewDate,
        expiresAt: m.expiresAt,
      }));

      const snapshot = JSON.stringify({
        activityId,
        at: nowIso(),
        satisfied: satisfied.map((m) => ({
          measureId: m.measureId,
          studentId: m.studentId,
          type: m.type,
          version: m.version,
          instruction: m.instruction,
          constraints: m.constraints,
          basedOnHash: m.basedOnHash,
        })),
        blocked,
        pendingConflictCount: pendingConflicts.length,
      });
      const prepId = uuid();
      this.db
        .prepare(
          `INSERT INTO preps (id, activity_id, created_by, created_at, snapshot)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(prepId, activityId, user.id, nowIso(), snapshot);
      this.db
        .prepare(`UPDATE mentor_briefings SET prep_id = ? WHERE activity_id = ? AND prep_id IS NULL`)
        .run(prepId, activityId);

      return {
        prepId,
        activityId,
        at: nowIso(),
        satisfied: satisfied.map((m) => ({
          measureId: m.measureId,
          studentId: m.studentId,
          studentName: m.studentName,
          type: m.type,
          version: m.version,
          instruction: m.instruction,
          constraints: m.constraints,
        })),
        blocked,
        pendingConflicts,
        receipts,
        citedVersions,
      };
    });
  }

  crossActivityOverlaps() {
    return this.logic.crossActivityOverlaps();
  }

  // ---------------- helpers ----------------

  private requireStudent(studentId: string) {
    const s = this.db
      .prepare(`SELECT * FROM students WHERE id = ?`)
      .get(studentId) as any;
    if (!s) throw new NotFoundException('学生不存在');
    return s;
  }

  private requireActivity(activityId: string) {
    const a = this.db
      .prepare(`SELECT * FROM activities WHERE id = ?`)
      .get(activityId) as any;
    if (!a) throw new NotFoundException('活动不存在');
    return a;
  }

  private requireMeasure(measureId: string) {
    const m = this.db
      .prepare(`SELECT * FROM measures WHERE id = ?`)
      .get(measureId) as any;
    if (!m) throw new NotFoundException('措施不存在');
    return m;
  }

  private requireValidConsent(studentId: string, grantId: string) {
    const g = this.db
      .prepare(
        `SELECT * FROM consent_grants WHERE id = ? AND student_id = ?`,
      )
      .get(grantId, studentId) as any;
    if (!g) throw new BadRequestException('同意记录不存在或不属于该学生');
    if (g.revoked_at)
      throw new BadRequestException('该同意范围已被监护人撤回');
  }
}
