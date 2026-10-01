'use strict';

/**
 * 共享房间端到端测试：启动真实 HTTP 服务（临时 SQLite 库），通过接口验证
 *  - 基于已发布版本创建房间、房间码/密钥校验；
 *  - 播放/暂停/跳转/0.5/1/2 倍速控制与服务端按时间推算时码；
 *  - 到版本末尾自动停住；修订号乐观并发（过期 409 且不改房间）；
 *  - 服务重启后恢复房间进度（基准时码/速度/修订号持久化）；
 *  - 草稿修改与新版本发布不影响固定版本的房间；房间操作不改动版本/草稿/调光记录。
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3917;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-rooms-'));
const dbPath = path.join(tmpDir, `rooms-test-${process.pid}.db`);

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

before(async () => {
  server = await startServer();
});

after(async () => {
  await stopServer(server);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('共享房间 HTTP API（端到端）', () => {
  let versionId;
  let roomCode;
  let roomKey;
  let cuesBefore;

  test('准备：创建灯具并发布一个总时长 10 秒的版本', async () => {
    const l1 = await post('/api/lights', { name: '房间测试灯1' });
    const l2 = await post('/api/lights', { name: '房间测试灯2' });
    assert.equal(l1.status, 201);
    await post('/api/cues', [
      { light_id: l1.data.id, time: 0, target: 100, duration: 10 },
      { light_id: l2.data.id, time: 0, target: 50, duration: 0 },
    ]);
    const pub = await post('/api/versions', { label: '房间测试首版' });
    assert.equal(pub.status, 201);
    versionId = pub.data.id;
    assert.equal(pub.data.cues.length, 2);
    cuesBefore = (await get('/api/cues')).data.length;
  });

  test('基于不存在的版本创建房间 → 404；版本号非法 → 400', async () => {
    assert.equal((await post('/api/rooms', { version_id: 99999 })).status, 404);
    const bad = await post('/api/rooms', { version_id: 'abc' });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /版本编号无效/);
  });

  test('创建房间：固定版本、初始暂停在 0、修订号 0、返回一次性控制密钥', async () => {
    const r = await post('/api/rooms', { version_id: versionId, label_ignored: true });
    assert.equal(r.status, 201);
    assert.match(r.data.code, /^[2-9A-HJ-NP-Z]{6}$/);
    assert.match(r.data.control_key, /^[0-9a-f]{48}$/);
    assert.equal(r.data.version.id, versionId);
    assert.equal(r.data.duration, 10);
    assert.equal(r.data.playing, false);
    assert.equal(r.data.time, 0);
    assert.equal(r.data.speed, 1);
    assert.equal(r.data.revision, 0);
    assert.equal(r.data.at_end, false);
    roomCode = r.data.code;
    roomKey = r.data.control_key;
  });

  test('观看者凭房间码加入：返回权威状态与固定版本快照，但不含密钥', async () => {
    const r = await get(`/api/rooms/${roomCode}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.code, roomCode);
    assert.equal(r.data.controllable, false);
    assert.equal(r.data.control_key, undefined);
    assert.equal(r.data.snapshot.cues.length, 2);
    assert.equal(r.data.snapshot.lights.length, 2);
    assert.ok(typeof r.data.server_now === 'number');
    assert.ok(typeof r.data.anchor_at === 'number');
  });

  test('房间码非法/不存在 → 404（含小写、错误长度、路径注入）', async () => {
    assert.equal((await get('/api/rooms/zzzzzz')).status, 404);
    assert.equal((await get('/api/rooms/AB')).status, 404);
    assert.equal((await get('/api/rooms/NOROOM')).status, 404);
  });

  test('无密钥/错误密钥控制 → 403，房间不变；缺少修订号 → 400', async () => {
    assert.equal((await post(`/api/rooms/${roomCode}/control`, { action: 'play', revision: 0 })).status, 403);
    assert.equal(
      (await post(`/api/rooms/${roomCode}/control`, { action: 'play', key: 'wrong', revision: 0 })).status,
      403
    );
    const noRev = await post(`/api/rooms/${roomCode}/control`, { action: 'play', key: roomKey });
    assert.equal(noRev.status, 400);
    const d = (await get(`/api/rooms/${roomCode}`)).data;
    assert.equal(d.revision, 0);
    assert.equal(d.playing, false);
  });

  test('非法动作/时码/速度明确报错（400）且不推进修订号', async () => {
    const ctl = (b) => post(`/api/rooms/${roomCode}/control`, { key: roomKey, revision: 0, ...b });
    assert.equal((await ctl({ action: 'fast-forward' })).status, 400);
    assert.match((await ctl({ action: 'seek', time: -1 })).data.error, /不得为负/);
    assert.match((await ctl({ action: 'seek', time: 11 })).data.error, /超出该版本末尾/);
    assert.match((await ctl({ action: 'speed', speed: 3 })).data.error, /非法速度/);
    assert.match((await ctl({ action: 'speed', speed: 1.5 })).data.error, /非法速度/);
    const d = (await get(`/api/rooms/${roomCode}`)).data;
    assert.equal(d.revision, 0);
  });

  test('播放：服务端按挂钟推进时码（约 0.4s 后时码约 0.4），修订号 1', async () => {
    const r = await post(`/api/rooms/${roomCode}/control`, { action: 'play', key: roomKey, revision: 0 });
    assert.equal(r.status, 200);
    assert.equal(r.data.playing, true);
    assert.equal(r.data.revision, 1);
    await sleep(400);
    const d = (await get(`/api/rooms/${roomCode}`)).data;
    assert.equal(d.playing, true);
    assert.ok(Math.abs(d.time - 0.4) < 0.15, `time=${d.time}`);
  });

  test('暂停：冻结在当前时码，等待后时码不再前进', async () => {
    const rev = (await get(`/api/rooms/${roomCode}`)).data.revision;
    const paused = await post(`/api/rooms/${roomCode}/control`, {
      action: 'pause',
      key: roomKey,
      revision: rev,
    });
    assert.equal(paused.status, 200);
    assert.equal(paused.data.playing, false);
    const frozen = paused.data.time;
    assert.ok(frozen > 0.2 && frozen < 0.8, `frozen=${frozen}`);
    await sleep(300);
    const d = (await get(`/api/rooms/${roomCode}`)).data;
    assert.equal(d.playing, false);
    assert.ok(Math.abs(d.time - frozen) < 1e-6, `time moved while paused: ${d.time} vs ${frozen}`);
  });

  test('跳转到 2.5：暂停在 2.5；修订号递增', async () => {
    const rev = (await get(`/api/rooms/${roomCode}`)).data.revision;
    const r = await post(`/api/rooms/${roomCode}/control`, {
      action: 'seek',
      time: 2.5,
      key: roomKey,
      revision: rev,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.playing, false);
    assert.ok(Math.abs(r.data.time - 2.5) < 1e-9);
    assert.equal(r.data.at_end, false);
  });

  test('2 倍速播放：时码以 2× 推进；改速不跳变', async () => {
    let rev = (await get(`/api/rooms/${roomCode}`)).data.revision;
    const sp = await post(`/api/rooms/${roomCode}/control`, {
      action: 'speed',
      speed: 2,
      key: roomKey,
      revision: rev,
    });
    assert.equal(sp.status, 200);
    assert.equal(sp.data.speed, 2);
    // seek 后为暂停，speed 控制保持暂停（基准重锚但不播放）
    assert.equal(sp.data.playing, false);
    assert.ok(Math.abs(sp.data.time - 2.5) < 1e-9);

    rev = sp.data.revision;
    const pl = await post(`/api/rooms/${roomCode}/control`, { action: 'play', key: roomKey, revision: rev });
    assert.equal(pl.data.playing, true);
    await sleep(300);
    const d = (await get(`/api/rooms/${roomCode}`)).data;
    assert.equal(d.speed, 2);
    assert.ok(Math.abs(d.time - (2.5 + 2 * 0.3)) < 0.2, `time=${d.time}`);
  });

  test('0.5 倍速同样合法', async () => {
    const rev = (await get(`/api/rooms/${roomCode}`)).data.revision;
    const sp = await post(`/api/rooms/${roomCode}/control`, {
      action: 'speed',
      speed: 0.5,
      key: roomKey,
      revision: rev,
    });
    assert.equal(sp.status, 200);
    assert.equal(sp.data.speed, 0.5);
  });

  test('过期修订号 → 409 冲突且房间不被改动', async () => {
    const cur = await get(`/api/rooms/${roomCode}`);
    const goodRev = cur.data.revision;
    assert.ok(goodRev >= 1);
    // 用过期修订号暂停
    const stale = await post(`/api/rooms/${roomCode}/control`, {
      action: 'pause',
      key: roomKey,
      revision: goodRev - 1,
    });
    assert.equal(stale.status, 409);
    assert.match(stale.data.error, /修订号冲突/);
    // 最新修订号仍可成功
    const ok = await post(`/api/rooms/${roomCode}/control`, {
      action: 'pause',
      key: roomKey,
      revision: goodRev,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.revision, goodRev + 1);
  });

  test('到版本末尾自动停住：播放越过末尾后 GET 即停在 10s、at_end=true', async () => {
    let rev = (await get(`/api/rooms/${roomCode}`)).data.revision;
    const seek = await post(`/api/rooms/${roomCode}/control`, {
      action: 'seek',
      time: 9,
      key: roomKey,
      revision: rev,
    });
    rev = seek.data.revision;
    await post(`/api/rooms/${roomCode}/control`, { action: 'play', key: roomKey, revision: rev });
    // 0.5× 下从 9 到 10 需要 2 秒，等待后服务端读到时应已自动停住
    await sleep(2300);
    const d = (await get(`/api/rooms/${roomCode}`)).data;
    assert.equal(d.at_end, true);
    assert.equal(d.playing, false);
    assert.equal(d.time, 10);
  });

  test('末尾停住后按播放：从头开始', async () => {
    const rev = (await get(`/api/rooms/${roomCode}`)).data.revision;
    const r = await post(`/api/rooms/${roomCode}/control`, {
      action: 'play',
      key: roomKey,
      revision: rev,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.at_end, false);
    assert.ok(r.data.time < 0.5, `expected restart from 0, got ${r.data.time}`);
    assert.equal(r.data.playing, true);
    // 收尾暂停，避免影响后续重启断言
    await post(`/api/rooms/${roomCode}/control`, {
      action: 'pause',
      key: roomKey,
      revision: r.data.revision,
    });
  });

  test('观看者携带错误密钥加入 → 403；正确密钥 → controllable=true', async () => {
    assert.equal((await get(`/api/rooms/${roomCode}?key=nope`)).status, 403);
    const ok = await get(`/api/rooms/${roomCode}?key=${roomKey}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.controllable, true);
  });

  test('房间列表不含控制密钥，且反映当前状态', async () => {
    const list = await get('/api/rooms');
    assert.equal(list.status, 200);
    const mine = list.data.find((r) => r.code === roomCode);
    assert.ok(mine);
    assert.equal(mine.control_key, undefined);
    assert.equal(mine.version_id, versionId);
    assert.ok(typeof mine.time === 'number');
  });

  test('草稿修改与新版本发布不影响固定版本的房间（快照不变、时长不变）', async () => {
    // 改草稿：新增一条 Cue（100 秒），再发布新版本
    await post('/api/cues', { light_id: 1, time: 100, target: 0, duration: 5 });
    await post('/api/versions', { label: '房间测试二版' });

    const d = await get(`/api/rooms/${roomCode}`);
    assert.equal(d.data.version.id, versionId); // 房间仍固定旧版本
    assert.equal(d.data.duration, 10);          // 末尾仍是 10 秒
    assert.equal(d.data.snapshot.cues.length, 2); // 快照仍是两条 Cue
  });

  test('房间控制不改动版本、草稿与调光记录', async () => {
    const cuesAfter = (await get('/api/cues')).data.length;
    assert.equal(cuesAfter, cuesBefore + 1); // 草稿只多了上面测试显式新增的那条
    const versions = (await get('/api/versions')).data;
    assert.ok(versions.length >= 2);
    const v1 = (await get(`/api/versions/${versionId}`)).data;
    assert.equal(v1.cues.length, 2);
  });

  test('服务重启后恢复房间进度（基准时码、速度、修订号、暂停状态持久化）', async () => {
    // 把房间置于确定状态：跳转 4、暂停、2 倍速
    let d = (await get(`/api/rooms/${roomCode}`)).data;
    let r = await post(`/api/rooms/${roomCode}/control`, {
      action: 'seek',
      time: 4,
      key: roomKey,
      revision: d.revision,
    });
    r = await post(`/api/rooms/${roomCode}/control`, {
      action: 'speed',
      speed: 2,
      key: roomKey,
      revision: r.data.revision,
    });
    const revisionBefore = r.data.revision;
    assert.equal(r.data.playing, false);

    await stopServer(server);
    await sleep(300);
    server = await startServer();

    d = (await get(`/api/rooms/${roomCode}`)).data;
    assert.equal(d.code, roomCode);
    assert.equal(d.playing, false);
    assert.ok(Math.abs(d.time - 4) < 1e-6, `time after restart=${d.time}`);
    assert.equal(d.speed, 2);
    assert.equal(d.revision, revisionBefore);
    assert.equal(d.duration, 10);
    assert.equal(d.snapshot.cues.length, 2); // 仍是创建时的版本快照
  });

  test('重启后播放继续按基准推进，到末尾依旧自动停住', async () => {
    const d = (await get(`/api/rooms/${roomCode}`)).data;
    const r = await post(`/api/rooms/${roomCode}/control`, {
      action: 'play',
      key: roomKey,
      revision: d.revision,
    });
    assert.equal(r.status, 200);
    await sleep(500);
    const mid = (await get(`/api/rooms/${roomCode}`)).data;
    assert.equal(mid.playing, true);
    assert.ok(Math.abs(mid.time - (4 + 2 * 0.5)) < 0.25, `mid=${mid.time}`);
    // 从 4 以 2× 到 10 需 3 秒；等待后自动停住
    await sleep(3000);
    const end = (await get(`/api/rooms/${roomCode}`)).data;
    assert.equal(end.at_end, true);
    assert.equal(end.playing, false);
    assert.equal(end.time, 10);
  });

  test('零时长版本（无 Cue）的房间：duration=0，播放不推进也不报错、修订号不增', async () => {
    // 清空草稿 Cue 后发布一个空版本（已发布版本与既有房间不受影响）
    for (const c of (await get('/api/cues')).data) {
      assert.equal((await http('DELETE', `/api/cues/${c.id}`)).status, 204);
    }
    const pub = await post('/api/versions', { label: '空草稿版本' });
    assert.equal(pub.status, 201);
    assert.equal(pub.data.cues.length, 0);

    const room = await post('/api/rooms', { version_id: pub.data.id });
    assert.equal(room.status, 201);
    assert.equal(room.data.duration, 0);
    const r = await post(`/api/rooms/${room.data.code}/control`, {
      action: 'play',
      key: room.data.control_key,
      revision: 0,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.playing, false);
    assert.equal(r.data.time, 0);
    assert.equal(r.data.at_end, true);
    assert.equal(r.data.revision, 0);
    await sleep(100);
    const d = (await get(`/api/rooms/${room.data.code}`)).data;
    assert.equal(d.time, 0);
    assert.equal(d.playing, false);
    // 跳转负时码仍被拒绝
    const bad = await post(`/api/rooms/${room.data.code}/control`, {
      action: 'seek',
      time: -0.1,
      key: room.data.control_key,
      revision: 0,
    });
    assert.equal(bad.status, 400);
  });

  test('关闭房间需要密钥；关闭后房间码 404', async () => {
    // 错误密钥不能删除
    assert.equal(
      (await http('DELETE', `/api/rooms/${roomCode}`, { key: 'nope' })).status,
      403
    );
    // 正确密钥关闭
    assert.equal((await http('DELETE', `/api/rooms/${roomCode}`, { key: roomKey })).status, 204);
    assert.equal((await get(`/api/rooms/${roomCode}`)).status, 404);
    assert.ok(!(await get('/api/rooms')).data.some((x) => x.code === roomCode));
  });
});
