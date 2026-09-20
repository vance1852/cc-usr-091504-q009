/** 系统角色 */
export enum Role {
  COORDINATOR = 'COORDINATOR',
  INSTRUCTOR = 'INSTRUCTOR',
  GUARDIAN = 'GUARDIAN',
  STUDENT = 'STUDENT',
}

/** 可执行措施类型：座位、沟通、饮食、陪同 */
export enum MeasureType {
  SEATING = 'SEATING',
  COMMUNICATION = 'COMMUNICATION',
  DIET = 'DIET',
  ACCOMPANIMENT = 'ACCOMPANIMENT',
}

/** 措施未进入导师简报的原因 */
export enum BlockReason {
  RETIRED = 'RETIRED',
  REVIEW_DUE = 'REVIEW_DUE',
  CONSENT_MISSING = 'CONSENT_MISSING',
  CONSENT_WITHDRAWN = 'CONSENT_WITHDRAWN',
  GRANT_REVOKED = 'GRANT_REVOKED',
  REASSESSMENT_OPEN = 'REASSESSMENT_OPEN',
  CONFLICT_OPEN = 'CONFLICT_OPEN',
  NOT_VISIBLE = 'NOT_VISIBLE',
}

/** 冲突类别 */
export enum ConflictKind {
  /** 多活动时间重叠且饮食/陪同安排相互牵制 */
  OVERLAP = 'OVERLAP',
  /** 导师当场无法执行（如场地条件不满足） */
  INFEASIBLE = 'INFEASIBLE',
}

/** 重评触发原因 */
export enum ReassessReason {
  SESSION_CONTENT_CHANGED = 'SESSION_CONTENT_CHANGED',
}

/** 替代措施状态 */
export enum AlternativeStatus {
  PROPOSED = 'PROPOSED',
  CONFIRMED = 'CONFIRMED',
  REJECTED = 'REJECTED',
}

/** 学生偏好的可见范围 */
export enum PreferenceVisibility {
  /** 仅协调员与学生本人可见，绝不进入导师简报 */
  PRIVATE = 'PRIVATE',
  /** 可在导师简报中出现 */
  SHARE_INSTRUCTOR = 'SHARE_INSTRUCTOR',
}

export const ALL_MEASURE_TYPES = Object.values(MeasureType);
