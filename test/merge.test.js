'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Merge = require('../src/merge.js');

// 构造一份含两灯、一回路、两条 Cue、接线完整的基线
function baseSnapshot(overrides = {}) {
  return {
    lights: [
      { id: 1, name: '面光1' },
      { id: 2, name: '侧光L' },
    ],
    circuits: [{ id: 1, name: '面光回路', capacity: 1500 }],
    cues: [
      { cue_no: 1, light_id: 1, time: 0, target: 50, duration: 0 },
      { cue_no: 2, light_id: 2, time: 2, target: 80, duration: 1 },
    ],
    wiring: [
      { light_id: 1, circuit_id: 1, watts: 300 },
      { light_id: 2, circuit_id: null, watts: null },
    ],
    ...overrides,
  };
}

function clone(s) {
  return JSON.parse(JSON.stringify(s));
}

// 预览中按 key 找冲突
function findConflict(result, key) {
  return result.conflicts.find((c) => c.key === key) || null;
}

test('仅待合入一侧修改 Cue → 自动合入 update', () => {
  const base = baseSnapshot();
  const draft = clone(base); // 草稿未动
  const incoming = clone(base);
  incoming.cues[0].target = 90;

  const cls = Merge.classify(base, draft, incoming);
  assert.equal(cls.summary.conflicts_total, 0);
  const auto = cls.auto.find((e) => e.key === 'cue:1');
  assert.ok(auto);
  assert.equal(auto.action, 'update');
  assert.equal(auto.applied.target, 90);

  const r = Merge.resolve(base, draft, incoming, {});
  assert.equal(r.ok, true);
  assert.equal(r.final.cues.find((c) => c.cue_no === 1).target, 90);
});

test('仅待合入一侧新增/删除 → 自动 add/delete；草稿单侧改动保留', () => {
  const base = baseSnapshot();
  const draft = clone(base);
  draft.lights.push({ id: 3, name: '草稿新灯' }); // 草稿单侧新增（不影响草稿，不算自动项）
  draft.wiring.push({ light_id: 3, circuit_id: null, watts: null });
  const incoming = clone(base);
  incoming.lights.push({ id: 4, name: '对方新灯' }); // 待合入单侧新增
  incoming.wiring.push({ light_id: 4, circuit_id: null, watts: null });
  incoming.cues = incoming.cues.filter((c) => c.cue_no !== 2); // 待合入单侧删除，草稿原样

  const r = Merge.resolve(base, draft, incoming, {});
  assert.equal(r.ok, true);
  const ids = r.final.lights.map((l) => l.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2, 3, 4]); // 两侧新增都保留
  assert.equal(r.final.cues.some((c) => c.cue_no === 2), false); // cue 2 自动删除
  const actions = r.auto.map((a) => `${a.kind}:${a.id}:${a.action}`).sort();
  assert.ok(actions.includes('light:4:add'));
  assert.ok(actions.includes('cue:2:delete'));
});

test('两侧改成相同内容 → 不算冲突也无需选择', () => {
  const base = baseSnapshot();
  const draft = clone(base);
  const incoming = clone(base);
  draft.circuits[0].capacity = 2000;
  incoming.circuits[0].capacity = 2000;

  const cls = Merge.classify(base, draft, incoming);
  assert.equal(findConflict(cls, 'circuit:1'), null);
  assert.equal(cls.auto.length, 0); // 草稿已是该值，无须自动改动
  const r = Merge.resolve(base, draft, incoming, {});
  assert.equal(r.ok, true);
  assert.equal(r.final.circuits[0].capacity, 2000);
});

test('两侧不同修改 → 冲突，两种抉择都可落定', () => {
  const base = baseSnapshot();
  const draft = clone(base);
  const incoming = clone(base);
  draft.lights[0].name = '面光1-草稿';
  incoming.lights[0].name = '面光1-合入';

  const cls = Merge.classify(base, draft, incoming);
  const c = findConflict(cls, 'light:1');
  assert.ok(c);
  assert.equal(c.reason, 'both_modified');

  const rd = Merge.resolve(base, draft, incoming, { 'light:1': 'draft' });
  assert.equal(rd.ok, true);
  assert.equal(rd.final.lights.find((l) => l.id === 1).name, '面光1-草稿');

  const ri = Merge.resolve(base, draft, incoming, { 'light:1': 'incoming' });
  assert.equal(ri.ok, true);
  assert.equal(ri.final.lights.find((l) => l.id === 1).name, '面光1-合入');

  // 未选择 → 未解决冲突
  const rn = Merge.resolve(base, draft, incoming, {});
  assert.equal(rn.ok, false);
  assert.ok(rn.unresolved.includes('light:1'));
});

test('删除与修改并存 → 冲突；删除+未改 → 自动删除', () => {
  const base = baseSnapshot();

  // 草稿删灯2，待合入改了灯2名称 → 删除与修改并存
  const draft = clone(base);
  draft.lights = draft.lights.filter((l) => l.id !== 2);
  draft.wiring = draft.wiring.filter((w) => w.light_id !== 2);
  draft.cues = draft.cues.filter((c) => c.cue_no !== 2);
  const incoming = clone(base);
  incoming.lights[1].name = '侧光R';

  const cls = Merge.classify(base, draft, incoming);
  assert.ok(findConflict(cls, 'light:2'));

  // 反过来：草稿删灯2，待合入完全没动灯2 → 删除是草稿单侧改动，保持现状
  // （不属于自动合入项；自动项只列待合入侧带来的改动）
  const incoming2 = clone(base);
  const cls2 = Merge.classify(base, draft, incoming2);
  assert.equal(findConflict(cls2, 'light:2'), null);
  assert.equal(cls2.auto.some((a) => a.key === 'light:2'), false);
  const r2 = Merge.resolve(base, draft, incoming2, {});
  assert.equal(r2.ok, true);
  assert.equal(r2.final.lights.some((l) => l.id === 2), false);

  // 对称场景：待合入删灯2、草稿原样保留 → 自动 delete
  const draftKept = clone(base);
  const incomingDeleted = clone(base);
  incomingDeleted.lights = incomingDeleted.lights.filter((l) => l.id !== 2);
  incomingDeleted.wiring = incomingDeleted.wiring.filter((w) => w.light_id !== 2);
  incomingDeleted.cues = incomingDeleted.cues.filter((c) => c.cue_no !== 2);
  const cls3 = Merge.classify(base, draftKept, incomingDeleted);
  assert.ok(cls3.auto.some((a) => a.key === 'light:2' && a.action === 'delete'));
});

test('同编号新增异值 → 冲突；同值则自动一致', () => {
  const base = baseSnapshot();
  const draft = clone(base);
  const incoming = clone(base);
  draft.lights.push({ id: 9, name: '新灯A' });
  draft.wiring.push({ light_id: 9, circuit_id: null, watts: null });
  incoming.lights.push({ id: 9, name: '新灯B' });
  incoming.wiring.push({ light_id: 9, circuit_id: null, watts: null });

  const cls = Merge.classify(base, draft, incoming);
  assert.equal(findConflict(cls, 'light:9')?.reason, 'same_key_diff');

  incoming.lights[incoming.lights.length - 1].name = '新灯A';
  const cls2 = Merge.classify(base, draft, incoming);
  assert.equal(findConflict(cls2, 'light:9'), null);
});

test('名称重名：待合入新增灯与草稿保留灯同名，冲突随两侧抉择标注', () => {
  const base = baseSnapshot(); // 灯1=面光1
  const draft = clone(base); // 草稿保留灯1
  const incoming = clone(base);
  incoming.lights.push({ id: 5, name: '面光1' }); // 新增灯5 与灯1同名
  incoming.wiring.push({ light_id: 5, circuit_id: null, watts: null });

  const cls = Merge.classify(base, draft, incoming);
  // 灯5 单侧新增本可自动，但合入草稿侧投影会与灯1重名 → 必须列为冲突
  const c5 = findConflict(cls, 'light:5');
  assert.ok(c5);
  assert.ok(c5.reasons.some((r) => r.code === 'name_collision'));
  // 灯1 自身也会带上重名违规提示
  assert.ok(findConflict(cls, 'light:1'));

  // 抉择草稿侧（不含灯5）→ 只剩原灯1，唯一，通过
  const rd = Merge.resolve(base, draft, incoming, { 'light:5': 'draft' });
  assert.equal(rd.ok, true);
  assert.equal(rd.final.lights.some((l) => l.id === 5), false);

  // 抉择待合入侧（灯5 进入）→ 与灯1重名，整次结果违规拒绝
  const ri = Merge.resolve(base, draft, incoming, { 'light:5': 'incoming', 'light:1': 'incoming' });
  assert.equal(ri.ok, false);
  assert.ok(ri.violations.some((v) => v.code === 'name_collision'));
});

test('Cue 引用缺失灯具：一侧删灯另一侧保留其 Cue 且改过 → 冲突', () => {
  const base = baseSnapshot();
  const draft = clone(base);
  // 草稿删除灯 1（连同 cue1）
  draft.lights = draft.lights.filter((l) => l.id !== 1);
  draft.wiring = draft.wiring.filter((w) => w.light_id !== 1);
  draft.cues = draft.cues.filter((c) => c.cue_no !== 1);
  const incoming = clone(base);
  // 待合入保留灯1 并修改 cue1
  incoming.cues[0].target = 100;

  const cls = Merge.classify(base, draft, incoming);
  // 灯1 是删除与修改并存；cue1 同样；并且选择待合入侧时引用闭合，选择草稿侧灯1消失但cue1也消失
  assert.ok(findConflict(cls, 'light:1'));
  assert.ok(findConflict(cls, 'cue:1'));

  // 选草稿：灯1/cue1 都不在，结果自洽
  const rd = Merge.resolve(base, draft, incoming, {
    'light:1': 'draft',
    'cue:1': 'draft',
  });
  assert.equal(rd.ok, true);
});

test('接线引用缺失回路：一侧删回路，另一侧接线改投它 → 冲突', () => {
  const base = baseSnapshot();
  const draft = clone(base);
  // 草稿删除回路1，灯1改未分配
  draft.circuits = [];
  draft.wiring[0] = { light_id: 1, circuit_id: null, watts: null };
  const incoming = clone(base);
  // 待合入保留回路1（未改名），但把灯2接到回路1
  incoming.wiring[1] = { light_id: 2, circuit_id: 1, watts: 120 };

  const cls = Merge.classify(base, draft, incoming);
  assert.ok(findConflict(cls, 'wiring:2')); // 接线单侧改但引用结果中可能缺失回路
  // 全选待合入：回路1 存在、灯2接线有效 → 通过
  const ri = Merge.resolve(base, draft, incoming, {
    'wiring:2': 'incoming',
    'circuit:1': 'incoming',
    'wiring:1': 'incoming',
  });
  assert.equal(ri.ok, true);
  assert.equal(ri.final.lights.find((l) => l.id === 2).circuit_id, 1);

  // 回路1 选草稿（删除）、灯2接线选待合入（指向回路1）→ 引用缺失，整次拒绝
  const rd = Merge.resolve(base, draft, incoming, {
    'wiring:2': 'incoming',
    'circuit:1': 'draft',
    'wiring:1': 'draft',
  });
  assert.equal(rd.ok, false);
  assert.ok(
    rd.violations.some((v) => v.key === 'wiring:2' && v.code === 'reference_missing')
  );
});

test('无效抉择 key / 取值 → 明确拒绝', () => {
  const base = baseSnapshot();
  const draft = clone(base);
  const incoming = clone(base);
  incoming.cues[0].target = 10;
  const r = Merge.resolve(base, draft, incoming, { 'cue:999': 'incoming' });
  assert.equal(r.ok, false);
  assert.equal(r.badResolutions.length, 1);
  assert.equal(r.badResolutions[0].key, 'cue:999');

  const r2 = Merge.resolve(base, draft, incoming, { 'cue:1': 'mine' });
  assert.equal(r2.ok, false);
  assert.ok(r2.badResolutions[0].reason.includes('draft'));
});

test('最终结果结构：灯具带出接线、集合完整', () => {
  const base = baseSnapshot();
  const draft = clone(base);
  draft.lights[0].name = '改名了';
  const incoming = clone(base);
  incoming.circuits[0].capacity = 3000;

  const r = Merge.resolve(base, draft, incoming, { 'light:1': 'draft' });
  assert.equal(r.ok, true);
  const l1 = r.final.lights.find((l) => l.id === 1);
  assert.equal(l1.name, '改名了');
  assert.equal(l1.circuit_id, 1);
  assert.equal(l1.watts, 300);
  assert.equal(r.final.circuits[0].capacity, 3000);
  assert.equal(r.final.cues.length, 2);
  assert.equal(r.final.wiring.length, 2);
});
