import request from 'supertest';
import { buildWorld, destroyWorld, World } from './world';
import { MeasureType } from '../src/common/enums';
import { DatabaseService } from '../src/db/database.service';

/** 未来日期 YYYY-MM-DD */
function futureDate(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
}
function pastDate(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

describe('个别支持措施服务', () => {
  let w: World;

  beforeEach(async () => {
    w = await buildWorld();
  });
  afterEach(async () => {
    await destroyWorld(w);
  });

  const auth = (login: string) => ({
    Authorization: `Bearer ${w.tokens[login]}`,
  });

  async function createSession(
    login: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await request(w.http)
      .post('/sessions')
      .set(auth(login))
      .send(body)
      .expect(201);
    return res.body.id;
  }

  async function makeMeasure(body: Record<string, unknown>, login = 'coord') {
    const res = await request(w.http)
      .post('/measures')
      .set(auth(login))
      .send(body)
      .expect(201);
    return res.body;
  }

  it('1. 完整流程：材料转化 → 同意 → 简报只含可执行措施且无诊断原文', async () => {
    const sciSession = await createSession('coord', {
      name: '科学实验课',
      startAt: '2099-01-05T10:00:00Z',
      durationMinutes: 60,
      instructorId: await userIdByLogin('sci'),
    });
    const bakeSession = await createSession('coord', {
      name: '烘焙活动',
      startAt: '2099-01-06T10:00:00Z',
      durationMinutes: 60,
      instructorId: await userIdByLogin('bake'),
    });

    // 上传诊断性原始材料
    const matRes = await request(w.http)
      .post('/materials')
      .set(auth('coord'))
      .send({
        studentId: w.ids.studentId,
        kind: '医疗评估',
        title: '感官处理评估',
        content: '【诊断性原文】ASD 诊断，对声光刺激敏感……',
      })
      .expect(201);
    const materialId = matRes.body.id;

    await request(w.http)
      .post(`/sessions/${sciSession}/enrollments`)
      .set(auth('coord'))
      .send({ studentId: w.ids.studentId })
      .expect(201);
    await request(w.http)
      .post(`/sessions/${bakeSession}/enrollments`)
      .set(auth('coord'))
      .send({ studentId: w.ids.studentId })
      .expect(201);

    // 低刺激座位：仅适用科学课、复核日期、仅科学课导师可见
    const seating = await makeMeasure({
      studentId: w.ids.studentId,
      type: MeasureType.SEATING,
      instruction: '安排在远离音响与门口的角落座位，减少声光刺激',
      reviewDate: futureDate(30),
      target: 'SESSIONS',
      sessionIds: [sciSession],
      visibility: 'INSTRUCTORS',
      instructorIds: [await userIdByLogin('sci')],
      sourceMaterialIds: [materialId],
    });
    // 烘焙单独过敏原回避：适用烘焙，全部导师可见
    const diet = await makeMeasure({
      studentId: w.ids.studentId,
      type: MeasureType.DIET,
      instruction: '全程避免坚果及含坚果成分食材，使用专属案板',
      reviewDate: futureDate(60),
      target: 'SESSIONS',
      sessionIds: [bakeSession],
      visibility: 'ALL_INSTRUCTORS',
      sourceMaterialIds: [materialId],
    });

    // 尚未登记监护人同意 → 两项措施都应被拦截 CONSENT_MISSING
    const prepBefore = await request(w.http)
      .get(`/sessions/${sciSession}/preparation`)
      .set(auth('coord'))
      .expect(200);
    expect(prepBefore.body.satisfied).toHaveLength(0);
    expect(prepBefore.body.blocked[0].blockReasons).toContain(
      'CONSENT_MISSING',
    );

    // 家长登记同意：座位 + 饮食 + 沟通 + 陪同
    await request(w.http)
      .post('/consent')
      .set(auth('guard'))
      .send({
        studentId: w.ids.studentId,
        allowedTypes: ['SEATING', 'DIET', 'COMMUNICATION', 'ACCOMPANIMENT'],
      })
      .expect(201);

    // 科学课准备结果：满足座位措施，引用版本可见
    const prepSci = await request(w.http)
      .get(`/sessions/${sciSession}/preparation`)
      .set(auth('coord'))
      .expect(200);
    expect(prepSci.body.satisfied).toHaveLength(1);
    expect(prepSci.body.satisfied[0].type).toBe('SEATING');
    expect(prepSci.body.satisfied[0].versionNo).toBe(1);
    expect(prepSci.body.satisfied[0].sources[0].title).toBe('感官处理评估');
    // 烘焙措施不出现在科学课（场次适用范围隔离）
    expect(
      prepSci.body.satisfied.find((m: any) => m.type === 'DIET'),
    ).toBeUndefined();

    // 导师简报：科学课导师只看到座位措施，且无诊断原文/材料引用
    const briefSci = await request(w.http)
      .get(`/sessions/${sciSession}/briefing`)
      .set(auth('sci'))
      .expect(200);
    expect(briefSci.body.items).toHaveLength(1);
    expect(briefSci.body.items[0].type).toBe('SEATING');
    expect(JSON.stringify(briefSci.body)).not.toContain('诊断');
    expect(JSON.stringify(briefSci.body)).not.toContain('ASD');
    expect(briefSci.body.items[0].sources).toBeUndefined();
    expect(briefSci.body.blocked).toBeUndefined();

    // 烘焙导师看到饮食措施，看不到座位措施
    const briefBake = await request(w.http)
      .get(`/sessions/${bakeSession}/briefing`)
      .set(auth('bake'))
      .expect(200);
    expect(briefBake.body.items).toHaveLength(1);
    expect(briefBake.body.items[0].type).toBe('DIET');

    // 烘焙导师不能偷看科学课简报
    await request(w.http)
      .get(`/sessions/${sciSession}/briefing`)
      .set(auth('bake'))
      .expect(403);

    // 导师任何情况下都不能读原始材料
    await request(w.http)
      .get(`/materials/${materialId}`)
      .set(auth('sci'))
      .expect(403);
    // 无授权的协调员也不能读原文
    await request(w.http)
      .get(`/materials/${materialId}`)
      .set(auth('coord2'))
      .expect(403);

    return { sciSession, bakeSession, seating, diet };
  });

  it('2. 活动内容改变 → 自动生成重评标记 → 措施暂停分发；解决后恢复', async () => {
    const sciSession = await createSession('coord', {
      name: '科学实验课',
      startAt: '2099-02-05T10:00:00Z',
      durationMinutes: 60,
      instructorId: await userIdByLogin('sci'),
    });
    await request(w.http)
      .post(`/sessions/${sciSession}/enrollments`)
      .set(auth('coord'))
      .send({ studentId: w.ids.studentId });
    await request(w.http)
      .post('/consent')
      .set(auth('guard'))
      .send({ studentId: w.ids.studentId, allowedTypes: ['SEATING'] });
    await makeMeasure({
      studentId: w.ids.studentId,
      type: MeasureType.SEATING,
      instruction: '低刺激座位',
      reviewDate: futureDate(30),
      target: 'ALL',
      visibility: 'ALL_INSTRUCTORS',
    });

    // 变更前：导师可见
    const before = await request(w.http)
      .get(`/sessions/${sciSession}/briefing`)
      .set(auth('sci'))
      .expect(200);
    expect(before.body.items).toHaveLength(1);

    // 活动内容改为强声光实验
    const change = await request(w.http)
      .post(`/sessions/${sciSession}/content-change`)
      .set(auth('coord'))
      .send({ name: '声光爆炸物实验', note: '实验内容显著改变' })
      .expect(201);
    expect(change.body.flaggedStudents).toContain(w.ids.studentId);
    expect(change.body.contentRevision).toBe(2);

    // 重评未完成：导师简报不再包含该措施（自动找出需要重新评估的学生）
    const afterChange = await request(w.http)
      .get(`/sessions/${sciSession}/briefing`)
      .set(auth('sci'))
      .expect(200);
    expect(afterChange.body.items).toHaveLength(0);

    // 准备结果列出待重评
    const prep = await request(w.http)
      .get(`/sessions/${sciSession}/preparation`)
      .set(auth('coord'))
      .expect(200);
    expect(prep.body.pendingReassessments).toHaveLength(1);
    expect(prep.body.blocked[0].blockReasons).toContain('REASSESSMENT_OPEN');

    // 协调员复核后解决标记 → 恢复分发
    const flagId = prep.body.pendingReassessments[0].id;
    await request(w.http)
      .post(`/sessions/reassessment-flags/${flagId}/resolve`)
      .set(auth('coord'))
      .send({ note: '已评估，座位调整到隔音区' })
      .expect(201);
    const resolved = await request(w.http)
      .get(`/sessions/${sciSession}/briefing`)
      .set(auth('sci'))
      .expect(200);
    expect(resolved.body.items).toHaveLength(1);
  });

  it('3. 措施过期或监护人收缩同意范围后阻止分发，但已执行记录保留当时依据', async () => {
    const bakeSession = await createSession('coord', {
      name: '烘焙活动',
      startAt: '2099-03-05T10:00:00Z',
      durationMinutes: 60,
      instructorId: await userIdByLogin('bake'),
    });
    await request(w.http)
      .post(`/sessions/${bakeSession}/enrollments`)
      .set(auth('coord'))
      .send({ studentId: w.ids.studentId });
    await request(w.http)
      .post('/consent')
      .set(auth('guard'))
      .send({
        studentId: w.ids.studentId,
        allowedTypes: ['SEATING', 'DIET'],
      });
    const diet = await makeMeasure({
      studentId: w.ids.studentId,
      type: MeasureType.DIET,
      instruction: '避免坚果',
      reviewDate: futureDate(10),
      target: 'ALL',
      visibility: 'ALL_INSTRUCTORS',
    });

    // 导师先执行一次
    const exec = await request(w.http)
      .post(`/sessions/${bakeSession}/executions`)
      .set(auth('bake'))
      .send({ measureId: diet.id, note: '已使用无坚果食材' })
      .expect(201);
    expect(exec.body.versionId).toBeTruthy();

    // (a) 监护人撤回饮食类同意（新版本）
    await request(w.http)
      .post('/consent')
      .set(auth('guard'))
      .send({ studentId: w.ids.studentId, allowedTypes: ['SEATING'] })
      .expect(201);
    const afterWithdraw = await request(w.http)
      .get(`/sessions/${bakeSession}/briefing`)
      .set(auth('bake'))
      .expect(200);
    expect(afterWithdraw.body.items).toHaveLength(0);

    // 不能再登记执行旧措施
    await request(w.http)
      .post(`/sessions/${bakeSession}/executions`)
      .set(auth('bake'))
      .send({ measureId: diet.id })
      .expect(400);

    // (b) 恢复饮食同意，措施回来；再让复核日期过期
    await request(w.http)
      .post('/consent')
      .set(auth('guard'))
      .send({
        studentId: w.ids.studentId,
        allowedTypes: ['SEATING', 'DIET'],
      });
    // 复核日期到达：直接把当前版本复核日改为昨天，模拟时间流逝后的到期
    const db = w.app.get(DatabaseService);
    db.prepare('UPDATE measure_versions SET review_date = ? WHERE measure_id = ?')
      .run(pastDate(1), diet.id);
    const afterExpiry = await request(w.http)
      .get(`/sessions/${bakeSession}/briefing`)
      .set(auth('bake'))
      .expect(200);
    expect(afterExpiry.body.items).toHaveLength(0);
    const prepExpiry = await request(w.http)
      .get(`/sessions/${bakeSession}/preparation`)
      .set(auth('coord'))
      .expect(200);
    expect(prepExpiry.body.blocked[0].blockReasons).toContain('REVIEW_DUE');

    // 已执行记录仍保留，且记录的是当时版本与同意版本
    const logs = await request(w.http)
      .get(`/sessions/${bakeSession}/executions`)
      .set(auth('coord'))
      .expect(200);
    expect(logs.body).toHaveLength(1);
    expect(logs.body[0].instruction_snapshot).toBe('避免坚果');
    expect(logs.body[0].consent_version_id).toBeTruthy();
  });

  it('4. 授权撤回立即阻断旧摘要分发', async () => {
    const session = await createSession('coord', {
      name: '科学实验课',
      startAt: '2099-04-05T10:00:00Z',
      durationMinutes: 60,
      instructorId: await userIdByLogin('sci'),
    });
    await request(w.http)
      .post(`/sessions/${session}/enrollments`)
      .set(auth('coord'))
      .send({ studentId: w.ids.studentId });
    await request(w.http)
      .post('/consent')
      .set(auth('guard'))
      .send({ studentId: w.ids.studentId, allowedTypes: ['SEATING'] });
    const measure = await makeMeasure({
      studentId: w.ids.studentId,
      type: MeasureType.SEATING,
      instruction: '低刺激座位',
      reviewDate: futureDate(30),
      target: 'ALL',
      visibility: 'ALL_INSTRUCTORS',
    });

    // 找到协调员的授权并撤回
    const grants = await request(w.http)
      .get(`/grants?studentId=${w.ids.studentId}`)
      .set(auth('coord'))
      .expect(200);
    const grantId = grants.body[0].id;
    await request(w.http)
      .delete(`/grants/${grantId}`)
      .set(auth('coord'))
      .expect(200);

    // 无有效授权的协调员不能再创建措施
    await request(w.http)
      .post('/measures')
      .set(auth('coord'))
      .send({
        studentId: w.ids.studentId,
        type: MeasureType.COMMUNICATION,
        instruction: '使用视觉提示卡',
        reviewDate: futureDate(30),
        target: 'ALL',
        visibility: 'ALL_INSTRUCTORS',
      })
      .expect(403);

    // 旧措施立即从导师简报消失（GRANT_REVOKED）
    const brief = await request(w.http)
      .get(`/sessions/${session}/briefing`)
      .set(auth('sci'))
      .expect(200);
    expect(brief.body.items).toHaveLength(0);
    const prep = await request(w.http)
      .get(`/sessions/${session}/preparation`)
      .set(auth('coord'))
      .expect(200);
    expect(prep.body.blocked.find((b: any) => b.measureId === measure.id).blockReasons).toContain(
      'GRANT_REVOKED',
    );
  });

  it('5. 多活动时间重叠被检测为待确认冲突并拦截；解决后恢复', async () => {
    // 两场时间完全重叠
    const s1 = await createSession('coord', {
      name: '科学实验课',
      startAt: '2099-05-05T10:00:00Z',
      durationMinutes: 90,
      instructorId: await userIdByLogin('sci'),
    });
    const s2 = await createSession('coord', {
      name: '烘焙活动',
      startAt: '2099-05-05T10:30:00Z',
      durationMinutes: 60,
      instructorId: await userIdByLogin('bake'),
    });
    await request(w.http)
      .post(`/sessions/${s1}/enrollments`)
      .set(auth('coord'))
      .send({ studentId: w.ids.studentId });
    await request(w.http)
      .post(`/sessions/${s2}/enrollments`)
      .set(auth('coord'))
      .send({ studentId: w.ids.studentId });

    await request(w.http)
      .post('/consent')
      .set(auth('guard'))
      .send({
        studentId: w.ids.studentId,
        allowedTypes: ['DIET', 'ACCOMPANIMENT'],
      });
    await makeMeasure({
      studentId: w.ids.studentId,
      type: MeasureType.ACCOMPANIMENT,
      instruction: '一对一陪同协助转移',
      reviewDate: futureDate(30),
      target: 'ALL',
      visibility: 'ALL_INSTRUCTORS',
    });

    // 两场准备结果都应看到 OVERLAP 待确认冲突
    const p1 = await request(w.http)
      .get(`/sessions/${s1}/preparation`)
      .set(auth('coord'))
      .expect(200);
    const p2 = await request(w.http)
      .get(`/sessions/${s2}/preparation`)
      .set(auth('coord'))
      .expect(200);
    expect(p1.body.pendingConflicts.map((c: any) => c.kind)).toContain('OVERLAP');
    expect(p2.body.pendingConflicts.map((c: any) => c.kind)).toContain('OVERLAP');

    // 学生级冲突未解决前，两场措施均被拦截
    expect(p1.body.satisfied).toHaveLength(0);
    expect(p2.body.satisfied).toHaveLength(0);
    expect(p1.body.blocked[0].blockReasons).toContain('CONFLICT_OPEN');

    // 协调员分别确认两场冲突（已与家长确认该生只参加一场）
    for (const prep of [p1, p2]) {
      const conflictId = prep.body.pendingConflicts[0].id;
      await request(w.http)
        .post(`/sessions/conflicts/${conflictId}/resolve`)
        .set(auth('coord'))
        .send({ note: '确认不并行参加' })
        .expect(201);
    }
    const final1 = await request(w.http)
      .get(`/sessions/${s1}/preparation`)
      .set(auth('coord'))
      .expect(200);
    expect(final1.body.pendingConflicts).toHaveLength(0);
    expect(final1.body.satisfied).toHaveLength(1);
  });

  it('6. 协调员确认导师提出的替代措施', async () => {
    const session = await createSession('coord', {
      name: '烘焙活动',
      startAt: '2099-06-05T10:00:00Z',
      durationMinutes: 60,
      instructorId: await userIdByLogin('bake'),
    });
    await request(w.http)
      .post(`/sessions/${session}/enrollments`)
      .set(auth('coord'))
      .send({ studentId: w.ids.studentId });
    await request(w.http)
      .post('/consent')
      .set(auth('guard'))
      .send({ studentId: w.ids.studentId, allowedTypes: ['DIET'] });
    const diet = await makeMeasure({
      studentId: w.ids.studentId,
      type: MeasureType.DIET,
      instruction: '避免坚果并设独立备餐区',
      reviewDate: futureDate(30),
      target: 'ALL',
      visibility: 'ALL_INSTRUCTORS',
    });

    // 导师提出替代方案
    const altRes = await request(w.http)
      .post(`/measures/${diet.id}/alternatives`)
      .set(auth('bake'))
      .send({ type: 'DIET', instruction: '改为预包装无坚果餐盒，取消现场备餐' })
      .expect(201);
    expect(altRes.body.status).toBe('PROPOSED');

    // 准备结果在替代措施确认前列为待办（导师可上报不可行冲突）
    await request(w.http)
      .post(`/sessions/${session}/conflicts/infeasible`)
      .set(auth('bake'))
      .send({
        studentId: w.ids.studentId,
        measureId: diet.id,
        description: '现场无法设置独立备餐区',
      })
      .expect(201);

    // 协调员确认替代措施
    await request(w.http)
      .post(`/alternatives/${altRes.body.id}/review`)
      .set(auth('coord'))
      .send({ status: 'CONFIRMED', note: '同意使用预包装餐盒' })
      .expect(201);

    // 准备结果列出已确认替代措施
    const prep = await request(w.http)
      .get(`/sessions/${session}/preparation`)
      .set(auth('coord'))
      .expect(200);
    expect(prep.body.confirmedAlternatives[0].instruction).toContain('餐盒');
  });

  it('7. 家长查看本人孩子当前版本；学生表达不愿公开的偏好不进入导师简报', async () => {
    const session = await createSession('coord', {
      name: '科学实验课',
      startAt: '2099-07-05T10:00:00Z',
      durationMinutes: 60,
      instructorId: await userIdByLogin('sci'),
    });
    await request(w.http)
      .post(`/sessions/${session}/enrollments`)
      .set(auth('coord'))
      .send({ studentId: w.ids.studentId });
    await request(w.http)
      .post('/consent')
      .set(auth('guard'))
      .send({
        studentId: w.ids.studentId,
        allowedTypes: ['SEATING', 'COMMUNICATION'],
      });
    const measure = await makeMeasure({
      studentId: w.ids.studentId,
      type: MeasureType.COMMUNICATION,
      instruction: '用简短口头指令配合图片',
      reviewDate: futureDate(30),
      target: 'ALL',
      visibility: 'ALL_INSTRUCTORS',
    });

    // 家长视图：当前版本
    const guardianView = await request(w.http)
      .get(`/guardian/children/${w.ids.studentId}/current-measures`)
      .set(auth('guard'))
      .expect(200);
    expect(guardianView.body.measures).toHaveLength(1);
    expect(guardianView.body.measures[0].versionNo).toBe(1);
    expect(guardianView.body.measures[0].validity.currentlyValid).toBe(true);

    // 其他家长不能看
    await request(w.http)
      .get(`/guardian/children/${w.ids.studentId}/current-measures`)
      .set(auth('pupil'))
      .expect(403);

    // 学生表达：公开偏好 + 私密偏好
    await request(w.http)
      .post('/preferences')
      .set(auth('pupil'))
      .send({
        studentId: w.ids.studentId,
        text: '希望被称呼小名',
        visibility: 'SHARE_INSTRUCTOR',
      })
      .expect(201);
    await request(w.http)
      .post('/preferences')
      .set(auth('pupil'))
      .send({
        studentId: w.ids.studentId,
        text: '不想让同学知道我需要协助，请避免当众提及',
        visibility: 'PRIVATE',
      })
      .expect(201);

    const brief = await request(w.http)
      .get(`/sessions/${session}/briefing`)
      .set(auth('sci'))
      .expect(200);
    const briefText = JSON.stringify(brief.body.preferences);
    expect(briefText).toContain('小名');
    expect(briefText).not.toContain('协助');

    // 协调员准备结果能看到私密偏好及可见性标记
    const prep = await request(w.http)
      .get(`/sessions/${session}/preparation`)
      .set(auth('coord'))
      .expect(200);
    expect(JSON.stringify(prep.body.preferences)).toContain('协助');
    expect(prep.body.preferences.find((p: any) => p.visibility === 'PRIVATE')).toBeTruthy();

    // 导师接口不能读偏好清单
    await request(w.http)
      .get(`/preferences?studentId=${w.ids.studentId}`)
      .set(auth('sci'))
      .expect(403);
  });

  it('8. 阅读回执绑定快照；措施变化后旧回执标记为过期', async () => {
    const session = await createSession('coord', {
      name: '科学实验课',
      startAt: '2099-08-05T10:00:00Z',
      durationMinutes: 60,
      instructorId: await userIdByLogin('sci'),
    });
    await request(w.http)
      .post(`/sessions/${session}/enrollments`)
      .set(auth('coord'))
      .send({ studentId: w.ids.studentId });
    await request(w.http)
      .post('/consent')
      .set(auth('guard'))
      .send({ studentId: w.ids.studentId, allowedTypes: ['SEATING'] });
    await makeMeasure({
      studentId: w.ids.studentId,
      type: MeasureType.SEATING,
      instruction: '低刺激座位 v1',
      reviewDate: futureDate(30),
      target: 'ALL',
      visibility: 'ALL_INSTRUCTORS',
    });

    // 导师签收
    const ack = await request(w.http)
      .post(`/sessions/${session}/acknowledge`)
      .set(auth('sci'))
      .expect(201);
    expect(ack.body.itemCount).toBe(1);

    let prep = await request(w.http)
      .get(`/sessions/${session}/preparation`)
      .set(auth('coord'))
      .expect(200);
    expect(prep.body.readReceipts[0].current).toBe(true);

    // 协调员停用措施 → 当场清单变为空，快照变化
    const measureId = prep.body.satisfied[0].measureId;
    await request(w.http)
      .post(`/measures/${measureId}/retire`)
      .set(auth('coord'))
      .expect(201);

    prep = await request(w.http)
      .get(`/sessions/${session}/preparation`)
      .set(auth('coord'))
      .expect(200);
    expect(prep.body.satisfied).toHaveLength(0);
    expect(prep.body.readReceipts[0].current).toBe(false);
  });

  /** 通过登录名查用户 id（利用 /users/me 之外的引导：直接走一次登录结果） */
  async function userIdByLogin(login: string): Promise<string> {
    const res = await request(w.http)
      .post('/auth/login')
      .send({ login, password: 'pw123456' });
    // token 本身不暴露 id；用 /users/me
    const me = await request(w.http)
      .get('/users/me')
      .set({ Authorization: `Bearer ${res.body.token}` })
      .expect(200);
    return me.body.id;
  }
});
