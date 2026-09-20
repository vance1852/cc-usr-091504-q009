import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import * as path from 'path';
import * as fs from 'fs';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/db/database.service';
import { hashPassword } from '../src/auth/password';
import { id, now } from '../src/common/util';
import { Role } from '../src/common/enums';

const DB_FILE = path.join(__dirname, `tmp-test-${process.pid}.sqlite`);
process.env.SUPPORT_DB_FILE = DB_FILE;
process.env.JWT_SECRET = 'test-secret';

export interface World {
  app: INestApplication;
  http: any;
  tokens: Record<string, string>;
  ids: Record<string, string>;
}

/** 启动应用并直接写入引导数据：协调员账号 + 对该学生的初始授权 */
export async function buildWorld(): Promise<World> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  await app.init();

  const db = app.get(DatabaseService);
  const ts = now();

  const insertUser = (
    login: string,
    name: string,
    role: Role,
  ): string => {
    const userId = id('usr');
    db.prepare(
      `INSERT INTO users (id, login, password_hash, name, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, login, hashPassword('pw123456'), name, role, ts);
    return userId;
  };

  const coordId = insertUser('coord', '协调员', Role.COORDINATOR);
  insertUser('coord2', '无授权协调员', Role.COORDINATOR);
  insertUser('sci', '科学课导师', Role.INSTRUCTOR);
  insertUser('bake', '烘焙导师', Role.INSTRUCTOR);
  const guardianId = insertUser('guard', '家长', Role.GUARDIAN);
  const pupilId = insertUser('pupil', '学生本人', Role.STUDENT);

  const studentId = id('stu');
  db.prepare('INSERT INTO students (id, name, created_at) VALUES (?, ?, ?)').run(
    studentId,
    '小明',
    ts,
  );
  db.prepare(
    'INSERT INTO user_student_links (user_id, student_id) VALUES (?, ?)',
  ).run(guardianId, studentId);
  db.prepare(
    'INSERT INTO user_student_links (user_id, student_id) VALUES (?, ?)',
  ).run(pupilId, studentId);

  // 协调员的初始转化授权（全部类型）
  db.prepare(
    `INSERT INTO grants (id, student_id, grantee_id, scope, granted_by, granted_at)
     VALUES (?, ?, ?, 'ALL', ?, ?)`,
  ).run(id('grn'), studentId, coordId, coordId, ts);

  const tokens: Record<string, string> = {};
  const http = app.getHttpServer();
  for (const login of ['coord', 'coord2', 'sci', 'bake', 'guard', 'pupil']) {
    const res = await request(http)
      .post('/auth/login')
      .send({ login, password: 'pw123456' });
    tokens[login] = res.body.token;
  }

  return {
    app,
    http,
    tokens,
    ids: { coordId, guardianId, pupilId, studentId },
  };
}

export async function destroyWorld(w: World) {
  await w.app.close();
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
}
