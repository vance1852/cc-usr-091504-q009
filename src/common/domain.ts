export type Role = 'coordinator' | 'mentor' | 'guardian' | 'student';
export type MeasureType = 'seating' | 'communication' | 'dietary' | 'accompaniment';
export type ScopeType = 'activity' | 'program' | 'global';
export type VersionStatus =
  | 'draft'
  | 'active'
  | 'confirmed_alternative'
  | 'expired'
  | 'revoked'
  | 'superseded';
export type ReassessmentReason =
  | 'content_changed'
  | 'authorization_revoked'
  | 'consent_withdrawn'
  | 'review_due'
  | 'expired';

export interface AuthUser {
  id: string;
  role: Role;
  linkedStudentId: string | null;
  email: string;
  name: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return (
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * 版本哈希链:内容哈希纳入前一版本哈希与所引依据,
 * 使"已分发简报引用的版本"事后不可被篡改而不被发现。
 */
export function sha256(input: string): string {
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

export function contentHash(summary: string): string {
  return sha256('content:' + summary.trim());
}

export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString();
}
