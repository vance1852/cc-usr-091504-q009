/* eslint-disable no-console */
// 真实 HTTP 端到端冒烟:走 Nest 服务器完整权限栈与校验管道
const BASE = process.env.BASE || 'http://127.0.0.1:3111';

async function call(method: string, path: string, token?: string, body?: any) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function expect(label: string, cond: boolean) {
  if (!cond) throw new Error('HTTP 断言失败: ' + label);
  console.log('  ✓ ' + label);
}

(async () => {
  const uniq = Date.now();
  // 注册
  await call('POST', '/auth/register', undefined, { email: `c${uniq}@x.edu`, password: 'secret123', name: '协调员', role: 'coordinator' });
  await call('POST', '/auth/register', undefined, { email: `m${uniq}@x.edu`, password: 'secret123', name: '科学导师', role: 'mentor' });
  await call('POST', '/auth/register', undefined, { email: `g${uniq}@x.edu`, password: 'secret123', name: '家长', role: 'guardian' });
  await call('POST', '/auth/register', undefined, { email: `s${uniq}@x.edu`, password: 'secret123', name: '学生', role: 'student' });

  const CT = (await call('POST', '/auth/login', undefined, { email: `c${uniq}@x.edu`, password: 'secret123' })).json.token;
  const MT = (await call('POST', '/auth/login', undefined, { email: `m${uniq}@x.edu`, password: 'secret123' })).json.token;
  const GT = (await call('POST', '/auth/login', undefined, { email: `g${uniq}@x.edu`, password: 'secret123' })).json.token;
  const ST = (await call('POST', '/auth/login', undefined, { email: `s${uniq}@x.edu`, password: 'secret123' })).json.token;

  // 权限边界
  await expect('导师不能建学生档案', (await call('POST', '/coordination/students', MT, { name: 'x' })).status === 403);
  await expect('学生偏好接口拒绝协调员', (await call('POST', '/student/preferences', CT, { text: 'x' })).status === 403);
  await expect('家长未关联孩子时查看当前版本 403', (await call('GET', '/guardian/child/current', GT)).status === 403);

  // 建档关联
  const sid = (await call('POST', '/coordination/students', CT, { name: '小明' })).json.id;
  // 从登录 token 的 base64url 载荷取各账号 id(协调端关联需要)
  const payload = JSON.parse(Buffer.from(MT.split('.')[1], 'base64url').toString());
  const mentorId = payload.id;
  const guardianPayload = JSON.parse(Buffer.from(GT.split('.')[1], 'base64url').toString());
  const guardianId = guardianPayload.id;
  const studentPayload = JSON.parse(Buffer.from(ST.split('.')[1], 'base64url').toString());
  const studentUserId = studentPayload.id;

  await call('PUT', `/coordination/students/${sid}/guardian`, CT, { guardianUserId: guardianId });
  await call('PUT', `/coordination/students/${sid}/student-user`, CT, { userId: studentUserId });
  // 关联后重新登录,使 JWT 携带 linkedStudentId
  const GT2 = (await call('POST', '/auth/login', undefined, { email: `g${uniq}@x.edu`, password: 'secret123' })).json.token;
  const ST2 = (await call('POST', '/auth/login', undefined, { email: `s${uniq}@x.edu`, password: 'secret123' })).json.token;

  // 授权 + 原始材料
  const authId = (await call('POST', '/coordination/authorizations', CT, { scope: 'all' })).json.id;
  const matId = (await call('POST', `/coordination/students/${sid}/source-materials`, CT, {
    kind: 'medical', title: '诊断书(密)', rawText: '诊断:花生过敏IgE4+;自闭谱系障碍',
  })).json.id;

  // 家长同意
  const consentId = (await call('POST', '/guardian/consents', GT2, { scope: 'baking:dietary' })).json.id;

  // 活动(烘焙含花生)
  const actId = (await call('POST', '/coordination/activities', CT, {
    title: '烘焙活动', contentSummary: '制作曲奇', allergens: ['花生'],
    startsAt: '2026-09-25T09:00:00Z', endsAt: '2026-09-25T11:00:00Z',
    studentIds: [sid], mentorIds: [mentorId],
  })).json.id;

  // 无授权转化被拒绝 -> 用授权创建措施
  const measureId = (await call('POST', `/coordination/students/${sid}/measures`, CT, {
    sourceMaterialId: matId, type: 'dietary',
    scopes: [{ scopeType: 'activity', activityId: actId }],
    instruction: '不提供含花生食材,配料表现场核对',
    constraints: { avoidAllergens: ['花生'] },
    consentScope: 'baking:dietary', consentGrantId: consentId, authorizationId: authId,
    reviewDate: '2026-12-31T00:00:00Z',
  })).json.measureId;
  await expect('措施创建成功', !!measureId);

  // 准备活动 -> 冲突待确认
  let prep = (await call('POST', `/coordination/activities/${actId}/prepare`, CT)).json;
  await expect('烘焙含花生产生待确认冲突', prep.pendingConflicts.some((c: any) => c.kind === 'allergen_exposure'));
  await expect('准备结果含引用版本与哈希', prep.citedVersions[0]?.basedOnHash?.length === 64);

  // 导师能看到简报但无诊断词
  let briefings = (await call('GET', `/mentor/briefings?activityId=${actId}`, MT)).json;
  await expect('导师收到当场简报', briefings.length === 1);
  await expect('导师简报无诊断原文', !JSON.stringify(briefings).includes('IgE') && !JSON.stringify(briefings).includes('自闭'));
  await expect('导师无法访问原始材料接口', (await call('GET', `/coordination/students/${sid}/source-materials`, MT)).status === 403);

  // 导师阅读回执
  await call('POST', `/mentor/briefings/${briefings[0].id}/read`, MT);
  prep = (await call('POST', `/coordination/activities/${actId}/prepare`, CT)).json;
  await expect('准备结果可见导师已读回执', prep.receipts.every((r: any) => r.read_at));

  // 确认替代措施 -> 冲突关闭
  await call('POST', `/coordination/measures/${measureId}/confirm-alternative`, CT, {
    instruction: '独立器具+单独操作台+预置无花生点心',
    constraints: { avoidAllergens: ['花生'], separateUtensils: true },
    consentScope: 'baking:dietary', consentGrantId: consentId,
  });
  prep = (await call('POST', `/coordination/activities/${actId}/prepare`, CT)).json;
  await expect('替代确认后冲突清零', prep.pendingConflicts.length === 0);

  // 家长视图:当前版本,无诊断词
  const view = (await call('GET', '/guardian/child/current', GT2)).json;
  await expect('家长看到措施当前版本', view.measures[0]?.version >= 2);
  await expect('家长视图无诊断原文', !JSON.stringify(view).includes('IgE'));

  // 监护人撤回同意 -> 导师旧简报阻断
  await call('POST', `/guardian/consents/${consentId}/revoke`, GT2, { note: '改变主意' });
  prep = (await call('POST', `/coordination/activities/${actId}/prepare`, CT)).json;
  await expect('撤回同意后措施阻断', prep.blocked.some((b: any) => b.blockReasons.includes('consent_withdrawn')));
  briefings = (await call('GET', `/mentor/briefings?activityId=${actId}`, MT)).json;
  await expect('导师简报被标记 blocked', briefings.every((b: any) => b.blocked));
  const execAttempt = await call('POST', `/mentor/briefings/${briefings[0].id}/execute`, MT, { note: 'x' });
  await expect('按阻断简报执行被 403 拒绝', execAttempt.status === 403);

  // 学生受限偏好
  const pref = (await call('POST', '/student/preferences', ST2, { text: '请不要当众提我的评估结果' })).json;
  await expect('学生偏好保存为 restricted', pref.visibility === 'restricted');

  // 内容变更 -> 自动重评
  await call('PUT', `/coordination/activities/${actId}/content`, CT, { contentSummary: '改为现场研磨花生酱' });
  const pending = (await call('GET', '/coordination/reassessments?status=pending', CT)).json;
  await expect('内容变更自动产生重评单', pending.some((r: any) => r.reason === 'content_changed'));

  console.log('\nHTTP 端到端流程全部通过');
})().catch((e) => { console.error(e); process.exit(1); });
