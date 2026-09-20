import { randomUUID } from 'crypto';

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function now(): string {
  return new Date().toISOString();
}

/** 只取日期部分 YYYY-MM-DD */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function toCsv(values: string[]): string {
  return values.join(',');
}

export function fromCsv(value: string): string[] {
  return value ? value.split(',') : [];
}

/** 计算 [start, start+duration) 的结束时刻（ISO） */
export function endTime(startIso: string, durationMinutes: number): number {
  return new Date(startIso).getTime() + durationMinutes * 60_000;
}

/** 两个半开时间区间是否重叠 */
export function overlaps(
  aStart: string,
  aMin: number,
  bStart: string,
  bMin: number,
): boolean {
  const as = new Date(aStart).getTime();
  const bs = new Date(bStart).getTime();
  return as < bs + bMin * 60_000 && bs < as + aMin * 60_000;
}
