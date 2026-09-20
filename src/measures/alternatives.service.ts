import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { AccessPolicyService } from '../access/access-policy.service';
import { AlternativeStatus, MeasureType, Role } from '../common/enums';
import { id, now } from '../common/util';

interface AlternativeInput {
  instruction: string;
  type: MeasureType;
  note?: string;
}

@Injectable()
export class AlternativesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly policy: AccessPolicyService,
  ) {}

  /** 导师在当场无法执行原措施时提出替代措施，等待协调员确认 */
  propose(
    user: { id: string; role: Role },
    measureId: string,
    input: AlternativeInput,
  ) {
    const measure = this.db
      .prepare('SELECT * FROM measures WHERE id = ?')
      .get(measureId) as
      | { id: string; student_id: string; retired_at: string | null }
      | undefined;
    if (!measure) throw new BadRequestException('措施不存在');
    if (user.role !== Role.INSTRUCTOR && user.role !== Role.COORDINATOR) {
      throw new ForbiddenException('只有导师或协调员可以提出替代措施');
    }
    if (!input.instruction?.trim()) {
      throw new BadRequestException('替代措施必须说明做法');
    }
    const altId = id('alt');
    this.db
      .prepare(
        `INSERT INTO alternatives
           (id, measure_id, student_id, type, instruction, status,
            proposed_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'PROPOSED', ?, ?)`,
      )
      .run(
        altId,
        measureId,
        measure.student_id,
        input.type,
        input.instruction.trim(),
        user.id,
        now(),
      );
    return { id: altId, status: AlternativeStatus.PROPOSED };
  }

  /** 协调员确认或拒绝替代措施 */
  review(
    user: { id: string },
    altId: string,
    status: AlternativeStatus.CONFIRMED | AlternativeStatus.REJECTED,
    note?: string,
  ) {
    const alt = this.db
      .prepare('SELECT * FROM alternatives WHERE id = ?')
      .get(altId) as
      | { status: AlternativeStatus; measure_id: string }
      | undefined;
    if (!alt) throw new BadRequestException('替代措施不存在');
    if (alt.status !== AlternativeStatus.PROPOSED) {
      throw new BadRequestException('该替代措施已处理');
    }
    this.db
      .prepare(
        `UPDATE alternatives
            SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?
          WHERE id = ?`,
      )
      .run(status, user.id, now(), note ?? null, altId);
    return { id: altId, status };
  }

  listForMeasure(measureId: string) {
    return this.db
      .prepare(
        `SELECT a.id, a.measure_id, a.type, a.instruction, a.status,
                a.proposed_by, a.created_at, a.reviewed_by, a.reviewed_at,
                a.review_note
           FROM alternatives a WHERE a.measure_id = ? ORDER BY a.created_at`,
      )
      .all(measureId);
  }

  /** 某学生当场已确认的替代措施（简报可据此提示） */
  confirmedForStudent(studentId: string): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT * FROM alternatives
          WHERE student_id = ? AND status = 'CONFIRMED'
          ORDER BY reviewed_at DESC`,
      )
      .all(studentId) as Record<string, unknown>[];
  }
}
