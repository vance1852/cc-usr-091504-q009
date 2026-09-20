import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { AccessPolicyService } from '../access/access-policy.service';
import { MeasureType, Role } from '../common/enums';
import { id, now, today } from '../common/util';

export interface MeasureVersionData {
  instruction: string;
  reviewDate: string;
  target: 'ALL' | 'SESSIONS';
  sessionIds?: string[];
  visibility: 'ALL_INSTRUCTORS' | 'INSTRUCTORS';
  instructorIds?: string[];
  sourceMaterialIds?: string[];
}

interface MeasureRow {
  id: string;
  student_id: string;
  current_version_id: string | null;
  retired_at: string | null;
}

@Injectable()
export class MeasuresService {
  constructor(
    private readonly db: DatabaseService,
    private readonly policy: AccessPolicyService,
  ) {}

  /**
   * 协调员把原始材料转化为可执行措施。
   * 必须持有该学生、该类型的有效转化授权，且措施语言中不引用诊断原文。
   */
  create(
    user: { id: string; role: Role },
    studentId: string,
    type: MeasureType,
    data: MeasureVersionData,
  ) {
    this.policy.requireStudent(studentId);
    if (!this.policy.hasActiveGrant(studentId, user.id, type)) {
      throw new ForbiddenException('缺少该学生此类型措施的有效授权');
    }
    this.validateData(studentId, data);

    return this.db.transaction(() => {
      const measureId = id('msr');
      this.db
        .prepare(
          `INSERT INTO measures (id, student_id, current_version_id, retired_at)
           VALUES (?, ?, NULL, NULL)`,
        )
        .run(measureId, studentId);
      const versionId = this.insertVersion(measureId, studentId, type, 1, data, user.id);
      this.db.prepare('UPDATE measures SET current_version_id = ? WHERE id = ?').run(
        versionId,
        measureId,
      );
      return this.getDetail(measureId);
    });
  }

  /** 产生新版本：保留历史，分发立即切到新版本 */
  newVersion(
    user: { id: string; role: Role },
    measureId: string,
    data: MeasureVersionData,
  ) {
    const measure = this.requireMeasure(measureId);
    if (measure.retired_at) throw new BadRequestException('措施已停用，不能再修订');
    const current = this.requireCurrentVersion(measure);
    if (!this.policy.hasActiveGrant(measure.student_id, user.id, current.type as MeasureType)) {
      throw new ForbiddenException('缺少该学生此类型措施的有效授权');
    }
    this.validateData(measure.student_id, data);

    return this.db.transaction(() => {
      const nextNo = current.version_no + 1;
      const versionId = this.insertVersion(
        measureId,
        measure.student_id,
        current.type as MeasureType,
        nextNo,
        data,
        user.id,
      );
      this.db.prepare('UPDATE measures SET current_version_id = ? WHERE id = ?').run(
        versionId,
        measureId,
      );
      return this.getDetail(measureId);
    });
  }

  retire(user: { id: string }, measureId: string) {
    const measure = this.requireMeasure(measureId);
    const ts = now();
    this.db
      .prepare('UPDATE measures SET retired_at = COALESCE(retired_at, ?) WHERE id = ?')
      .run(ts, measureId);
    return { id: measureId, retiredAt: measure.retired_at ?? ts };
  }

  list(studentId: string) {
    const rows = this.db
      .prepare(
        `SELECT m.id AS measure_id, m.retired_at,
                mv.id AS version_id, mv.version_no, mv.type, mv.instruction,
                mv.review_date, mv.target_kind, mv.visibility_kind,
                mv.created_by, mv.created_at
           FROM measures m
           JOIN measure_versions mv ON mv.id = m.current_version_id
          WHERE m.student_id = ?
          ORDER BY mv.type, mv.created_at`,
      )
      .all(studentId);
    return (rows as Record<string, unknown>[]).map((r) => this.shapeVersion(r));
  }

  /** 单个措施的完整版本历史（含引用材料元数据，不含原文） */
  getDetail(measureId: string) {
    const measure = this.db
      .prepare('SELECT * FROM measures WHERE id = ?')
      .get(measureId) as MeasureRow | undefined;
    if (!measure) throw new BadRequestException('措施不存在');

    const versions = this.db
      .prepare(
        `SELECT * FROM measure_versions WHERE measure_id = ? ORDER BY version_no`,
      )
      .all(measureId) as Record<string, unknown>[];

    return {
      id: measure.id,
      studentId: measure.student_id,
      retiredAt: measure.retired_at,
      currentVersionId: measure.current_version_id,
      versions: versions.map((v) => ({
        ...this.shapeVersion(v),
        sources: this.sources(v.id as string),
        sessions: this.sessionLinks(v.id as string),
        visibleInstructors: this.visibilityLinks(v.id as string),
      })),
    };
  }

  getCurrentVersion(measureId: string) {
    const measure = this.requireMeasure(measureId);
    return this.requireCurrentVersion(measure);
  }

  // ---------- 内部 ----------

  private validateData(studentId: string, data: MeasureVersionData) {
    if (!data.instruction?.trim()) {
      throw new BadRequestException('措施必须给出可执行的操作说明');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.reviewDate)) {
      throw new BadRequestException('复核日期格式应为 YYYY-MM-DD');
    }
    if (data.reviewDate < today()) {
      throw new BadRequestException('复核日期不能早于今天');
    }
    if (data.target === 'SESSIONS') {
      if (!data.sessionIds?.length) {
        throw new BadRequestException('适用场次为 SESSIONS 时必须提供 sessionIds');
      }
      for (const sessionId of data.sessionIds) {
        const hit = this.db
          .prepare('SELECT 1 AS hit FROM sessions WHERE id = ?')
          .get(sessionId);
        if (!hit) throw new BadRequestException(`场次不存在: ${sessionId}`);
      }
    }
    if (data.visibility === 'INSTRUCTORS') {
      if (!data.instructorIds?.length) {
        throw new BadRequestException(
          '可见范围为 INSTRUCTORS 时必须提供 instructorIds',
        );
      }
      for (const userId of data.instructorIds) {
        const u = this.db
          .prepare("SELECT role FROM users WHERE id = ?")
          .get(userId) as { role: string } | undefined;
        if (!u) throw new BadRequestException(`导师不存在: ${userId}`);
        if (u.role !== Role.INSTRUCTOR) {
          throw new BadRequestException(`可见名单中 ${userId} 不是导师`);
        }
      }
    }
    for (const materialId of data.sourceMaterialIds ?? []) {
      const m = this.db
        .prepare('SELECT student_id FROM raw_materials WHERE id = ?')
        .get(materialId) as { student_id: string } | undefined;
      if (!m) throw new BadRequestException(`原始材料不存在: ${materialId}`);
      if (m.student_id !== studentId) {
        throw new BadRequestException('只能引用该学生本人的原始材料');
      }
    }
  }

  private insertVersion(
    measureId: string,
    studentId: string,
    type: MeasureType,
    versionNo: number,
    data: MeasureVersionData,
    userId: string,
  ): string {
    const versionId = id('mv_');
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO measure_versions
           (id, measure_id, version_no, student_id, type, instruction,
            review_date, target_kind, visibility_kind, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        measureId,
        versionNo,
        studentId,
        type,
        data.instruction.trim(),
        data.reviewDate,
        data.target,
        data.visibility,
        userId,
        ts,
      );
    for (const sessionId of data.target === 'SESSIONS' ? data.sessionIds ?? [] : []) {
      this.db
        .prepare(
          'INSERT INTO measure_version_sessions (version_id, session_id) VALUES (?, ?)',
        )
        .run(versionId, sessionId);
    }
    for (const userId2 of data.visibility === 'INSTRUCTORS'
      ? data.instructorIds ?? []
      : []) {
      this.db
        .prepare(
          'INSERT INTO measure_version_visibility (version_id, user_id) VALUES (?, ?)',
        )
        .run(versionId, userId2);
    }
    for (const materialId of data.sourceMaterialIds ?? []) {
      this.db
      .prepare(
        'INSERT INTO measure_version_sources (version_id, material_id) VALUES (?, ?)',
      )
      .run(versionId, materialId);
    }
    return versionId;
  }

  private shapeVersion(v: Record<string, unknown>) {
    return {
      measureId: v.measure_id,
      versionId: v.version_id ?? v.id,
      versionNo: v.version_no,
      type: v.type,
      instruction: v.instruction,
      reviewDate: v.review_date,
      target: v.target_kind,
      visibility: v.visibility_kind,
      createdBy: v.created_by,
      createdAt: v.created_at,
    };
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

  private sessionLinks(versionId: string) {
    return this.db
      .prepare(
        `SELECT s.id, s.name, s.start_at
           FROM measure_version_sessions ms
           JOIN sessions s ON s.id = ms.session_id
          WHERE ms.version_id = ? ORDER BY s.start_at`,
      )
      .all(versionId);
  }

  private visibilityLinks(versionId: string) {
    return this.db
      .prepare(
        `SELECT u.id, u.name
           FROM measure_version_visibility mv
           JOIN users u ON u.id = mv.user_id
          WHERE mv.version_id = ? ORDER BY u.name`,
      )
      .all(versionId);
  }

  private requireMeasure(measureId: string) {
    const measure = this.db
      .prepare('SELECT * FROM measures WHERE id = ?')
      .get(measureId) as MeasureRow | undefined;
    if (!measure) throw new BadRequestException('措施不存在');
    return measure;
  }

  private requireCurrentVersion(measure: MeasureRow) {
    if (!measure.current_version_id) {
      throw new BadRequestException('措施没有可用版本');
    }
    return this.db
      .prepare('SELECT * FROM measure_versions WHERE id = ?')
      .get(measure.current_version_id) as {
      id: string;
      measure_id: string;
      version_no: number;
      student_id: string;
      type: MeasureType;
      instruction: string;
      review_date: string;
      target_kind: 'ALL' | 'SESSIONS';
      visibility_kind: 'ALL_INSTRUCTORS' | 'INSTRUCTORS';
      created_by: string;
      created_at: string;
    };
  }
}
