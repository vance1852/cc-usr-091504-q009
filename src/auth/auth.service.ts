import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DbService } from '../db/db.service';
import { AuthUser, Role, uuid, nowIso } from '../common/domain';

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
  ) {}

  async register(input: {
    email: string;
    password: string;
    name: string;
    role: Role;
  }): Promise<{ id: string }> {
    const id = uuid();
    const hash = bcrypt.hashSync(input.password, 10);
    try {
      this.db
        .prepare(
          `INSERT INTO users (id, email, password_hash, name, role)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, input.email, hash, input.name, input.role);
    } catch (e) {
      throw new UnauthorizedException('email already registered');
    }
    return { id };
  }

  async login(email: string, password: string): Promise<{ token: string }> {
    const row = this.db
      .prepare(
        `SELECT id, email, password_hash, name, role, linked_student_id
         FROM users WHERE email = ? AND active = 1`,
      )
      .get(email) as
      | {
          id: string;
          email: string;
          password_hash: string;
          name: string;
          role: Role;
          linked_student_id: string | null;
        }
      | undefined;
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      throw new UnauthorizedException('invalid credentials');
    }
    const user: AuthUser = {
      id: row.id,
      role: row.role,
      linkedStudentId: row.linked_student_id,
      email: row.email,
      name: row.name,
    };
    return { token: await this.jwt.signAsync(user) };
  }
}
