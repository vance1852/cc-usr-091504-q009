import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { ALL_MEASURE_TYPES, MeasureType, Role } from '../common/enums';

export interface ConsentVersion {
  id: string;
  student_id: string;
  version_no: number;
  allowed_types: string;
  note: string | null;
  created_by: string;
  created_at: string;
}

/**
 * 集中访问策略：账号-档案绑定、转化授权、监护人同意。
 * 分发简报与措施写入都必须经过这里判定。
 */
@Injectable()
export class AccessPolicyService {
  constructor(private readonly db: DatabaseService) {}

  isStudentLinked(userId: string, studentId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 AS hit FROM user_student_links WHERE user_id = ? AND student_id = ?',
        )
        .get(userId, studentId),
    );
  }

  /** 是否持有把某学生某类原始材料转化为措施的有效授权（任一未撤回授权覆盖即可） */
  hasActiveGrant(
    studentId: string,
    granteeId: string,
    type: MeasureType,
  ): boolean {
    const grants = this.db
      .prepare(
        `SELECT scope FROM grants
          WHERE student_id = ? AND grantee_id = ? AND revoked_at IS NULL`,
      )
      .all(studentId, granteeId) as { scope: string }[];
    return grants.some(
      (g) => g.scope === 'ALL' || g.scope.split(',').includes(type),
    );
  }

  currentConsent(studentId: string): ConsentVersion | undefined {
    return this.db
      .prepare(
        `SELECT * FROM consent_versions
          WHERE student_id = ?
          ORDER BY version_no DESC LIMIT 1`,
      )
      .get(studentId) as ConsentVersion | undefined;
  }

  consentAt(studentId: string, atIso: string): ConsentVersion | undefined {
    return this.db
      .prepare(
        `SELECT * FROM consent_versions
          WHERE student_id = ? AND created_at <= ?
          ORDER BY version_no DESC LIMIT 1`,
      )
      .get(studentId, atIso) as ConsentVersion | undefined;
  }

  consentAllows(studentId: string, type: MeasureType): boolean {
    const consent = this.currentConsent(studentId);
    if (!consent) return false;
    return fromCsvSafe(consent.allowed_types).includes(type);
  }

  requireStudent(studentId: string): void {
    const hit = this.db
      .prepare('SELECT 1 AS hit FROM students WHERE id = ?')
      .get(studentId);
    if (!hit) throw new NotFoundException('学生不存在');
  }

  /** 监护人/学生账号只能访问本人绑定档案；协调员/导师不受此限 */
  assertFamilyAccess(userId: string, role: Role, studentId: string): void {
    if (role === Role.GUARDIAN || role === Role.STUDENT) {
      if (!this.isStudentLinked(userId, studentId)) {
        throw new NotFoundException('学生不存在');
      }
    }
  }
}

function fromCsvSafe(value: string | null | undefined): string[] {
  return value ? value.split(',') : [];
}

export const ALL_TYPES_CSV = ALL_MEASURE_TYPES.join(',');
