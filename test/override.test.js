'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../public/engine.js');

const approx = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !=~ ${expected}`);

// 原版：#1 在 t=0 从 0 线性渐变到 100，用时 10 秒（原版亮度即 10t）
function base1() {
  return Engine.prepareCues([{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }]);
}
const at = (ops, base, t, id = 1) =>
  Engine.overrideBrightnessAt(Engine.prepareOverrides(ops, base), base, id, t);
const prep = (ops, base) => Engine.prepareOverrides(ops, base);

test('无操作时完全等于原版亮度', () => {
  const base = base1();
  for (const t of [0, 3, 7.5, 10, 20]) approx(at([], base, t), t <= 10 ? 10 * t : 100);
});

test('覆盖：从操作瞬间实际输出渐变到目标，此后保持；0 秒立即生效', () => {
  const base = base1();
  // t=2 实际 20 → 80 用 6 秒：20 + 10(t-2)
  approx(at([{ seq: 1, light_id: 1, time: 2, op_type: 'override', target: 80, duration: 6 }], base, 2), 20);
  approx(at([{ seq: 1, light_id: 1, time: 2, op_type: 'override', target: 80, duration: 6 }], base, 5), 50);
  assert.equal(at([{ seq: 1, light_id: 1, time: 2, op_type: 'override', target: 80, duration: 6 }], base, 8), 80);
  assert.equal(at([{ seq: 1, light_id: 1, time: 2, op_type: 'override', target: 80, duration: 6 }], base, 20), 80);
  // 0 秒覆盖立即生效
  assert.equal(at([{ seq: 1, light_id: 1, time: 3, op_type: 'override', target: 40, duration: 0 }], base, 3), 40);
  approx(at([{ seq: 1, light_id: 1, time: 3, op_type: 'override', target: 40, duration: 0 }], base, 2.9), 29);
});

test('覆盖保持阶段无视原版继续运行（原版仍在后台但不接管）', () => {
  const base = base1();
  const ops = [{ seq: 1, light_id: 1, time: 1, op_type: 'override', target: 30, duration: 0 }];
  assert.equal(at(ops, base, 5), 30); // 原版此刻 50，覆盖仍保持 30
  assert.equal(at(ops, base, 10), 30);
});

test('归还：以实际输出为起点按进度与持续变化的原版亮度线性融合，结束后完全跟随原版', () => {
  const base = base1();
  // t=4 实际 40，时长 4：out=(1-k)*40 + k*10t
  const ops = [{ seq: 1, light_id: 1, time: 4, op_type: 'return', duration: 4 }];
  approx(at(ops, base, 4), 40);
  // t=5 k=.25：.75*40 + .25*50 = 42.5
  approx(at(ops, base, 5), 42.5);
  // t=6 k=.5：.5*40 + .5*60 = 50
  approx(at(ops, base, 6), 50);
  approx(at(ops, base, 8), 80);
  assert.equal(at(ops, base, 9), 90); // 结束后跟随原版
  assert.equal(at(ops, base, 10), 100);
});

test('0 秒归还立即生效：从操作瞬间起完全跟随原版', () => {
  const base = base1();
  const ops = [
    { seq: 1, light_id: 1, time: 2, op_type: 'override', target: 80, duration: 6 },
    { seq: 2, light_id: 1, time: 4, op_type: 'return', duration: 0 },
  ];
  assert.equal(at(ops, base, 4), 40); // 立即归还到原版此刻 40
  assert.equal(at(ops, base, 7), 70);
});

test('下一操作接管未完成的渐变：起点取接管瞬间实际输出', () => {
  const base = base1();
  const ops = [
    { seq: 1, light_id: 1, time: 2, op_type: 'override', target: 80, duration: 6 }, // 20→80
    { seq: 2, light_id: 1, time: 5, op_type: 'override', target: 0, duration: 5 },  // t=5 实际 50 → 0
  ];
  approx(at(ops, base, 4.9), 49);
  assert.equal(at(ops, base, 5), 50);
  assert.equal(at(ops, base, 7.5), 25);
  assert.equal(at(ops, base, 10), 0);
  assert.equal(at(ops, base, 12), 0);
});

test('覆盖渐变中被归还接管：融合起点为接管瞬间实际输出，向原版靠拢', () => {
  const base = base1();
  const ops = [
    { seq: 1, light_id: 1, time: 2, op_type: 'override', target: 80, duration: 6 }, // t=5 时实际 50
    { seq: 2, light_id: 1, time: 5, op_type: 'return', duration: 5 },     // 50 与 10t 融合
  ];
  assert.equal(at(ops, base, 5), 50);
  // t=7.5 k=.5：.5*50 + .5*75 = 62.5
  approx(at(ops, base, 7.5), 62.5);
  assert.equal(at(ops, base, 10), 100); // 归还结束，跟随原版
  assert.equal(at(ops, base, 11), 100);
});

test('同秒操作按追加顺序（seq）生效：0 秒覆盖后 0 秒归还', () => {
  const base = base1();
  const ops = [
    { seq: 1, light_id: 1, time: 3, op_type: 'override', target: 90, duration: 0 },
    { seq: 2, light_id: 1, time: 3, op_type: 'return', duration: 0 },
  ];
  assert.equal(at(ops, base, 3), 30); // 归还立即生效 → 原版此刻 30
  assert.equal(at(ops, base, 4), 40);
  // 倒序提交（seq 2 在前）结果仍由 seq 决定
  const opsReversed = [ops[1], ops[0]];
  assert.equal(at(opsReversed, base, 3), 30);
});

test('同秒：非 0 秒覆盖紧跟 0 秒覆盖，从已生效目标起步', () => {
  const base = base1();
  const ops = [
    { seq: 1, light_id: 1, time: 3, op_type: 'override', target: 0, duration: 0 },
    { seq: 2, light_id: 1, time: 3, op_type: 'override', target: 100, duration: 10 },
  ];
  assert.equal(at(ops, base, 3), 0); // 渐变起点即 0（0 秒覆盖已置 0）
  assert.equal(at(ops, base, 8), 50);
});

test('多灯互不干扰；overrideLevelsAt 给出逐灯实际输出', () => {
  const base = Engine.prepareCues([
    { cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 },
    { cue_no: 2, light_id: 2, time: 0, target: 60, duration: 0 },
  ]);
  const ops = [
    { seq: 1, light_id: 1, time: 2, op_type: 'override', target: 0, duration: 0 },
  ];
  const byLight = prep(ops, base);
  assert.deepEqual(Engine.overrideLevelsAt(byLight, base, [{ id: 1 }, { id: 2 }, { id: 3 }], 5), {
    1: 0,   // 被覆盖保持在 0
    2: 60,  // 未操作，跟随原版
    3: 0,   // 快照中无 Cue
  });
});

test('activeOverride 正确标注覆盖中/归还融合中/跟随原版', () => {
  const base = base1();
  const ops = [
    { seq: 1, light_id: 1, time: 2, op_type: 'override', target: 80, duration: 6 },
    { seq: 2, light_id: 1, time: 8, op_type: 'return', duration: 2 },
  ];
  const byLight = prep(ops, base);
  assert.equal(Engine.activeOverride(byLight, 1, 1), null);
  assert.equal(Engine.activeOverride(byLight, 1, 5).state, 'override');
  assert.equal(Engine.activeOverride(byLight, 1, 7).state, 'override'); // 覆盖保持
  assert.equal(Engine.activeOverride(byLight, 1, 9).state, 'return');
  assert.equal(Engine.activeOverride(byLight, 1, 10), null); // 归还结束
});
