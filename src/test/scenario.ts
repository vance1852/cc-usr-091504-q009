/* eslint-disable no-console */
/**
 * 端到端场景验证(不经过 HTTP,直接装配服务):
 * 覆盖 最小可见分发 / 诊断隔离 / 活动准备结果 / 阅读回执 /
 *      内容变更重评 / 授权撤回 / 同意撤回 / 过期阻断 / 执行留痕 /
 *      多活动重叠 / 家长视图 / 学生受限偏好 / HTTP 权限。
 */
import { DbService } from '../db/db.service';
import { SupportLogic } from '../logic/support.logic';
import { CoordinationService } from '../coordination/coordination.service';
import { MentorService } from '../mentor/mentor.service';
import { GuardianService } from '../guardian/guardian.service';
import { StudentService } from '../student/student.service';
import { AuthUser } from '../common/domain';
import * as assert from 'node:assert';

let passed = 0;
function check(name: string, cond: any) {
  assert.ok(cond, 'FAIL: ' + name);
  passed++;
  console.log('  ✓ ' + name);
}

function iso(dayOffset: number, hour: number, min = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
}
const past = new Date(Date.now() - 86400_000).toISOString();
const future = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();

async function main() {
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  const db = new DbService();
  db.onModuleInit();
  const logic = new SupportLogic(db);
  const coord = new CoordinationService(db, logic);
  const mentorSvc = new MentorService(db);
  const guardianSvc = new GuardianService(db, logic);
  const studentSvc = new StudentService(db);

  // ---------- 账号 ----------
  const insUser = db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role) VALUES (?,?,?,?,?)`,
  );
  insUser.run('u-coord', 'c@x.edu', 'x', '协调员', 'coordinator');
  insUser.run('u-m1', 'm1@x.edu', 'x', '科学导师', 'mentor');
  insUser.run('u-m2', 'm2@x.edu', 'x', '烘焙导师', 'mentor');
  insUser.run('u-m3', 'm3@x.edu', 'x', '外勤导师', 'mentor');
  insUser.run('u-g', 'g@x.edu', 'x', '家长', 'guardian');
  insUser.run('u-stu', 'stu@x.edu', 'x', '学生本人', 'student');

  const coordUser: AuthUser = { id: 'u-coord', role: 'coordinator', linkedStudentId: null, email: 'c@x.edu', name: '协调员' };
  const m1: AuthUser = { id: 'u-m1', role: 'mentor', linkedStudentId: null, email: 'm1@x.edu', name: '科学导师' };
  const m2: AuthUser = { id: 'u-m2', role: 'mentor', linkedStudentId: null, email: 'm2@x.edu', name: '烘焙导师' };
  const m3: AuthUser = { id: 'u-m3', role: 'mentor', linkedStudentId: null, email: 'm3@x.edu', name: '外勤导师' };
  const guardian: AuthUser = { id: 'u-g', role: 'guardian', linkedStudentId: null, email: 'g@x.edu', name: '家长' };
  const student: AuthUser = { id: 'u-stu', role: 'student', linkedStudentId: null, email: 'stu@x.edu', name: '学生本人' };

  // ---------- 学生档案与关联 ----------
  const s = coord.createStudent(coordUser, '小明');
  const s2 = coord.createStudent(coordUser, '小红');
  coord.linkGuardian(s.id, 'u-g');
  coord.linkStudentUser(s.id, 'u-stu');
  guardian.linkedStudentId = s.id;
  student.linkedStudentId = s.id;

  // ---------- 授权(两份,验证撤回的作用域隔离) ----------
  const auth1 = coord.grantAuthorization(coordUser, '科学/烘焙材料转化');
  const auth2 = coord.grantAuthorization(coordUser, '外勤陪同材料转化');

  // ---------- 诊断性原始材料 ----------
  const DIAGNOSTIC = '临床诊断:自闭谱系障碍(DSM-5),花生过敏(IgE 4+,既往喉头水肿)';
  const mat = coord.addSourceMaterial(coordUser, s.id, {
    kind: 'medical',
    title: '医院诊断证明书',
    rawText: DIAGNOSTIC,
  });
  const mat2 = coord.addSourceMaterial(coordUser, s2.id, {
    kind: 'medical', title: '评估报告', rawText: '注意力评估结论(密)',
  });

  // ---------- 活动 ----------
  const a1 = coord.createActivity(coordUser, {
    title: '科学实验课', programCode: 'SCI',
    contentSummary: '普通化学实验,室内安静', allergens: [],
    startsAt: iso(1, 9), endsAt: iso(1, 10),
    studentIds: [s.id, s2.id], mentorIds: ['u-m1'],
  });
  const a2 = coord.createActivity(coordUser, {
    title: '烘焙活动', programCode: 'BAKE',
    contentSummary: '制作曲奇饼干', allergens: ['花生', '麸质'],
    startsAt: iso(2, 9), endsAt: iso(2, 11),
    studentIds: [s.id], mentorIds: ['u-m2'],
  });
  const a3 = coord.createActivity(coordUser, {
    title: '社区参观A', contentSummary: '步行外出',
    startsAt: iso(3, 10), endsAt: iso(3, 11),
    studentIds: [s.id], mentorIds: ['u-m3'],
  });
  const a4 = coord.createActivity(coordUser, {
    title: '社区参观B', contentSummary: '步行外出',
    startsAt: iso(3, 10, 30), endsAt: iso(3, 11, 30),
    studentIds: [s.id], mentorIds: [],
  });

  // ---------- 监护人同意(饮食回避可分发给烘焙导师) ----------
  const consent = guardianSvc.grantConsent(guardian, {
    scope: 'baking:dietary', details: '同意向烘焙导师说明花生回避操作要求',
  });

  // ---------- 原始材料 -> 可执行措施(不含诊断措辞) ----------
  const mSeating = coord.createMeasure(coordUser, s.id, {
    sourceMaterialId: mat.id, type: 'seating',
    scopes: [{ scopeType: 'activity', activityId: a1.id }],
    instruction: '安排在远离通风口与人群的低刺激角落座位,预留安静退出通道',
    constraints: { area: 'quiet_corner', reduceStimuli: true },
    reviewDate: future(90), consentScope: 'science:seating',
    authorizationId: auth1.id,
  });
  const mDiet = coord.createMeasure(coordUser, s.id, {
    sourceMaterialId: mat.id, type: 'dietary',
    scopes: [{ scopeType: 'activity', activityId: a2.id }],
    instruction: '不提供含花生食材;配料表需现场核对',
    constraints: { avoidAllergens: ['花生'] },
    reviewDate: future(90), consentScope: 'baking:dietary',
    consentGrantId: consent.id, authorizationId: auth1.id,
  });
  const mEscort = coord.createMeasure(coordUser, s.id, {
    sourceMaterialId: mat.id, type: 'accompaniment',
    scopes: [
      { scopeType: 'activity', activityId: a3.id },
      { scopeType: 'activity', activityId: a4.id },
    ],
    instruction: '外出时由一名固定成人陪同,提前以图示告知行程',
    constraints: { escort: 'one_adult', toZone: 'exit_ready', avoidSurprise: true },
    reviewDate: future(90), consentScope: 'outing:accompaniment',
    authorizationId: auth2.id,
  });
  const mExp = coord.createMeasure(coordUser, s2.id, {
    sourceMaterialId: mat2.id, type: 'communication',
    scopes: [{ scopeType: 'activity', activityId: a1.id }],
    instruction: '发出指令时面向学生并配合书面步骤卡',
    constraints: { approach: 'face_and_card' },
    reviewDate: past, expiresAt: past,
    consentScope: 'science:communication', authorizationId: auth2.id,
  });

  console.log('\n[1] 科学课活动准备:已满足措施 / 引用版本 / 无诊断泄露');
  const prep1 = coord.prepareActivity(coordUser, a1.id);
  check('科学课有 1 项已满足措施(座位)', prep1.satisfied.length === 1);
  check('已满足措施为低刺激座位 v1',
    prep1.satisfied[0].type === 'seating' && prep1.citedVersions[0].version === 1);
  check('所引用版本带哈希链锚点',
    /^[0-9a-f]{64}$/.test(prep1.citedVersions[0].basedOnHash));
  check('待确认冲突初始为空', prep1.pendingConflicts.length === 0);
  check('准备结果固化了 prepId 与快照',
    !!prep1.prepId && !!(db.prepare('SELECT snapshot FROM preps WHERE id=?').get(prep1.prepId) as any).snapshot);
  check('准备文本不含诊断原文', JSON.stringify(prep1).includes(DIAGNOSTIC) === false);

  console.log('\n[2] 烘焙课:过敏原冲突待确认 -> 协调员确认替代措施');
  const prep2 = coord.prepareActivity(coordUser, a2.id);
  check('检测到花生暴露冲突待确认',
    prep2.pendingConflicts.some((c: any) => c.kind === 'allergen_exposure'));
  check('冲突未确认时饮食措施仍标记满足但冲突单列',
    prep2.satisfied.some((x) => x.type === 'dietary'));
  const alt = coord.confirmAlternative(coordUser, mDiet.measureId, {
    instruction: '使用独立器具与单独操作台,提供预先备好的无花生替代点心',
    constraints: { avoidAllergens: ['花生'], separateUtensils: true },
    consentScope: 'baking:dietary', consentGrantId: consent.id,
  });
  check('替代措施成为 v2 且状态为 confirmed_alternative',
    alt.version === 2 && alt.status === 'confirmed_alternative');
  const prep2b = coord.prepareActivity(coordUser, a2.id);
  check('确认替代后冲突关闭', prep2b.pendingConflicts.length === 0);
  check('替代措施 v2 进入已满足列表',
    prep2b.satisfied.some((x) => x.version === 2 && /独立器具/.test(x.instruction)));

  console.log('\n[3] 导师最小可见 + 阅读回执 + 执行留痕');
  const b1 = mentorSvc.listBriefings(m1, a1.id);
  const b2 = mentorSvc.listBriefings(m2, a2.id);
  check('科学导师只收到当场措施', b1.length === 1 && b1[0].type === 'seating');
  check('烘焙导师只收到当场措施(替代版)', b2.every((x) => x.activityId === a2.id));
  check('导师简报不含任何诊断词',
    ![...b1, ...b2].some((x) => /诊断|IgE|自闭|喉头/.test(x.instruction)));
  mentorSvc.markRead(m1, b1[0].id);
  mentorSvc.execute(m1, b1[0].id, '已就座,状态平稳');
  const prep1c = coord.prepareActivity(coordUser, a1.id);
  const receipt = prep1c.receipts.find((r: any) => r.measure_id === mSeating.measureId && r.version === 1)!;
  check('准备结果含导师阅读回执(read_at 已落)', !!receipt.read_at);
  const execRows = db.prepare('SELECT * FROM executions').all() as any[];
  check('执行记录固化当时版本与文本', execRows.length === 1 && execRows[0].version === 1);

  console.log('\n[4] 活动内容改变 -> 自动重评并阻断旧摘要,旧版不可执行');
  coord.updateActivityContent(a1.id, { contentSummary: '改为高刺激声光化学演示秀' });
  const pendingAfterChange = coord.listReassessments('pending');
  check('内容变更自动为受影响学生建重评单',
    pendingAfterChange.some((r: any) => r.reason === 'content_changed' && r.student_id === s.id));
  const stale = mentorSvc.listBriefings(m1, a1.id)[0];
  check('旧摘要已被标记阻断', stale.blocked === true);
  assert.throws(() => mentorSvc.execute(m1, stale.id, 'x'), /失效/);
  console.log('  ✓ 导师按旧摘要执行被拒绝');
  const prep1d = coord.prepareActivity(coordUser, a1.id);
  check('重新准备时该措施出现在 blocked(content_changed)',
    prep1d.blocked.some((x) => x.measureId === mSeating.measureId && x.blockReasons.includes('content_changed')));
  check('已满足列表为空', prep1d.satisfied.length === 0);

  console.log('\n[5] 协调员修订措施 -> v2 生效,重评单关闭,旧简报作废');
  coord.reviseMeasure(coordUser, mSeating.measureId, {
    instruction: '演示秀期间在隔壁观察室就座,单向玻璃观看并配耳塞',
    constraints: { area: 'observation_room', reduceStimuli: true, note: '配耳塞' },
    consentScope: 'science:seating',
  });
  const prep1e = coord.prepareActivity(coordUser, a1.id);
  check('v2 重新可分发', prep1e.satisfied.some((x) => x.version === 2 && /观察室/.test(x.instruction)));
  check('该措施重评单已随修订关闭',
    !coord.listReassessments('pending').some((r: any) => r.measure_id === mSeating.measureId));
  check('历史版本仍可追溯(v1 superseded)',
    coord.listVersions(mSeating.measureId).some((v: any) => v.version === 1 && v.status === 'superseded'));

  console.log('\n[6] 监护人撤回同意 -> 旧饮食摘要停止分发');
  guardianSvc.withdrawConsent(guardian, consent.id, '改变主意');
  const prep2c = coord.prepareActivity(coordUser, a2.id);
  check('同意撤回后饮食措施阻断(consent_withdrawn)',
    prep2c.blocked.some((x) => x.measureId === mDiet.measureId && x.blockReasons.includes('consent_withdrawn')));
  check('烘焙导师无当场可执行措施',
    mentorSvc.listBriefings(m2, a2.id).every((x) => x.blocked));

  console.log('\n[7] 授权撤回 -> 版本失效、阻断分发、自动重评(作用域隔离)');
  coord.revokeAuthorization(auth1.id);
  const vSeating = (db.prepare('SELECT status FROM measure_versions WHERE measure_id=? ORDER BY version DESC LIMIT 1').get(mSeating.measureId) as any);
  check('引用授权1的座位版本变为 revoked', vSeating.status === 'revoked');
  const briefingBlocked = mentorSvc.listBriefings(m1, a1.id).every((x) => x.blocked);
  check('导师端该措施摘要全部阻断', briefingBlocked);
  check('撤回触发重新评估(authorization_revoked)',
    coord.listReassessments('pending').some((r: any) => r.reason === 'authorization_revoked'));
  const prepA3 = coord.prepareActivity(coordUser, a3.id);
  check('授权2 的陪同措施不受影响,仍可分发',
    prepA3.satisfied.some((x) => x.measureId === mEscort.measureId));

  console.log('\n[8] 多活动时间重叠检测');
  const overlaps = coord.crossActivityOverlaps();
  check('识别出小明在两场时间重叠活动中,且陪同措施同时执行冲突',
    overlaps.some((o) => o.studentId === s.id && o.activityA === a3.id && o.activityB === a4.id && o.escortConflict));

  console.log('\n[9] 复核/到期 -> 过期版本阻断并建重评单');
  const prep1f = coord.prepareActivity(coordUser, a1.id);
  check('小红的过期沟通措施被阻断(expired)',
    prep1f.blocked.some((x) => x.studentId === s2.id && x.blockReasons.includes('expired')));
  check('过期触发重评单',
    coord.listReassessments('pending').some((r: any) => r.reason === 'expired' && r.student_id === s2.id));

  console.log('\n[10] 已执行记录在一切失效后仍保留当时依据');
  const execAfter = db.prepare('SELECT * FROM executions').all() as any[];
  check('执行记录未被删除,快照仍是 v1 文本',
    execAfter.length === 1 && /低刺激角落/.test(execAfter[0].instruction_snapshot));

  console.log('\n[11] 家长查看本人孩子当前版本');
  const view = guardianSvc.currentView(guardian);
  check('家长视图列出全部措施当前版本', view.measures.length >= 3);
  const dietRow = view.measures.find((x) => x.type === 'dietary')!;
  check('家长能看到同意撤回后烘焙场不可分发及原因',
    dietRow.perActivity.some((p: any) => p.activityId === a2.id && p.distributable === false &&
      p.blockReasons.includes('consent_withdrawn')));
  check('家长视图同样不含诊断原文', JSON.stringify(view).includes(DIAGNOSTIC) === false);

  console.log('\n[12] 学生表达不愿公开的偏好(受限可见)');
  studentSvc.addPreference(student, '我不希望同学知道我的评估结果,请不要当众提');
  const prefs = studentSvc.listMyPreferences(student);
  check('偏好保存为 restricted', prefs[0].visibility === 'restricted');
  check('协调员可在档案中看到该偏好', coord.listPreferences(s.id).length === 1);
  const mentorFacing = JSON.stringify([
    mentorSvc.listBriefings(m1), mentorSvc.listBriefings(m2), mentorSvc.listBriefings(m3),
  ]);
  check('偏好绝不进入任何导师可见输出', mentorFacing.includes('不希望同学知道') === false);

  console.log('\n[13] 无有效授权不得转化材料');
  coord.revokeAuthorization(auth2.id);
  assert.throws(
    () => coord.createMeasure(coordUser, s.id, {
      sourceMaterialId: mat.id, type: 'seating',
      scopes: [{ scopeType: 'global' }],
      instruction: 'x', consentScope: 'x',
    }),
    /授权/,
  );
  console.log('  ✓ 两份授权均撤回后新建措施被拒绝');

  console.log(`\n领域场景全部通过 (${passed} 项断言)`);

  // ---------- HTTP 权限冒烟 ----------
  console.log('\n[14] HTTP 权限层冒烟');
  process.env.DB_PATH = require('node:os').tmpdir() + '/iss-scenario-' + Date.now() + '.sqlite';
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module');
  const { ValidationPipe } = await import('@nestjs/common');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0);
  const port = app.getHttpServer().address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = (p: string, body: any, token?: string) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body),
    });
  const get = (p: string, token?: string) =>
    fetch(base + p, { headers: token ? { authorization: 'Bearer ' + token } : {} });

  let r = await post('/auth/register', { email: 'mm@x.edu', password: 'secret123', name: '导师甲', role: 'mentor' });
  check('注册接口公开可访问', r.status === 201);
  r = await get('/mentor/briefings');
  check('未携带令牌访问受保护接口 401', r.status === 401);
  const login = await (await post('/auth/login', { email: 'mm@x.edu', password: 'secret123' })).json();
  r = await get('/coordination/activities', login.token);
  check('导师访问协调员接口 403', r.status === 403);
  r = await get('/mentor/briefings', login.token);
  check('导师访问本人接口 200', r.status === 200);
  await app.close();

  console.log(`\n全部通过: 共 ${passed + 4} 项断言`);
  db.exec && db.exec('PRAGMA wal_checkpoint');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
