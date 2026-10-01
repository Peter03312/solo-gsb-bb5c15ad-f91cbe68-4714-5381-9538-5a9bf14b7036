'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../public/engine.js');

const prepare = (rows) => Engine.prepareCues(rows);
const diffs = (rowsA, rowsB, id, start, end, threshold) =>
  Engine.differenceIntervals(prepare(rowsA), prepare(rowsB), id, start, end, threshold);

const IV = (start, end, start_inclusive, end_inclusive) => ({
  start,
  end,
  start_inclusive,
  end_inclusive,
});

test('线性渐变超差阈值：交点精确为开端点，时窗右端闭合', () => {
  // A: 0→100 线性 10 秒；B: 恒 0。差值即 A 的亮度：t*10 > 40 ⇔ t > 4
  const a = [{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }];
  assert.deepEqual(diffs(a, [], 1, 0, 10, 40), [IV(4, 10, false, true)]);
});

test('阈值交点落在时窗内部：两端开/闭准确', () => {
  // 差值在时窗右端仍超差，右端点按时窗边界纳入
  const a = [{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }];
  assert.deepEqual(diffs(a, [], 1, 2, 8, 30), [IV(3, 8, false, true)]);
});

test('阈值为 0：亮度相等的瞬间（t=0）被排除', () => {
  // A: 0→50 用时 5 秒；B 恒 0。t>0 严格大于 0，t=0 相等
  const a = [{ cue_no: 1, light_id: 1, time: 0, target: 50, duration: 5 }];
  assert.deepEqual(diffs(a, [], 1, 0, 5, 0), [IV(0, 5, false, true)]);
});

test('瞬变：触发点纳入，区间从触发时刻闭区间开始', () => {
  // A 在 t=4 瞬变到 100 并保持；B 恒 0；阈值 50 → [4,10]
  const a = [{ cue_no: 1, light_id: 1, time: 4, target: 100, duration: 0 }];
  assert.deepEqual(diffs(a, [], 1, 0, 10, 50), [IV(4, 10, true, true)]);
});

test('触发点差恰好等于阈值：严格大于不成立，且右侧连续不超差 → 空', () => {
  // A 在 t=4 瞬变到 50（右侧恒 50）；B 在 t=4 从旧亮度 0 渐变到 50（右侧斜线）。
  // t<4 差 0；t=4 差 50（B 的渐变起点仍是旧亮度 0），阈值 50 时为相等而非严格大于；
  // t>4 差 50-12.5(t-4) < 50。故为空。
  const A = [{ cue_no: 1, light_id: 1, time: 4, target: 50, duration: 0 }];
  const B = [{ cue_no: 2, light_id: 1, time: 4, target: 50, duration: 4 }];
  assert.deepEqual(diffs(A, B, 1, 0, 8, 50), []);
  // 阈值 49.99：仅触发点与其右侧极小邻域超差，区间自触发点闭区间开始
  const got = diffs(A, B, 1, 0, 8, 49.99);
  assert.equal(got.length, 1);
  assert.equal(got[0].start, 4);
  assert.equal(got[0].start_inclusive, true);
  assert.ok(Math.abs(got[0].end - 4.0008) < 1e-9);
  assert.equal(got[0].end_inclusive, false);
});

test('到达目标的最后一瞬间等于阈值：不产生区间', () => {
  // A: 0→60 用时 6；B 恒 0；阈值 60：全程差 < 60，t=6 恰为 60 → 空
  const a = [{ cue_no: 1, light_id: 1, time: 0, target: 60, duration: 6 }];
  assert.deepEqual(diffs(a, [], 1, 0, 6, 60), []);
  // 阈值 59.999：交点 5.9999 开，右端 6 闭
  const got = diffs(a, [], 1, 0, 6, 59.999);
  assert.equal(got.length, 1);
  assert.ok(Math.abs(got[0].start - 5.9999) < 1e-9);
  assert.equal(got[0].start_inclusive, false);
  assert.equal(got[0].end_inclusive, true);
});

test('中途接管：接管转折点精确切分两段斜线', () => {
  // A: 0→100 用 10（t=0），t=5 时实际 50 接管渐变到 0 用 5；B 恒 0。
  // 差值：[0,5] 为 10t，[5,10] 为 100-10(t-5)=150-10t
  const a = [
    { cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 },
    { cue_no: 2, light_id: 1, time: 5, target: 0, duration: 5 },
  ];
  // 阈值 40：左段 10t>40 → t>4，右段 100-10t>40 → t<6，合并为 (4,6)
  assert.deepEqual(diffs(a, [], 1, 0, 10, 40), [IV(4, 6, false, false)]);
  // 阈值 60：左段最大 50、右段 t=5 时差 50，均不超 → 空
  assert.deepEqual(diffs(a, [], 1, 0, 10, 60), []);
});

test('同秒编号顺序不同：触发后的差异被准确捕获', () => {
  const a = [
    { cue_no: 1, light_id: 1, time: 2, target: 0, duration: 0 },
    { cue_no: 2, light_id: 1, time: 2, target: 100, duration: 0 },
  ];
  const b = [
    { cue_no: 1, light_id: 1, time: 2, target: 100, duration: 0 },
    { cue_no: 2, light_id: 1, time: 2, target: 0, duration: 0 },
  ];
  // 触发点 t=2 起 A=100/B=0 差 100 → [2,5]
  assert.deepEqual(diffs(a, b, 1, 0, 5, 50), [IV(2, 5, true, true)]);
  // 时窗右端恰在触发时刻：仅 t=2 一点超差 → 闭单点 [2,2]
  assert.deepEqual(diffs(a, b, 1, 0, 2, 50), [IV(2, 2, true, true)]);
  // 时窗完全位于触发之前：空
  assert.deepEqual(diffs(a, b, 1, 0, 1.9, 50), []);
});

test('两侧一升一降：|差| 产生两个不相连区间', () => {
  // A: 0→100 用 10；B: 先瞬变到 100 再渐变到 0 用 10。
  // 差 = |10t-(100-10t)| = |20t-100|，阈值 50 → t<2.5 或 t>7.5
  const a = [{ cue_no: 3, light_id: 1, time: 0, target: 100, duration: 10 }];
  const b = [
    { cue_no: 1, light_id: 1, time: 0, target: 100, duration: 0 },
    { cue_no: 2, light_id: 1, time: 0, target: 0, duration: 10 },
  ];
  assert.deepEqual(diffs(a, b, 1, 0, 10, 50), [
    IV(0, 2.5, true, false),
    IV(7.5, 10, false, true),
  ]);
});

test('尖点闭单点把左右开区间桥接为一个含端点的区间', () => {
  // A: 0→40 用 4；t=5 瞬变到 100 并保持。B: t=0 瞬变到 60 并保持。
  // [0,4]: 差 |10t-60|，超 30 当 t<3 → [0,3)
  // [4,5): 差 20 不超；t=5: 差 40 超（闭单点）；(5,10]: 差 40 超 → 桥接成 [5,10]
  const a = [
    { cue_no: 1, light_id: 1, time: 0, target: 40, duration: 4 },
    { cue_no: 2, light_id: 1, time: 5, target: 100, duration: 0 },
  ];
  const b = [{ cue_no: 1, light_id: 1, time: 0, target: 60, duration: 0 }];
  assert.deepEqual(diffs(a, b, 1, 0, 10, 30), [
    IV(0, 3, true, false),
    IV(5, 10, true, true),
  ]);
});

test('相同版本比较：无差异返回空区间', () => {
  const rows = [{ cue_no: 1, light_id: 1, time: 0, target: 80, duration: 3 }];
  assert.deepEqual(diffs(rows, rows, 1, 0, 10, 0), []);
});

test('零长度时窗（start===end）返回 []', () => {
  const a = [{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 0 }];
  assert.deepEqual(diffs(a, [], 1, 5, 5, 0), []);
});

test('阈值 100：亮度差不可能严格大于 100，恒为空', () => {
  const a = [{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 0 }];
  assert.deepEqual(diffs(a, [], 1, 0, 10, 100), []);
});

test('无 Cue 的两版恒灭：任意阈值都为空', () => {
  assert.deepEqual(diffs([], [], 1, 0, 100, 0), []);
});
