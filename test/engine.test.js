'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../public/engine.js');

const prepare = (rows) => Engine.prepareCues(rows);
const level = (rows, id, t) => Engine.brightnessAt(prepare(rows), id, t);
const approx = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !=~ ${expected}`);

test('无 Cue 时亮度为 0', () => {
  assert.equal(level([], 1, 5), 0);
});

test('线性渐变：0→100 用时 10 秒', () => {
  const cues = [{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }];
  assert.equal(level(cues, 1, 0), 0);      // 渐变起点仍是旧亮度 0
  approx(level(cues, 1, 2.5), 25);
  assert.equal(level(cues, 1, 5), 50);
  approx(level(cues, 1, 7.5), 75);
  assert.equal(level(cues, 1, 10), 100);   // 到达目标
  assert.equal(level(cues, 1, 20), 100);   // 结束后保持
});

test('渐变时长为 0 时瞬变', () => {
  const cues = [{ cue_no: 1, light_id: 1, time: 3, target: 80, duration: 0 }];
  approx(level(cues, 1, 2.999), 0);
  assert.equal(level(cues, 1, 3), 80);
});

test('新 Cue 在渐变中途接管：从当时实际亮度转向新目标', () => {
  const cues = [
    { cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }, // 0→100
    { cue_no: 2, light_id: 1, time: 5, target: 0, duration: 10 },   // t=5 实际 50 → 0
  ];
  approx(level(cues, 1, 4.9), 49);
  assert.equal(level(cues, 1, 5), 50);
  assert.equal(level(cues, 1, 10), 25);
  assert.equal(level(cues, 1, 15), 0);
});

test('同秒触发按 Cue 编号顺序依次生效（瞬变取最后者）', () => {
  const cues = [
    { cue_no: 2, light_id: 1, time: 2, target: 100, duration: 0 },
    { cue_no: 1, light_id: 1, time: 2, target: 0, duration: 0 },
  ];
  // 编号 1 先生效置 0，编号 2 后生效置 100
  assert.equal(level(cues, 1, 2), 100);
});

test('同秒两条渐变：编号小的先起步，编号大的从其实际亮度接管', () => {
  const cues = [
    { cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 },
    { cue_no: 2, light_id: 1, time: 0, target: 0, duration: 10 },
  ];
  // cue1 在 t=0 瞬间起点亮度为 0，cue2 随即从 0 转向 0，整场为 0
  assert.equal(level(cues, 1, 3), 0);
});

test('同秒先瞬变后渐变：渐变从瞬变后的目标亮度起步', () => {
  const cues = [
    { cue_no: 1, light_id: 1, time: 0, target: 80, duration: 0 },  // 先跳到 80
    { cue_no: 2, light_id: 1, time: 0, target: 100, duration: 10 }, // 再从 80 → 100
  ];
  assert.equal(level(cues, 1, 0), 80);
  approx(level(cues, 1, 5), 90);
  assert.equal(level(cues, 1, 10), 100);
});

test('亮度限制在 0～100（快照异常数据也被钳制）', () => {
  assert.equal(level([{ cue_no: 1, light_id: 1, time: 0, target: 150, duration: 0 }], 1, 0), 100);
  assert.equal(level([{ cue_no: 1, light_id: 1, time: 0, target: -20, duration: 0 }], 1, 0), 0);
});

test('多灯互不干扰，levelsAt 给出任意时刻全部灯亮度', () => {
  const cues = [
    { cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 },
    { cue_no: 2, light_id: 2, time: 0, target: 40, duration: 0 },
  ];
  const lights = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(Engine.levelsAt(prepare(cues), lights, 5), { 1: 50, 2: 40, 3: 0 });
});

test('showDuration 为最后一条渐变结束时刻', () => {
  const cues = [
    { cue_no: 1, light_id: 1, time: 2, target: 100, duration: 3 }, // end 5
    { cue_no: 2, light_id: 1, time: 4, target: 0, duration: 10 },  // end 14
  ];
  assert.equal(Engine.showDuration(prepare(cues)), 14);
  assert.equal(Engine.showDuration([]), 0);
});
