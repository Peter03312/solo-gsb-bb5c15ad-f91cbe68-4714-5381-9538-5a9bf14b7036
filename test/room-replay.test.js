'use strict';

/**
 * 共享房间复盘端到端测试（真实 HTTP + 临时 SQLite 库）：
 *  - 留存事件：创建、播放、暂停、跳转、改速、到末尾自动停住、关闭；
 *  - 每项含操作前后时码/速度/播放态与修订号，不记录控制密钥；
 *  - 失败或修订号过期的控制不留事件；
 *  - 自动停住事件的生效时刻为实际到达版本末尾的挂钟时刻；
 *  - 持密钥查询时间区间事件、任一点播放状态与逐灯亮度（暂停段不推进、跳转/改速边界接续）；
 *  - 查询只使用建房时版本快照：草稿修改与再发布不改变复盘结果；
 *  - 错误密钥 403、非法/越界时间 400、房间不存在 404；
 *  - 关闭后在线接口不可用，但原密钥仍可只读复盘；
 *  - 服务重启后复盘结果一致；既有房间从功能启用时的权威状态开始留存（snapshot 基线）。
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const PORT = 3927;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-replay-'));
const dbPath = path.join(tmpDir, `replay-test-${process.pid}.db`);

let server;
let procLog = '';

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'server.js')],
      {
        env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const onData = (chunk) => {
      procLog += chunk.toString();
      if (procLog.includes('已启动')) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited early: ${code}\n${procLog}`)));
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  if (res.status !== 204) data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const post = (p, b) => http('POST', p, b);
const get = (p) => http('GET', p);
const del = (p, b) => http('DELETE', p, b);

// 取房间复盘事件列表（持密钥）
async function events(c, k) {
  const r = await get(`/api/rooms/${c}/replay/events?key=${k}`);
  assert.equal(r.status, 200, `events fetch failed: ${JSON.stringify(r.data)}`);
  return r.data.events;
}

// 按类型取某类事件（多个时取最后一个）
async function eventOf(c, k, kind) {
  const es = await events(c, k);
  const found = es.filter((x) => x.kind === kind);
  assert.ok(found.length > 0, `缺少事件 ${kind}`);
  return found[found.length - 1];
}

// 墙上时钟（秒）
const wallSeconds = () => Date.now() / 1000;

before(async () => {
  server = await startServer();
});

after(async () => {
  await stopServer(server);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('共享房间复盘 HTTP API（端到端）', () => {
  let versionId;
  let code;
  let key;

  test('准备：灯具 + 0 秒起 10 秒线性渐变到 100 的版本（时长 10s）', async () => {
    const l = await post('/api/lights', { name: '复盘测试灯' });
    assert.equal(l.status, 201);
    await post('/api/cues', { light_id: l.data.id, time: 0, target: 100, duration: 10 });
    const pub = await post('/api/versions', { label: '复盘测试版' });
    assert.equal(pub.status, 201);
    versionId = pub.data.id;
    assert.equal(pub.data.cues.length, 1);
  });

  test('复盘接口鉴权：无密钥 403、错误密钥 403；房间不存在 404；房间码非法 404', async () => {
    const r = await post('/api/rooms', { version_id: versionId });
    assert.equal(r.status, 201);
    code = r.data.code;
    key = r.data.control_key;

    assert.equal((await get(`/api/rooms/${code}/replay/events`)).status, 403);
    assert.equal((await get(`/api/rooms/${code}/replay/state`)).status, 403);
    assert.equal((await get(`/api/rooms/${code}/replay/events?key=wrong`)).status, 403);
    assert.equal((await post(`/api/rooms/${code}/replay/state`, { key: 'wrong', at: 1 })).status, 403);
    assert.equal((await get('/api/rooms/NOROOM/replay/events?key=x')).status, 404);
    assert.equal((await get('/api/rooms/zz/replay/events?key=x')).status, 404);
  });

  test('事件响应不含控制密钥；创建后只有一条 open 事件（修订号 0）', async () => {
    const r = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.closed, false);
    assert.equal(r.data.control_key, undefined);
    assert.ok(!JSON.stringify(r.data).includes(key));
    assert.equal(r.data.events.length, 1);
    const e = r.data.events[0];
    assert.equal(e.kind, 'open');
    assert.equal(e.revision, 0);
    assert.equal(e.time_before, 0);
    assert.equal(e.time_after, 0);
    assert.equal(e.playing_before, false);
    assert.equal(e.playing_after, false);
    assert.equal(e.speed_before, 1);
    assert.equal(e.speed_after, 1);
    assert.equal(e.at_end_after, false);
  });

  test('播放后复盘：open→play；play 事件记录前后播放态与修订号 1', async () => {
    const r = await post(`/api/rooms/${code}/control`, { key, revision: 0, action: 'play' });
    assert.equal(r.status, 200);
    const playAt = r.data.anchor_at; // 服务端写入的播放锚点（权威事件边界）

    const ev = await events(code, key);
    const kinds = ev.map((x) => x.kind);
    assert.deepEqual(kinds, ['open', 'play']);
    const p = ev.find((x) => x.kind === 'play');
    assert.equal(p.revision, 1);
    assert.equal(p.time_before, 0);
    assert.equal(p.time_after, 0);
    assert.equal(p.playing_before, false);
    assert.equal(p.playing_after, true);
    assert.equal(p.speed_after, 1);

    // 播放中点位：时码按挂钟推进，逐灯亮度 = 时码×10（10s 渐变 0→100）
    const at = playAt + 0.4;
    const st = await get(`/api/rooms/${code}/replay/state?key=${key}&at=${at}`);
    assert.equal(st.status, 200);
    assert.equal(st.data.state.playing, true);
    assert.ok(Math.abs(st.data.state.time - 0.4) < 0.05, `time=${st.data.state.time}`);
    assert.ok(Math.abs(st.data.levels[0].brightness - 4) < 0.6, `brightness=${st.data.levels[0].brightness}`);
  });

  test('暂停后复盘：暂停段时码不推进、亮度冻结', async () => {
    await sleep(400); // 保证有可见的播放时长再暂停
    const pauseResp = await post(`/api/rooms/${code}/control`, { key, revision: 1, action: 'pause' });
    assert.equal(pauseResp.status, 200);
    const frozenTime = pauseResp.data.time;
    assert.ok(frozenTime > 0.3 && frozenTime < 1.2, `frozen=${frozenTime}`);

    const p = await eventOf(code, key, 'pause');
    assert.equal(p.revision, 2);
    assert.equal(p.playing_before, true);
    assert.equal(p.playing_after, false);
    assert.ok(Math.abs(p.time_before - frozenTime) < 1e-6);
    assert.ok(Math.abs(p.time_after - frozenTime) < 1e-6);

    await sleep(300);
    const st = await get(`/api/rooms/${code}/replay/state?key=${key}`);
    assert.equal(st.data.state.playing, false);
    assert.ok(Math.abs(st.data.state.time - frozenTime) < 1e-6);
    assert.ok(Math.abs(st.data.levels[0].brightness - frozenTime * 10) < 1e-4);
  });

  test('跳转事件：time_before 为跳转前时码、time_after 为目标时码；跳转后暂停接续', async () => {
    const r = await post(`/api/rooms/${code}/control`, {
      key, revision: 2, action: 'seek', time: 5,
    });
    assert.equal(r.status, 200);

    const s = await eventOf(code, key, 'seek');
    assert.equal(s.revision, 3);
    assert.equal(s.time_after, 5);
    assert.ok(s.time_before > 0.3 && s.time_before < 1.2);
    assert.equal(s.playing_after, false);
    assert.equal(s.at_end_after, false);

    // 查询时刻取在本条测试内（后续改速事件尚未产生）：暂停段时码冻结在 5
    const st = await get(`/api/rooms/${code}/replay/state?key=${key}&at=${s.at + 0.02}`);
    assert.ok(Math.abs(st.data.state.time - 5) < 1e-6);
    assert.ok(Math.abs(st.data.levels[0].brightness - 50) < 1e-6);
  });

  test('改速事件：从事件边界接续（改速不跳变），之后按新速度推进', async () => {
    const sp = await post(`/api/rooms/${code}/control`, {
      key, revision: 3, action: 'speed', speed: 2,
    });
    assert.equal(sp.status, 200);
    assert.equal(sp.data.time, 5);

    const s = await eventOf(code, key, 'speed');
    assert.equal(s.revision, 4);
    assert.equal(s.speed_before, 1);
    assert.equal(s.speed_after, 2);
    assert.equal(s.time_before, 5);
    assert.equal(s.time_after, 5);
    assert.equal(s.playing_after, false);

    // 播放后从 5 开始按 2× 推进
    const pl = await post(`/api/rooms/${code}/control`, { key, revision: 4, action: 'play' });
    assert.equal(pl.status, 200);
    const playWall = pl.data.anchor_at;

    const st = await get(
      `/api/rooms/${code}/replay/state?key=${key}&at=${playWall + 0.5}`
    );
    assert.equal(st.data.state.playing, true);
    assert.equal(st.data.state.speed, 2);
    assert.ok(Math.abs(st.data.state.time - 6) < 0.08, `time=${st.data.state.time}`);
    assert.ok(Math.abs(st.data.levels[0].brightness - 60) < 1, `b=${st.data.levels[0].brightness}`);
  });

  test('失败与修订号过期的控制不留事件', async () => {
    // 先暂停，房间稳定在修订号 6
    const d0 = await get(`/api/rooms/${code}`);
    const pause = await post(`/api/rooms/${code}/control`, {
      key, revision: d0.data.revision, action: 'pause',
    });
    assert.equal(pause.status, 200);
    const rev = pause.data.revision;

    // 非法时码 / 非法速度：400，无事件
    assert.equal(
      (await post(`/api/rooms/${code}/control`, { key, revision: rev, action: 'seek', time: -1 })).status,
      400
    );
    assert.equal(
      (await post(`/api/rooms/${code}/control`, { key, revision: rev, action: 'speed', speed: 3 })).status,
      400
    );
    // 过期修订号：409，无事件
    assert.equal(
      (await post(`/api/rooms/${code}/control`, { key, revision: rev - 1, action: 'pause' })).status,
      409
    );
    // 错误密钥：403，无事件
    assert.equal(
      (await post(`/api/rooms/${code}/control`, { key: 'nope', revision: rev, action: 'pause' })).status,
      403
    );

    const ev = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    assert.equal(ev.data.events[ev.data.events.length - 1].revision, rev);
    assert.ok(!ev.data.events.some((x) => x.revision > rev));
  });

  test('到末尾自动停住：事件生效时刻为实际到达末尾的挂钟时刻（不是查询落库时刻）', async () => {
    // 跳转到 9，再以 2× 播放：0.5 挂钟秒后到达 10
    let rev = (await get(`/api/rooms/${code}`)).data.revision;
    const seek = await post(`/api/rooms/${code}/control`, {
      key, revision: rev, action: 'seek', time: 9,
    });
    rev = seek.data.revision;
    const play = await post(`/api/rooms/${code}/control`, {
      key, revision: rev, action: 'play',
    });
    assert.equal(play.status, 200);
    const playWall = play.data.anchor_at;
    const expectedStop = playWall + 0.5;

    // 在实际停住之后再等一会才查询：auto_stop 的 at 仍应是实际到末尾时刻
    await sleep(900);
    const ev = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    const stop = ev.data.events.find((x) => x.kind === 'auto_stop');
    assert.ok(stop, '应有 auto_stop 事件');
    assert.equal(stop.time_before, 10);
    assert.equal(stop.time_after, 10);
    assert.equal(stop.playing_before, true);
    assert.equal(stop.playing_after, false);
    assert.equal(stop.at_end_before, false);
    assert.equal(stop.at_end_after, true);
    assert.ok(Math.abs(stop.at - expectedStop) < 0.15, `auto_stop at=${stop.at} expected~${expectedStop}`);
    assert.ok(stop.at < wallSeconds() - 0.3, 'auto_stop 时刻应早于本次查询落库时刻');

    // 自动停住后复盘末尾点（取停住后、当前时刻之前的一点）：时码 10、不播放、亮度 100
    const stAt = Math.min(stop.at + 0.3, wallSeconds() - 0.05);
    const st = await get(`/api/rooms/${code}/replay/state?key=${key}&at=${stAt}`);
    assert.equal(st.status, 200, JSON.stringify(st.data));
    assert.equal(st.data.state.time, 10);
    assert.equal(st.data.state.playing, false);
    assert.equal(st.data.state.at_end, true);
    assert.equal(st.data.levels[0].brightness, 100);

    // 到末尾瞬间之前的一点：仍在播放且时码 < 10
    const justBefore = await get(`/api/rooms/${code}/replay/state?key=${key}&at=${stop.at - 0.1}`);
    assert.equal(justBefore.status, 200, JSON.stringify(justBefore.data));
    assert.equal(justBefore.data.state.playing, true);
    assert.ok(justBefore.data.state.time < 10);
    assert.ok(Math.abs(justBefore.data.state.time - 9.8) < 0.05);
  });

  test('事件按服务端时间排序；同刻按修订号定序（open 与紧随其后的控制顺序正确）', async () => {
    const ev = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    const es = ev.data.events;
    for (let i = 1; i < es.length; i++) {
      assert.ok(
        es[i - 1].at < es[i].at ||
          (es[i - 1].at === es[i].at && es[i - 1].revision <= es[i].revision),
        `事件顺序错误 @${i}`
      );
      assert.equal(es[i].revision, es[i - 1].revision + 1, '控制事件修订号连续');
    }
  });

  test('时间区间查询：start/end 过滤，区间端点包含；非法/越界明确拒绝', async () => {
    const all = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    const es = all.data.events;
    const playEv = es.find((x) => x.kind === 'play');
    const pauseEv = es.find((x) => x.kind === 'pause');

    const win = await get(
      `/api/rooms/${code}/replay/events?key=${key}&start=${playEv.at}&end=${pauseEv.at}`
    );
    assert.equal(win.status, 200);
    assert.ok(win.data.events.every((x) => x.at >= playEv.at - 1e-9 && x.at <= pauseEv.at + 1e-9));
    assert.ok(win.data.events.some((x) => x.kind === 'play'));
    assert.ok(win.data.events.some((x) => x.kind === 'pause'));

    const retainedFrom = all.data.retained_from;
    const early = await get(`/api/rooms/${code}/replay/events?key=${key}&start=${retainedFrom - 10}`);
    assert.equal(early.status, 400);
    assert.match(early.data.error, /早于房间留存起点/);

    const badOrder = await get(
      `/api/rooms/${code}/replay/events?key=${key}&start=${pauseEv.at}&end=${playEv.at}`
    );
    assert.equal(badOrder.status, 400);

    const nonNum = await get(`/api/rooms/${code}/replay/events?key=${key}&start=abc`);
    assert.equal(nonNum.status, 400);

    // 在线房间允许查未来区间（此刻尚无事件，返回空数组），不报错
    const futureEvents = await get(
      `/api/rooms/${code}/replay/events?key=${key}&start=9999990000&end=9999999999`
    );
    assert.equal(futureEvents.status, 200);
    assert.deepEqual(futureEvents.data.events, []);
    assert.equal(futureEvents.data.window.end, 9999999999);
  });

  test('状态查询：早于留存起点 → 400；在线房间未来时刻按当前段线性外推；缺省 at 为当前时刻', async () => {
    const r = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    const from = r.data.retained_from;

    const early = await get(`/api/rooms/${code}/replay/state?key=${key}&at=${from - 1}`);
    assert.equal(early.status, 400);
    assert.match(early.data.error, /早于房间留存起点/);

    // 在线房间：极远的未来不报错，按当前播放段外推并停在版本末尾（10s）
    const future = await get(`/api/rooms/${code}/replay/state?key=${key}&at=9999999999`);
    assert.equal(future.status, 200);
    assert.equal(future.data.state.time, 10);
    assert.equal(future.data.state.at_end, true);
    assert.equal(future.data.state.playing, false);

    const now = await get(`/api/rooms/${code}/replay/state?key=${key}`);
    assert.equal(now.status, 200);
    assert.ok(Math.abs(now.data.at - now.data.server_now) < 0.1);
    assert.equal(now.data.state.time, 10); // 当前停在末尾
  });

  test('复盘只使用建房时版本快照：之后改草稿、发新版，复盘亮度/时长不变', async () => {
    // 取首个播放段（open 后第一条 play 与随后 pause 之间）的中点，保证复盘的是当时的播放过程
    const ev0 = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    const firstPlay = ev0.data.events.find((x) => x.kind === 'play');
    const firstPause = ev0.data.events.find((x) => x.kind === 'pause');
    const midPlay = (firstPlay.at + firstPause.at) / 2;
    const expectedTimecode = midPlay - firstPlay.at;

    // 草稿新增完全不同的 Cue，再发布新版本
    const lights = (await get('/api/lights')).data;
    await post('/api/cues', { light_id: lights[0].id, time: 0, target: 0, duration: 0 });
    await post('/api/versions', { label: '复盘测试二版' });

    const st = await get(`/api/rooms/${code}/replay/state?key=${key}&at=${midPlay}`);
    assert.equal(st.data.duration, 10);
    assert.equal(st.data.version.id, versionId);
    // 仍按建房时的旧快照：亮度随当时播放时码走（0→100/10s），而非新草稿的瞬变到 0
    assert.ok(Math.abs(st.data.levels[0].brightness - expectedTimecode * 10) < 0.1);
  });

  test('POST body 方式调用复盘接口同样可用', async () => {
    const r = await post(`/api/rooms/${code}/replay/events`, { key });
    assert.equal(r.status, 200);
    assert.ok(r.data.events.length >= 2);
    // 取 seek 到 5 与随后改速之间的中点：该点暂停在 5
    const seekEv = r.data.events.find((x) => x.kind === 'seek' && x.time_after === 5);
    const next = r.data.events.find((x) => x.at > seekEv.at);
    const at = (seekEv.at + next.at) / 2;
    const s = await post(`/api/rooms/${code}/replay/state`, { key, at });
    assert.equal(s.status, 200);
    assert.equal(s.data.state.time, 5);
  });

  test('服务重启后：事件流与任一点复盘结果完全一致', async () => {
    const before = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    // 取样点落在改速后播放段（speed=2 的 play 与 auto_stop 之间），避免落入后续其它事件边界
    const plays = before.data.events.filter((x) => x.kind === 'play');
    const playAt2x = plays[plays.length - 1].at;
    const stopEv = before.data.events.find((x) => x.kind === 'auto_stop');
    const sampleAt = playAt2x + Math.min(0.2, (stopEv.at - playAt2x) / 2);
    const stateBefore = await get(`/api/rooms/${code}/replay/state?key=${key}&at=${sampleAt}`);

    await stopServer(server);
    await sleep(300);
    server = await startServer();

    const after = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    assert.deepEqual(
      after.data.events.map((x) => [x.kind, x.at, x.revision, x.time_before, x.time_after]),
      before.data.events.map((x) => [x.kind, x.at, x.revision, x.time_before, x.time_after])
    );
    const stateAfter = await get(`/api/rooms/${code}/replay/state?key=${key}&at=${sampleAt}`);
    assert.equal(stateAfter.data.state.time, stateBefore.data.state.time);
    assert.equal(stateAfter.data.levels[0].brightness, stateBefore.data.levels[0].brightness);
  });

  test('关闭后：在线接口 404、不可控制，但原密钥仍可只读复盘', async () => {
    assert.equal((await del(`/api/rooms/${code}`, { key: 'nope' })).status, 403);
    assert.equal((await del(`/api/rooms/${code}`, { key })).status, 204);

    // 观看与控制都不可用
    assert.equal((await get(`/api/rooms/${code}`)).status, 404);
    assert.ok(!(await get('/api/rooms')).data.some((x) => x.code === code));
    assert.equal(
      (await post(`/api/rooms/${code}/control`, { key, revision: 99, action: 'play' })).status,
      404
    );
    // 重复关闭也是 404
    assert.equal((await del(`/api/rooms/${code}`, { key })).status, 404);

    // 原密钥只读复盘仍可用
    const ev = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    assert.equal(ev.status, 200);
    assert.equal(ev.data.closed, true);
    assert.ok(typeof ev.data.closed_at === 'number');
    const kinds = ev.data.events.map((x) => x.kind);
    assert.equal(kinds[kinds.length - 1], 'close');
    const close = ev.data.events[kinds.length - 1];
    assert.equal(close.playing_before, false); // 关闭前已停在末尾
    assert.equal(close.playing_after, false);
    assert.equal(close.time_after, 10);

    // 缺省 at = 关闭时刻：冻结在关闭瞬间
    const st = await get(`/api/rooms/${code}/replay/state?key=${key}`);
    assert.equal(st.status, 200);
    assert.equal(st.data.closed, true);
    assert.equal(st.data.state.frozen, true);
    assert.equal(st.data.state.time, 10);
    assert.equal(st.data.levels[0].brightness, 100);

    // 关闭时刻之后不可查（关闭房间范围固定，不容忍时钟偏差）
    assert.equal(
      (await get(`/api/rooms/${code}/replay/state?key=${key}&at=${ev.data.closed_at + 5}`)).status,
      400
    );
    // 关闭时刻（边界）可查
    assert.equal(
      (await get(`/api/rooms/${code}/replay/state?key=${key}&at=${ev.data.closed_at}`)).status,
      200
    );
  });

  test('关闭进行中（播放中）的房间：close 冻结当前时码与播放前态', async () => {
    const r = await post('/api/rooms', { version_id: versionId });
    const c = r.data.code;
    const k = r.data.control_key;
    await post(`/api/rooms/${c}/control`, { key: k, revision: 0, action: 'seek', time: 4 });
    await post(`/api/rooms/${c}/control`, { key: k, revision: 1, action: 'play' });
    await sleep(300);
    assert.equal((await del(`/api/rooms/${c}`, { key: k })).status, 204);

    const ev = await get(`/api/rooms/${c}/replay/events?key=${k}`);
    const close = ev.data.events.find((x) => x.kind === 'close');
    assert.equal(close.playing_before, true);
    assert.equal(close.playing_after, false);
    assert.ok(close.time_after > 4 && close.time_after < 6, `frozen=${close.time_after}`);
    assert.equal(close.time_before, close.time_after);
    // 关闭不推进修订号
    const prior = ev.data.events.filter((x) => x.seq < close.seq);
    assert.equal(close.revision, prior[prior.length - 1].revision);
  });
});

describe('既有房间的复盘留存起点（迁移 snapshot 基线）', () => {
  const LEGACY_PORT = 3928;
  const LEGACY_BASE = `http://127.0.0.1:${LEGACY_PORT}`;
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-legacy-'));
  const legacyDb = path.join(legacyDir, 'legacy.db');
  let child;
  let log = '';

  function startLegacy() {
    return new Promise((resolve, reject) => {
      child = spawn(
        process.execPath,
        [path.join(__dirname, '..', 'server.js')],
        {
          env: { ...process.env, PORT: String(LEGACY_PORT), DB_PATH: legacyDb, NODE_ENV: 'test' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      const onData = (chunk) => {
        log += chunk.toString();
        if (log.includes('已启动')) resolve();
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code2) => reject(new Error(`legacy server exited: ${code2}\n${log}`)));
    });
  }

  test('旧库房间（无 room_events）启动后仅从启用时权威状态起留存，不推测更早操作', async () => {
    // 手工构造旧结构库：版本 + 一个暂停在 3s、2 倍速、修订号 5 的房间
    const d = new Database(legacyDb);
    d.exec(`
      CREATE TABLE versions (id INTEGER PRIMARY KEY, label TEXT, created_at REAL, cue_count INTEGER);
      INSERT INTO versions VALUES (1,'旧版',1000,0);
      CREATE TABLE rooms (
        id INTEGER PRIMARY KEY, code TEXT UNIQUE, control_key TEXT, version_id INTEGER,
        duration REAL, playing INTEGER, base_time REAL, speed REAL, anchor_at REAL,
        at_end INTEGER, revision INTEGER, created_at REAL
      );
      INSERT INTO rooms
        (id,code,control_key,version_id,duration,playing,base_time,speed,anchor_at,at_end,revision,created_at)
      VALUES (1,'LEGACY','legacykey99',1,10,0,3.0,2,1000,0,5,1000);
    `);
    d.close();

    await startLegacy();

    const res = await fetch(`${LEGACY_BASE}/api/rooms/LEGACY/replay/events?key=legacykey99`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.events.length, 1);
    const e = body.events[0];
    assert.equal(e.kind, 'snapshot');
    assert.equal(e.revision, 5);
    assert.equal(e.time_after, 3);
    assert.equal(e.speed_after, 2);
    assert.equal(e.playing_after, false);
    // 留存起点即迁移时刻；其之前不可查（不推测更早操作）
    const early = await fetch(`${LEGACY_BASE}/api/rooms/LEGACY/replay/state?key=legacykey99&at=1001`);
    assert.equal(early.status, 400);
    assert.match((await early.json()).error, /早于房间留存起点/);

    const st = await fetch(`${LEGACY_BASE}/api/rooms/LEGACY/replay/state?key=legacykey99`);
    const sj = await st.json();
    assert.equal(sj.state.time, 3);
    assert.equal(sj.state.revision, 5);

    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });
});
