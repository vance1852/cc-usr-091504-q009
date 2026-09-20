import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../db/db.service';
import { AuthUser, nowIso, uuid } from '../common/domain';

@Injectable()
export class MentorService {
  constructor(private readonly db: DbService) {}

  /**
   * 导师视角:只返回当场必须执行、未被阻断的措施。
   * 明确不返回任何诊断性原文、材料标题或授权细节。
   */
  listBriefings(user: AuthUser, activityId?: string) {
    const rows = this.db
      .prepare(
        `SELECT b.id, b.activity_id, a.title AS activity_title,
                b.student_id, s.name AS student_name,
                b.measure_id, m.type, b.version,
                b.instruction_snapshot, b.created_at, b.read_at,
                b.blocked_at, b.block_reason
         FROM mentor_briefings b
         JOIN activities a ON a.id = b.activity_id
         JOIN students s ON s.id = b.student_id
         JOIN measures m ON m.id = b.measure_id
         WHERE b.mentor_id = ?
           AND (? IS NULL OR b.activity_id = ?)
         ORDER BY a.starts_at, s.name, m.type`,
      )
      .all(user.id, activityId ?? null, activityId ?? null) as any[];

    return rows.map((r) => ({
      id: r.id,
      activityId: r.activity_id,
      activityTitle: r.activity_title,
      studentName: r.student_name,
      type: r.type,
      version: r.version,
      instruction: r.instruction_snapshot,
      createdAt: r.created_at,
      readAt: r.read_at,
      // 被阻断的旧摘要仍对导师可见其"已失效"状态,但不可执行
      blocked: !!r.blocked_at,
      blockReason: r.block_reason ?? null,
    }));
  }

  private ownBriefing(user: AuthUser, id: string) {
    const b = this.db
      .prepare(`SELECT * FROM mentor_briefings WHERE id = ? AND mentor_id = ?`)
      .get(id, user.id) as any;
    if (!b) throw new NotFoundException('简报不存在');
    return b;
  }

  markRead(user: AuthUser, id: string) {
    const b = this.ownBriefing(user, id);
    if (!b.read_at) {
      this.db
        .prepare(`UPDATE mentor_briefings SET read_at = ? WHERE id = ?`)
        .run(nowIso(), id);
    }
    return { ok: true, readAt: nowIso() };
  }

  /** 执行记录固化当时依据;即使简报之后被阻断/版本作废,记录仍保留 */
  execute(user: AuthUser, id: string, note: string | undefined) {
    const b = this.ownBriefing(user, id);
    if (b.blocked_at)
      throw new ForbiddenException(
        '该措施摘要已失效(授权撤回/同意调整/内容变更),不可按旧版本执行',
      );
    const execId = uuid();
    this.db
      .prepare(
        `INSERT INTO executions
           (id, briefing_id, mentor_id, measure_id, version,
            instruction_snapshot, note, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execId,
        b.id,
        user.id,
        b.measure_id,
        b.version,
        b.instruction_snapshot,
        note ?? null,
        nowIso(),
      );
    if (!b.read_at) {
      this.db
        .prepare(`UPDATE mentor_briefings SET read_at = ? WHERE id = ?`)
        .run(nowIso(), id);
    }
    return {
      id: execId,
      measureId: b.measure_id,
      version: b.version,
      instructionSnapshot: b.instruction_snapshot,
      executedAt: nowIso(),
    };
  }

  listMyExecutions(user: AuthUser) {
    return this.db
      .prepare(
        `SELECT id, measure_id, version, instruction_snapshot, note, executed_at
         FROM executions WHERE mentor_id = ? ORDER BY executed_at DESC`,
      )
      .all(user.id);
  }
}
