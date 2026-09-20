import { Injectable, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import { SCHEMA } from './schema';

@Injectable()
export class DatabaseService implements OnModuleInit {
  private db!: Database.Database;

  onModuleInit() {
    const file = process.env.SUPPORT_DB_FILE || 'data.sqlite';
    this.db = new Database(file);
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  get raw(): Database.Database {
    return this.db;
  }

  prepare<T extends unknown[] = unknown[]>(sql: string) {
    return this.db.prepare(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
