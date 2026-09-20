import {
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { DbService } from '../db/db.service';
import { AuthUser, nowIso, uuid } from '../common/domain';

@Injectable()
export class StudentService {
  constructor(private readonly db: DbService) {}

  /**
   * 学生表达"不愿公开"的偏好。默认 restricted:
   * 仅协调员可见,导师端、其他学生均不可见,也不会进入简报。
   */
  addPreference(user: AuthUser, text: string) {
    const studentId = user.linkedStudentId;
    if (!studentId)
      throw new ForbiddenException('该学生账号尚未关联学生档案');
    const id = uuid();
    this.db
      .prepare(
        `INSERT INTO student_preferences (id, student_id, text, visibility, created_at)
         VALUES (?, ?, ?, 'restricted', ?)`,
      )
      .run(id, studentId, text, nowIso());
    return { id, visibility: 'restricted' };
  }

  listMyPreferences(user: AuthUser) {
    const studentId = user.linkedStudentId;
    if (!studentId) return [];
    return this.db
      .prepare(
        `SELECT id, text, visibility, created_at
         FROM student_preferences WHERE student_id = ? ORDER BY created_at`,
      )
      .all(studentId);
  }
}
