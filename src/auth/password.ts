import { scryptSync, randomBytes } from 'crypto';

/** 演示用单向口令哈希（scrypt + 随机盐） */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32).toString('hex');
  return candidate === hash;
}
