'use strict';

/**
 * 共享房间复盘端到端测试：启动真实 HTTP 服务（临时 SQLite 库），验证
 *  - 房间从创建起留存生效事件（播放/暂停/跳转/改速/自动停住/关闭），含操作前后时码、
 *    速度、播放态与修订号，不含控制密钥；
 *  - 事件按服务端时间、同一时刻按修订号定序；
 *  - 可查询时间区间事件，以及留存起点到关闭/当前任一点的播放状态与逐灯亮度
 *    （暂停段时码不推进、跳转/改速从事件边界接续、自动停住发生在到达末尾的实际时刻）；
 *  - 复盘只使用建房时固定版本快照（草稿修改/新版发布不影响）；
 *  - 错误密钥、非法或越界时间明确拒绝；失败或修订号过期的控制不留事件；
 *  - 关闭后直播接口 404，但原密钥仍可只读复盘；
 *  - 服务重启后事件留存不变；既有房间从功能启用时的权威状态开始留存。
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3918;
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
  let timestamps = {};

  test('准备：灯具 + 10 秒线性渐变版本', async () => {
    const l = await post('/api/lights', { name: '复盘测试灯1' });
    await post('/api/cues', [{ light_id: l.data.id, time: 0, target: 100, duration: 10 }]);
    const pub = await post('/api/versions', { label: '复盘测试首版' });
    versionId = pub.data.id;
  });

  test('创建房间即留存 create 事件（修订号 0，事件不含密钥）', async () => {
    const r = await post('/api/rooms', { version_id: versionId });
    assert.equal(r.status, 201);
    code = r.data.code;
    key = r.data.control_key;
    timestamps.create = Date.now() / 1000;

    const noKey = await get(`/api/rooms/${code}/replay/events`);
    assert.equal(noKey.status, 403);
    const wrongKey = await get(`/api/rooms/${code}/replay/events?key=nope`);
    assert.equal(wrongKey.status, 403);

    const ev = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    assert.equal(ev.status, 200);
    assert.equal(ev.data.events.length, 1);
    const e0 = ev.data.events[0];
    assert.equal(e0.type, 'create');
    assert.equal(e0.before, null);
    assert.equal(e0.after.time, 0);
    assert.equal(e0.after.playing, false);
    assert.equal(e0.after.speed, 1);
    assert.equal(e0.after.revision, 0);
    assert.equal(e0.revision_after, 0);
    assert.equal(e0.key, undefined);
    assert.equal(e0.control_key, undefined);
    assert.ok(Math.abs(ev.data.retained_from - e0.at_server) < 1e-6);
  });

  test('复盘概览：留存范围、版本、关闭状态', async () => {
    const m = await get(`/api/rooms/${code}/replay?key=${key}`);
    assert.equal(m.status, 200);
    assert.equal(m.data.closed, false);
    assert.equal(m.data.closed_at, null);
    assert.equal(m.data.version.id, versionId);
    assert.equal(m.data.duration, 10);
    assert.equal(m.data.event_count, 1);
    assert.ok(m.data.retained_until >= m.data.retained_from);
  });

  test('播放/暂停：留存事件且操作前后状态正确', async () => {
    const play = await post(`/api/rooms/${code}/control`, { action: 'play', key, revision: 0 });
    assert.equal(play.status, 200);
    assert.equal(play.data.revision, 1);
    await sleep(500);
    timestamps.pause = Date.now() / 1000;
    const pause = await post(`/api/rooms/${code}/control`, {
      action: 'pause',
      key,
      revision: 1,
    });
    assert.equal(pause.status, 200);
    const frozen = pause.data.time;
    assert.ok(frozen > 0.3 && frozen < 0.9, `frozen=${frozen}`);

    const ev = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    const types = ev.data.events.map((e) => e.type);
    assert.deepEqual(types, ['create', 'play', 'pause']);
    const pe = ev.data.events[1];
    assert.equal(pe.before.playing, false);
    assert.equal(pe.after.playing, true);
    assert.equal(pe.before.revision, 0);
    assert.equal(pe.after.revision, 1);
    const pu = ev.data.events[2];
    assert.equal(pu.before.playing, true);
    assert.equal(pu.after.playing, false);
    assert.ok(Math.abs(pu.after.time - frozen) < 1e-6);
    // 事件按 at_server 升序、同一时刻按修订号升序
    for (let i = 1; i < ev.data.events.length; i++) {
      const a = ev.data.events[i - 1];
      const b = ev.data.events[i];
      assert.ok(
        b.at_server > a.at_server ||
          (Math.abs(b.at_server - a.at_server) < 1e-6 && b.revision_after > a.revision_after)
      );
    }
    timestamps.frozen = frozen;
  });

  test('失败控制不留事件：非法动作 400、过期修订号 409 后事件数不变', async () => {
    const before = (await get(`/api/rooms/${code}/replay/events?key=${key}`)).data.events.length;
    assert.equal(
      (await post(`/api/rooms/${code}/control`, { action: 'warp', key, revision: 2 })).status,
      400
    );
    assert.equal(
      (await post(`/api/rooms/${code}/control`, { action: 'play', key, revision: 99 })).status,
      409
    );
    assert.equal(
      (await post(`/api/rooms/${code}/control`, { action: 'seek', time: -1, key, revision: 2 }))
        .status,
      400
    );
    const after = (await get(`/api/rooms/${code}/replay/events?key=${key}`)).data.events.length;
    assert.equal(after, before);
  });

  test('跳转/改速：事件记录边界，改速不跳变', async () => {
    let r = await post(`/api/rooms/${code}/control`, {
      action: 'seek',
      time: 4,
      key,
      revision: 2,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.time, 4);
    r = await post(`/api/rooms/${code}/control`, { action: 'speed', speed: 2, key, revision: 3 });
    assert.equal(r.status, 200);
    assert.equal(r.data.speed, 2);
    assert.equal(r.data.playing, false);
    const ev = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    const seek = ev.data.events.find((e) => e.type === 'seek');
    assert.ok(Math.abs(seek.before.time - timestamps.frozen) < 1e-6);
    assert.equal(seek.after.time, 4);
    assert.equal(seek.after.playing, false);
    const sp = ev.data.events.find((e) => e.type === 'speed');
    assert.equal(sp.before.speed, 1);
    assert.equal(sp.after.speed, 2);
    assert.equal(sp.after.time, 4); // 改速从当前边界接续，不跳变
  });

  test('状态复盘：暂停段时码不推进；播放段按速度推进；逐灯亮度按建房快照重算', async () => {
    // seek(rev→3)、speed 2×(rev→4) 后房间仍暂停在 4：暂停段任意时刻时码恒为 4。
    // 用概览给出的 server_now（必在可查范围内）作为查询点，避免挂钟边界竞争。
    const meta0 = await get(`/api/rooms/${code}/replay?key=${key}`);
    let s = await get(
      `/api/rooms/${code}/replay/state?key=${key}&at=${meta0.data.server_now}`
    );
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.playing, false);
    assert.equal(s.data.time, 4);
    assert.equal(s.data.speed, 2);
    assert.equal(s.data.revision, 4);
    // 灯 1 在 t=4 时亮度 40（0→100 线性 10 秒）
    assert.equal(s.data.levels.length, 1);
    assert.ok(Math.abs(s.data.levels[0].brightness - 40) < 1e-4, s.data.levels[0].brightness);
    assert.equal(s.data.governing_event.type, 'speed');

    // 从暂停态 2× 播放，0.3 秒后时码约 4.6、亮度约 46（查询点取当前挂钟，确保在范围内）
    const play = await post(`/api/rooms/${code}/control`, { action: 'play', key, revision: 4 });
    assert.equal(play.status, 200, JSON.stringify(play.data));
    assert.equal(play.data.playing, true, JSON.stringify(play.data));
    await sleep(300);
    const now1 = (await get(`/api/rooms/${code}/replay?key=${key}`)).data.server_now;
    s = await get(`/api/rooms/${code}/replay/state?key=${key}&at=${now1}`);
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.playing, true);
    assert.ok(s.data.time > 4.4 && s.data.time < 4.8, `time=${s.data.time}`);
    assert.ok(Math.abs(s.data.levels[0].brightness - s.data.time * 10) < 1e-3);
    timestamps.play2At = s.data.at;
    timestamps.play2Time = s.data.time;
  });

  test('到末尾自动停住：auto_stop 事件发生在到达末尾的实际时刻，其后时码恒为 10', async () => {
    // 从上一用例的播放点（2×，约 t≈4.6）等到越过末尾，触发服务端自动停住落库
    const waitMs = ((10 - timestamps.play2Time) / 2) * 1000 + 400;
    await sleep(waitMs);
    const d = await get(`/api/rooms/${code}`);
    assert.equal(d.data.at_end, true, JSON.stringify(d.data));
    const ev = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    const stop = ev.data.events.find((e) => e.type === 'auto_stop');
    assert.ok(stop);
    assert.equal(stop.before.playing, true);
    assert.equal(stop.after.playing, false);
    assert.equal(stop.after.time, 10);
    assert.equal(stop.before.time, 10);
    // 自动停住修订号 +1
    assert.equal(stop.after.revision, stop.before.revision + 1);

    // 停住之前仍是播放、之后停在末尾（查询点同样取当前挂钟）
    const s1 = await get(
      `/api/rooms/${code}/replay/state?key=${key}&at=${stop.at_server - 0.01}`
    );
    assert.equal(s1.data.playing, true);
    assert.ok(s1.data.time < 10);
    const now2 = (await get(`/api/rooms/${code}/replay?key=${key}`)).data.server_now;
    const s2 = await get(`/api/rooms/${code}/replay/state?key=${key}&at=${now2}`);
    assert.equal(s2.data.playing, false);
    assert.equal(s2.data.at_end, true);
    assert.equal(s2.data.time, 10);
    assert.equal(s2.data.levels[0].brightness, 100);
  });

  test('事件区间过滤：from/to 闭区间，只返回落在区间内的事件', async () => {
    const all = (await get(`/api/rooms/${code}/replay/events?key=${key}`)).data.events;
    // 最后一条播放事件即“末尾停住后从头播放”前的那次 2× 播放（t=4，rev=5）
    const playEv = [...all].reverse().find((e) => e.type === 'play');
    assert.ok(playEv, 'expect a play event');
    assert.equal(playEv.after.playing, true);
    const w = await get(
      `/api/rooms/${code}/replay/events?key=${key}&from=${playEv.at_server}&to=${playEv.at_server}`
    );
    assert.equal(w.status, 200);
    assert.deepEqual(w.data.events.map((e) => e.seq), [playEv.seq]);
    // 取两条事件之间的空当时刻：合法但不命中任何事件
    const createEv = all.find((e) => e.type === 'create');
    const gap = (createEv.at_server + playEv.at_server) / 2;
    const w2 = await get(
      `/api/rooms/${code}/replay/events?key=${key}&from=${gap}&to=${gap}`
    );
    assert.equal(w2.status, 200, JSON.stringify(w2.data));
    assert.equal(w2.data.events.length, 0);
  });

  test('非法/越界时间明确拒绝（400）', async () => {
    const meta = (await get(`/api/rooms/${code}/replay?key=${key}`)).data;
    const start = meta.retained_from;
    // 非数字
    assert.equal(
      (await get(`/api/rooms/${code}/replay/state?key=${key}&at=abc`)).status,
      400
    );
    // 早于留存起点
    const early = await get(
      `/api/rooms/${code}/replay/state?key=${key}&at=${start - 10}`
    );
    assert.equal(early.status, 400);
    assert.match(early.data.error, /留存起点/);
    // events：from > to
    const badWin = await get(
      `/api/rooms/${code}/replay/events?key=${key}&from=${start + 5}&to=${start}`
    );
    assert.equal(badWin.status, 400);
    // events：from 非数字
    assert.equal(
      (await get(`/api/rooms/${code}/replay/events?key=${key}&from=xx`)).status,
      400
    );
  });

  test('复盘只使用建房时固定版本：改草稿、发新版后复盘亮度不变', async () => {
    const l2 = await post('/api/lights', { name: '复盘测试灯2' });
    await post('/api/cues', [{ light_id: l2.data.id, time: 0, target: 0, duration: 0 }]);
    // 改掉 #1 的草稿 Cue 目标亮度并发新版
    const cues = (await get('/api/cues')).data;
    const c1 = cues.find((c) => c.light_id === 1);
    await http('PATCH', `/api/cues/${c1.id}`, {
      cue_no: c1.cue_no,
      light_id: 1,
      time: 0,
      target: 10,
      duration: 10,
    });
    await post('/api/versions', { label: '复盘测试二版' });

    const ev = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    const stop = ev.data.events.find((e) => e.type === 'auto_stop');
    const s = await get(
      `/api/rooms/${code}/replay/state?key=${key}&at=${stop.at_server + 0.01}`
    );
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.version.id, versionId);
    assert.equal(s.data.levels.length, 1); // 快照内只有创建时的 1 盏灯
    assert.equal(s.data.levels[0].brightness, 100); // 仍是旧版 0→100 的末尾亮度
  });

  test('服务重启后事件留存与复盘结果不变', async () => {
    const before = (await get(`/api/rooms/${code}/replay/events?key=${key}`)).data;
    await stopServer(server);
    await sleep(300);
    server = await startServer();
    const after = (await get(`/api/rooms/${code}/replay/events?key=${key}`)).data;
    assert.equal(after.events.length, before.events.length);
    assert.deepEqual(
      after.events.map((e) => [e.type, e.at_server, e.revision_after]),
      before.events.map((e) => [e.type, e.at_server, e.revision_after])
    );
    const meta = (await get(`/api/rooms/${code}/replay?key=${key}`)).data;
    assert.equal(meta.closed, false);
    const stop = after.events.find((e) => e.type === 'auto_stop');
    const s = await get(
      `/api/rooms/${code}/replay/state?key=${key}&at=${stop.at_server + 0.01}`
    );
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.time, 10);
  });

  test('关闭房间：直播接口 404，原密钥仍可只读复盘；关闭事件冻结状态', async () => {
    // 自动停住后按播放从头开始，让房间处于播放中再关闭，验证关闭冻结时码
    const rev = (await get(`/api/rooms/${code}`)).data.revision;
    const pl = await post(`/api/rooms/${code}/control`, { action: 'play', key, revision: rev });
    assert.equal(pl.status, 200);
    await sleep(300);
    const closedAt = Date.now() / 1000;

    assert.equal((await del(`/api/rooms/${code}`, { key: 'wrong' })).status, 403);
    assert.equal((await del(`/api/rooms/${code}`, { key })).status, 204);

    // 直播侧不可观看、不可控制、不在列表
    assert.equal((await get(`/api/rooms/${code}`)).status, 404);
    assert.equal(
      (await post(`/api/rooms/${code}/control`, { action: 'pause', key, revision: 0 })).status,
      404
    );
    assert.ok(!(await get('/api/rooms')).data.some((x) => x.code === code));
    // 再次关闭同样 404
    assert.equal((await del(`/api/rooms/${code}`, { key })).status, 404);

    // 复盘仍可读
    const meta = await get(`/api/rooms/${code}/replay?key=${key}`);
    assert.equal(meta.status, 200);
    assert.equal(meta.data.closed, true);
    assert.ok(Math.abs(meta.data.closed_at - closedAt) < 2);
    assert.ok(Math.abs(meta.data.retained_until - meta.data.closed_at) < 1e-6);

    const ev = await get(`/api/rooms/${code}/replay/events?key=${key}`);
    const ce = ev.data.events.at(-1);
    assert.equal(ce.type, 'close');
    assert.equal(ce.after.playing, false);
    assert.equal(ce.before.playing, true); // 关闭瞬间仍在播放
    assert.ok(ce.before.time >= 0 && ce.before.time < 10, `before.time=${ce.before.time}`);
    assert.equal(ce.after.revision, ce.before.revision); // 关闭不推进修订号

    // 关闭时刻状态：冻结；关闭后再查询仍冻结、closed=true
    let s = await get(
      `/api/rooms/${code}/replay/state?key=${key}&at=${ce.at_server}`
    );
    assert.equal(s.status, 200);
    assert.equal(s.data.closed, true);
    assert.equal(s.data.playing, false);
    assert.ok(Math.abs(s.data.time - ce.after.time) < 1e-6);
    s = await get(
      `/api/rooms/${code}/replay/state?key=${key}&at=${ce.at_server}`
    );
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.time, ce.after.time);
    assert.equal(s.data.closed, true);

    // 越界：晚于关闭时刻
    const over = await get(
      `/api/rooms/${code}/replay/state?key=${key}&at=${ce.at_server + 1}`
    );
    assert.equal(over.status, 400);
    assert.match(over.data.error, /关闭时刻/);

    // 无密钥/错密钥关闭后同样拒绝复盘
    assert.equal((await get(`/api/rooms/${code}/replay/state?at=1`)).status, 403);
    assert.equal((await get(`/api/rooms/${code}/replay/events?key=x`)).status, 403);

    // 非法房间码：直播与复盘均 404
    assert.equal((await get('/api/rooms/ZZZZZZ/replay?key=x')).status, 404);
  });

  test('零时长版本房间：create 事件即停在末尾，播放不留事件', async () => {
    for (const c of (await get('/api/cues')).data) {
      assert.equal((await http('DELETE', `/api/cues/${c.id}`)).status, 204);
    }
    const pub = await post('/api/versions', { label: '复盘空版本' });
    const room = await post('/api/rooms', { version_id: pub.data.id });
    assert.equal(room.status, 201);
    const c = room.data.code;
    const k = room.data.control_key;
    assert.equal(room.data.at_end, true);
    const r = await post(`/api/rooms/${c}/control`, { action: 'play', key: k, revision: 0 });
    assert.equal(r.status, 200);
    assert.equal(r.data.revision, 0);
    const ev = await get(`/api/rooms/${c}/replay/events?key=${k}`);
    assert.deepEqual(ev.data.events.map((e) => e.type), ['create']);
    const s = await get(`/api/rooms/${c}/replay/state?key=${k}&at=${ev.data.events[0].at_server}`);
    assert.equal(s.data.time, 0);
    assert.equal(s.data.at_end, true);
    assert.equal(s.data.playing, false);
  });
});

describe('既有房间从功能启用时的权威状态开始留存', () => {
  test('重启（模拟启用）旧房间：补 snapshot 事件且不推测更早操作', async () => {
    // 主服务已在上面的用例中创建过房间 A（已关闭）与零时长房间；它们在本进程启动前
    // 已经有事件（create…），不会重复补快照。这里另建房间并直接操作事件表模拟
    // “功能启用前已存在的房间”：删除其事件后重启，应只补一条 snapshot。
    const l = await post('/api/lights', { name: '复盘旧房间灯' });
    assert.equal(l.status, 201);
    await post('/api/cues', [{ light_id: l.data.id, time: 0, target: 80, duration: 4 }]);
    const pub = await post('/api/versions', { label: '复盘旧房间版本' });
    assert.equal(pub.data.cues.length, 1, JSON.stringify(pub.data.cues));
    const room = await post('/api/rooms', { version_id: pub.data.id });
    const c = room.data.code;
    const k = room.data.control_key;
    const seek = await post(`/api/rooms/${c}/control`, { action: 'seek', time: 3, key: k, revision: 0 });
    assert.equal(seek.status, 200, JSON.stringify(seek.data));
    const lightId = l.data.id;

    // 直接用 better-sqlite3 打开同一库删掉事件（模拟功能启用前的历史房间）
    const Database = require('better-sqlite3');
    const rawDb = new Database(dbPath);
    rawDb.prepare('DELETE FROM room_events WHERE room_id = (SELECT id FROM rooms WHERE code = ?)').run(c);
    rawDb.close();

    await stopServer(server);
    await sleep(300);
    server = await startServer();

    const ev = await get(`/api/rooms/${c}/replay/events?key=${k}`);
    assert.equal(ev.status, 200, JSON.stringify(ev.data));
    assert.equal(ev.data.events.length, 1);
    const snap = ev.data.events[0];
    assert.equal(snap.type, 'snapshot');
    assert.equal(snap.before, null);
    assert.equal(snap.after.time, 3); // 启用时权威状态：跳转后的暂停态
    assert.equal(snap.after.playing, false);
    assert.equal(typeof snap.after.revision, 'number');
    assert.equal(snap.revision_after, snap.after.revision);
    assert.ok(snap.after.revision >= 1); // seek 已推进过修订号，快照沿用启用时权威修订号
    // 留存起点之前不可查
    const early = await get(
      `/api/rooms/${c}/replay/state?key=${k}&at=${snap.at_server - 1}`
    );
    assert.equal(early.status, 400);
    // 从快照点起正常复盘（暂停段时码不推进）
    const s = await get(`/api/rooms/${c}/replay/state?key=${k}&at=${snap.at_server}`);
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.time, 3);
    const level = s.data.levels.find((x) => x.light_id === lightId);
    assert.ok(level, JSON.stringify(s.data.levels));
    assert.equal(level.brightness, 60); // 0→80 / 4s，t=3 时 60
  });
});
