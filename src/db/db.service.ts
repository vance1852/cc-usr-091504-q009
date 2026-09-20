import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

@Injectable()
export class DbService implements OnModuleInit {
  private db: DatabaseSync;

  onModuleInit() {
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data.sqlite');
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    const schemaPath = fs.existsSync(path.join(__dirname, 'schema.sql'))
      ? path.join(__dirname, 'schema.sql')
      : path.join(process.cwd(), 'src', 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    this.db.exec(schema);
  }

  get raw(): DatabaseSync {
    return this.db;
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  exec(sql: string) {
    return this.db.exec(sql);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
