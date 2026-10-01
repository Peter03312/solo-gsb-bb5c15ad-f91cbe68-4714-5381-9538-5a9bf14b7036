'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../public/engine.js');

const IV = (start, end, start_inclusive, end_inclusive) => ({
  start,
  end,
  start_inclusive,
  end_inclusive,
});

const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !=~ ${b}`);

// 线性渐变：单灯 0→100 用 10 秒；200W；容量 150 → 负载 20t，超载当 t>7.5
function linearSetup() {
  const cues = Engine.prepareCues([{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }]);
  return { cues, by: new Map(), members: [{ light_id: 1, watts: 200 }], cap: 150 };
}

test('查看时刻负载 = 实际亮度/100×额定瓦数', () => {
  const { cues, by, members } = linearSetup();
  approx(Engine.circuitLoadAt(by, cues, members, 0), 0);
  approx(Engine.circuitLoadAt(by, cues, members, 3), 60);
  approx(Engine.circuitLoadAt(by, cues, members, 10), 200);
});

test('线性超载：交点精确、右端点按容量严格判定', () => {
  const { cues, by, members, cap } = linearSetup();
  assert.deepEqual(Engine.circuitOverloadIntervals(by, cues, members, 0, 10, cap), [
    IV(7.5, 10, false, true),
  ]);
  // 交点恰为时窗右端：严格大于不成立，右端不含；时窗整体不超时返回空
  assert.deepEqual(Engine.circuitOverloadIntervals(by, cues, members, 0, 7.5, cap), []);
  // 交点恰为时窗左端：左端不含
  assert.deepEqual(Engine.circuitOverloadIntervals(by, cues, members, 7.5, 10, cap), [
    IV(7.5, 10, false, true),
  ]);
  // 整窗都在容量以下
  assert.deepEqual(Engine.circuitOverloadIntervals(by, cues, members, 0, 7, cap), []);
  // 零长度时窗不产生区间
  assert.deepEqual(Engine.circuitOverloadIntervals(by, cues, members, 8, 8, cap), []);
});

test('容量恰好等于峰值：不超载', () => {
  const { cues, by, members } = linearSetup();
  assert.deepEqual(Engine.circuitOverloadIntervals(by, cues, members, 0, 10, 200), []);
  assert.equal(Engine.circuitLoadAt(by, cues, members, 10) > 200 + 1e-12, false);
});

test('多灯按瓦数加权汇总到同一回路', () => {
  // 灯1: 200W, 0→100 用10（20t）；灯2: 100W, t=4 瞬变到100（t≥4 加 100）
  const cues = Engine.prepareCues([
    { cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 },
    { cue_no: 2, light_id: 2, time: 4, target: 100, duration: 0 },
  ]);
  const members = [
    { light_id: 1, watts: 200 },
    { light_id: 2, watts: 100 },
  ];
  // 容量 150：t<4 负载 20t（最高 80，不超）；t=4 瞬变后 20t+100>150 恒超
  const ivs = Engine.circuitOverloadIntervals(new Map(), cues, members, 0, 10, 150);
  assert.deepEqual(ivs, [IV(4, 10, true, true)]);
  approx(Engine.circuitLoadAt(new Map(), cues, members, 4), 180);
});

test('未列入成员（未分配回路）的灯具不计入负载', () => {
  const cues = Engine.prepareCues([
    { cue_no: 1, light_id: 1, time: 0, target: 100, duration: 0 },
    { cue_no: 2, light_id: 2, time: 0, target: 100, duration: 0 },
  ]);
  const members = [{ light_id: 1, watts: 100 }]; // 灯2 未分配
  approx(Engine.circuitLoadAt(new Map(), cues, members, 5), 100);
});

test('归还融合形成二次负载：开口凹陷两侧超载，根精确排除，无需采样', () => {
  // 原版 10t；t=2 瞬变覆盖到 80 保持；t=4 归还 duration=4。
  // out(t)=2.5t²-30t+160（4≤t≤8），t=6 最低 70，两端 80。
  const base = Engine.prepareCues([{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }]);
  const ops = [
    { seq: 1, light_id: 1, time: 2, op_type: 'override', target: 80, duration: 0 },
    { seq: 2, light_id: 1, time: 4, op_type: 'return', duration: 4 },
  ];
  const by = Engine.prepareOverrides(ops, base);
  const members = [{ light_id: 1, watts: 200 }]; // 负载=2×亮度
  // 容量 145：亮度>72.5 超载，二次根恰为 t=5 与 t=7
  const ivs = Engine.circuitOverloadIntervals(by, base, members, 4, 8, 145);
  assert.deepEqual(ivs, [
    IV(4, 5, true, false),
    IV(7, 8, false, true),
  ]);
  approx(Engine.circuitLoadAt(by, base, members, 6), 140); // 谷底不超
  approx(Engine.circuitLoadAt(by, base, members, 5), 145); // 根处恰等于容量
});

test('二次凹陷的超载区间极窄时仍被精确捕获（固定步长采样会漏）', () => {
  // 取容量贴近端点值 160-ε：超载只发生在 t=4 与 t=8 附近的极短区间内，
  // 解析法必须给出两个非空区间，而非空集或被漏掉。
  const base = Engine.prepareCues([{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }]);
  const ops = [
    { seq: 1, light_id: 1, time: 2, op_type: 'override', target: 80, duration: 0 },
    { seq: 2, light_id: 1, time: 4, op_type: 'return', duration: 4 },
  ];
  const by = Engine.prepareOverrides(ops, base);
  const members = [{ light_id: 1, watts: 200 }];
  const ivs = Engine.circuitOverloadIntervals(by, base, members, 4, 8, 159.9);
  assert.equal(ivs.length, 2);
  assert.ok(ivs[0].start === 4 && ivs[0].end_inclusive === false);
  assert.ok(ivs[1].end === 8 && ivs[1].start_inclusive === false);
  assert.ok(ivs[0].end - ivs[0].start < 0.05); // 极短但真实存在
});

test('记录模式：覆盖/接管共同决定负载，接管不跳变', () => {
  const base = Engine.prepareCues([{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }]);
  // t=2 覆盖 20→80 用6；t=5 被接管，从当时实际 50 渐变到 0 用5
  const ops = [
    { seq: 1, light_id: 1, time: 2, op_type: 'override', target: 80, duration: 6 },
    { seq: 2, light_id: 1, time: 5, op_type: 'override', target: 0, duration: 5 },
  ];
  const by = Engine.prepareOverrides(ops, base);
  const members = [{ light_id: 1, watts: 100 }]; // 负载数值=亮度
  // [2,5): 20+10(t-2)，>40 当 t>4；[5,10): 50-10(t-5)，>40 当 t<6。
  // t=5 处连续为 50（闭单点），把两侧开区间桥接成 (4,6)，两端交点均不含。
  const ivs = Engine.circuitOverloadIntervals(by, base, members, 0, 12, 40);
  assert.deepEqual(ivs, [IV(4, 6, false, false)]);
  approx(Engine.circuitLoadAt(by, base, members, 5), 50);
  approx(Engine.circuitLoadAt(by, base, members, 6), 40);
});
