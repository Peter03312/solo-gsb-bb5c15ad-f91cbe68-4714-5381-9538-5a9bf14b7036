'use strict';

const Engine = window.LightingEngine;

const state = {
  lights: [],
  circuits: [],
  cues: [],
  versions: [],
  records: [],
  // 当前打开的临时调光记录：detail 含绑定快照与操作序列，baseCues/byLight 为重算结果
  record: null,
  recordTime: 0,
  // 播放器会话：一旦开始播放，快照与排序后的 Cue 即冻结，草稿/新发布不影响本次播放
  session: null,
  time: 0,
  playing: false,
  speed: 1,
  rafId: null,
  lastWall: 0,
};

/* ------------------------------- API ------------------------------- */

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const fmt = (n) => {
  const v = Math.round(n * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (id) => document.getElementById(id);
const showErr = (el, msg) => { el.textContent = msg; el.hidden = false; };
const clearErr = (el) => { el.hidden = true; el.textContent = ''; };

/* ----------------------------- 标签页 ----------------------------- */

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach((p) =>
      p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`)
    );
  });
});

/* ----------------------------- 灯具 ----------------------------- */

async function loadLights() {
  state.lights = await api('GET', '/api/lights');
  renderLights();
  renderLightOptions();
}

function circuitOptions(selectedId, { allowUnassigned = true } = {}) {
  const none = allowUnassigned ? '<option value="">— 未分配 —</option>' : '';
  return (
    none +
    state.circuits
      .map((c) => `<option value="${c.id}" ${String(c.id) === String(selectedId) ? 'selected' : ''}>#${c.id} ${esc(c.name)}</option>`)
      .join('')
  );
}

function renderLights() {
  const tb = $('light-table').querySelector('tbody');
  tb.innerHTML = state.lights
    .map(
      (l) => `
      <tr data-light-id="${l.id}">
        <td>#${l.id}</td>
        <td>${esc(l.name)}</td>
        <td>
          <select data-w="circuit_id">
            ${circuitOptions(l.circuit_id)}
          </select>
        </td>
        <td class="edit-cell">
          <input data-w="watts" type="number" min="0" step="1" placeholder="未分配"
            value="${l.watts ?? ''}" ${l.circuit_id ? '' : 'disabled'} style="width:7rem" />
        </td>
        <td>
          <button data-save-wiring="${l.id}">保存接线</button>
          <button class="danger" data-del-light="${l.id}">删除</button>
        </td>
      </tr>`
    )
    .join('');
}

function renderLightOptions() {
  const opts = state.lights.map((l) => `<option value="${l.id}">#${l.id} ${esc(l.name)}</option>`).join('');
  $('cue-light').innerHTML = opts;
}

$('form-light').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('light-error'));
  const name = $('light-name').value.trim();
  if (!name) return;
  try {
    await api('POST', '/api/lights', { name });
    $('light-name').value = '';
    await loadLights();
  } catch (err) {
    showErr($('light-error'), err.message);
  }
});

// 接线：行内选择回路 + 填写瓦数后整行提交；未分配回路时瓦数留空
$('light-table').addEventListener('click', async (e) => {
  const saveId = e.target.dataset?.saveWiring;
  const delId = e.target.dataset?.delLight;
  clearErr($('light-error'));
  try {
    if (saveId) {
      const tr = e.target.closest('tr');
      const circuit_id = tr.querySelector('[data-w="circuit_id"]').value;
      const watts = tr.querySelector('[data-w="watts"]').value;
      const body = circuit_id ? { circuit_id, watts } : { circuit_id: null };
      await api('PUT', `/api/lights/${saveId}/wiring`, body);
      await loadLights();
      await loadCircuits();
    } else if (delId) {
      await api('DELETE', `/api/lights/${delId}`);
      await loadLights();
    }
  } catch (err) {
    showErr($('light-error'), err.message);
  }
});

// 选中回路后才允许填写瓦数
$('light-table').addEventListener('change', (e) => {
  if (e.target.dataset?.w !== 'circuit_id') return;
  const tr = e.target.closest('tr');
  tr.querySelector('[data-w="watts"]').disabled = !e.target.value;
});

/* ----------------------------- 回路 ----------------------------- */

async function loadCircuits() {
  state.circuits = await api('GET', '/api/circuits');
  renderCircuits();
  renderLights();
  renderLoadOptions();
}

function renderCircuits() {
  const tb = $('circuit-table').querySelector('tbody');
  if (state.circuits.length === 0) {
    tb.innerHTML = '<tr><td colspan="5" class="muted">还没有回路。</td></tr>';
    return;
  }
  tb.innerHTML = state.circuits
    .map(
      (c) => `
      <tr data-circuit-id="${c.id}">
        <td>#${c.id}</td>
        <td class="edit-cell"><input data-c="name" value="${esc(c.name)}" /></td>
        <td class="edit-cell"><input data-c="capacity" type="number" min="0" step="1" value="${c.capacity}" style="width:7rem" /></td>
        <td>${c.light_count}</td>
        <td>
          <button data-save-circuit="${c.id}">保存</button>
          <button class="danger" data-del-circuit="${c.id}">删除</button>
        </td>
      </tr>`
    )
    .join('');
}

$('form-circuit').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('circuit-error'));
  const name = $('circuit-name').value.trim();
  const capacity = $('circuit-capacity').value;
  try {
    await api('POST', '/api/circuits', { name, capacity });
    $('circuit-name').value = '';
    $('circuit-capacity').value = '';
    await loadCircuits();
  } catch (err) {
    showErr($('circuit-error'), err.message);
  }
});

$('circuit-table').addEventListener('click', async (e) => {
  const saveId = e.target.dataset?.saveCircuit;
  const delId = e.target.dataset?.delCircuit;
  clearErr($('circuit-error'));
  try {
    if (saveId) {
      const tr = e.target.closest('tr');
      const body = {};
      tr.querySelectorAll('[data-c]').forEach((el) => {
        body[el.dataset.c] = el.dataset.c === 'name' ? el.value : el.value;
      });
      await api('PATCH', `/api/circuits/${saveId}`, body);
      await loadCircuits();
    } else if (delId) {
      await api('DELETE', `/api/circuits/${delId}`);
      await loadCircuits();
    }
  } catch (err) {
    showErr($('circuit-error'), err.message);
  }
});

/* ----------------------------- 草稿 Cue ----------------------------- */

async function loadCues() {
  state.cues = await api('GET', '/api/cues');
  renderCues();
}

function renderCues() {
  const tb = $('cue-table').querySelector('tbody');
  tb.innerHTML = state.cues
    .map(
      (c) => `
      <tr data-cue-id="${c.id}">
        <td class="edit-cell"><input data-f="cue_no" type="number" min="1" step="1" value="${c.cue_no}" /></td>
        <td>
          <select data-f="light_id">
            ${state.lights
              .map((l) => `<option value="${l.id}" ${l.id === c.light_id ? 'selected' : ''}>#${l.id} ${esc(l.name)}</option>`)
              .join('')}
          </select>
        </td>
        <td class="edit-cell"><input data-f="time" type="number" min="0" step="0.1" value="${c.time}" /></td>
        <td class="edit-cell"><input data-f="target" type="number" min="0" max="100" step="0.1" value="${c.target}" /></td>
        <td class="edit-cell"><input data-f="duration" type="number" min="0" step="0.1" value="${c.duration}" /></td>
        <td>
          <button data-save-cue="${c.id}">保存</button>
          <button class="danger" data-del-cue="${c.id}">删除</button>
        </td>
      </tr>`
    )
    .join('');
}

$('form-cue').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('cue-error'));
  const body = {
    light_id: Number($('cue-light').value),
    time: $('cue-time').value,
    target: $('cue-target').value,
    duration: $('cue-duration').value,
  };
  const no = $('cue-no').value.trim();
  if (no) body.cue_no = no;
  try {
    state.cues = await api('POST', '/api/cues', body);
    $('cue-no').value = '';
    renderCues();
  } catch (err) {
    showErr($('cue-error'), '提交被拒绝：' + err.message);
  }
});

$('cue-table').addEventListener('click', async (e) => {
  const saveId = e.target.dataset?.saveCue;
  const delId = e.target.dataset?.delCue;
  clearErr($('cue-error'));
  try {
    if (saveId) {
      const tr = e.target.closest('tr');
      const body = {};
      tr.querySelectorAll('[data-f]').forEach((el) => {
        body[el.dataset.f] = el.value;
      });
      state.cues = await api('PATCH', `/api/cues/${saveId}`, body);
      renderCues();
    } else if (delId) {
      await api('DELETE', `/api/cues/${delId}`);
      await loadCues();
    }
  } catch (err) {
    showErr($('cue-error'), '提交被拒绝：' + err.message);
  }
});

$('btn-bulk').addEventListener('click', async () => {
  clearErr($('bulk-error'));
  const payload = [];
  const lines = $('cue-bulk').value.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 4 && parts.length !== 5) {
      return showErr($('bulk-error'), `第 ${i + 1} 行格式错误：应为「时码 灯具编号 目标亮度 渐变时长 [Cue编号]」`);
    }
    const [time, light_id, target, duration, cue_no] = parts;
    const row = { time, light_id, target, duration };
    if (cue_no !== undefined) row.cue_no = cue_no;
    payload.push(row);
  }
  if (payload.length === 0) return showErr($('bulk-error'), '没有可提交的行');
  try {
    state.cues = await api('POST', '/api/cues', payload);
    $('cue-bulk').value = '';
    renderCues();
  } catch (err) {
    showErr($('bulk-error'), '整次提交已拒绝：' + err.message);
  }
});

/* ----------------------------- 发布版本 ----------------------------- */

async function loadVersions({ keepSelection = true } = {}) {
  const prev = $('version-select').value;
  const prevA = $('cmp-version-a').value;
  const prevB = $('cmp-version-b').value;
  state.versions = await api('GET', '/api/versions');
  renderVersions();
  renderVersionOptions(keepSelection ? prev : null);
  renderCompareOptions();
  renderRecordVersionOptions();
  renderLoadOptions();
  renderMergeOptions();
  renderRoomVersionOptions();
  if (keepSelection) {
    if (state.versions.some((v) => String(v.id) === String(prevA))) $('cmp-version-a').value = prevA;
    if (state.versions.some((v) => String(v.id) === String(prevB))) $('cmp-version-b').value = prevB;
  }
}

function renderVersions() {
  const tb = $('version-table').querySelector('tbody');
  tb.innerHTML = state.versions
    .map(
      (v) => `
      <tr>
        <td>#${v.id}</td>
        <td>${esc(v.label)}</td>
        <td>${new Date(v.created_at * 1000).toLocaleString('zh-CN', { hour12: false })}</td>
        <td>${v.cue_count}</td>
      </tr>`
    )
    .join('');
}

function renderVersionOptions(preferId) {
  const sel = $('version-select');
  if (state.versions.length === 0) {
    sel.innerHTML = '<option value="">— 请先发布一个版本 —</option>';
    return;
  }
  sel.innerHTML = state.versions
    .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}（${v.cue_count} 条 Cue）</option>`)
    .join('');
  if (preferId && state.versions.some((v) => String(v.id) === String(preferId))) {
    sel.value = preferId;
  }
}

$('form-publish').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('publish-error'));
  try {
    const snap = await api('POST', '/api/versions', { label: $('version-label').value });
    $('version-label').value = '';
    await loadVersions({ keepSelection: false });
    $('version-select').value = String(snap.id);
    if (!state.playing) await loadSession(snap.id, true);
  } catch (err) {
    showErr($('publish-error'), err.message);
  }
});

/* ----------------------------- 播放器 ----------------------------- */

async function loadSession(versionId, resetTime) {
  const snap = await api('GET', `/api/versions/${versionId}`);
  const cues = Engine.prepareCues(snap.cues);
  state.session = {
    id: snap.id,
    label: snap.label,
    lights: snap.lights,
    cues,
    duration: Engine.showDuration(cues),
  };
  if (resetTime) state.time = 0;
  const tl = $('timeline');
  tl.max = String(Math.max(state.session.duration, 0));
  $('time-total').textContent = fmt(state.session.duration);
  $('session-info').textContent = `本次播放冻结于版本 #${snap.id}：${snap.label}`;
  renderPlayer();
}

$('version-select').addEventListener('change', async () => {
  if (state.playing) return; // 播放中不允许切换，保证使用开始时的版本
  const id = $('version-select').value;
  if (id) await loadSession(id, true);
});

function tick(ts) {
  if (!state.playing) return;
  const dt = ((ts - state.lastWall) / 1000) * state.speed;
  state.lastWall = ts;
  state.time += dt;
  if (state.time >= state.session.duration) {
    state.time = state.session.duration;
    state.playing = false;
    $('version-select').disabled = false;
    renderPlayer();
    return;
  }
  renderPlayer();
  state.rafId = requestAnimationFrame(tick);
}

$('btn-play').addEventListener('click', async () => {
  clearErr($('player-error'));
  try {
    const id = $('version-select').value;
    if (!id) return showErr($('player-error'), '还没有已发布版本，请先到「发布版本」页冻结一版。');
    // 开始播放时固定版本；暂停后继续则沿用同一会话
    if (!state.session || String(state.session.id) !== String(id)) {
      await loadSession(id, true);
    }
    if (state.time >= state.session.duration) state.time = 0; // 播完后再按播放：从头开始
    if (state.session.duration === 0) {
      state.time = 0;
      renderPlayer();
      return;
    }
    state.playing = true;
    state.lastWall = performance.now();
    $('version-select').disabled = true;
    state.rafId = requestAnimationFrame(tick);
  } catch (err) {
    showErr($('player-error'), err.message);
  }
});

$('btn-pause').addEventListener('click', pause);
function pause() {
  state.playing = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  $('version-select').disabled = false;
  renderPlayer();
}

$('btn-stop').addEventListener('click', () => {
  pause();
  state.time = 0;
  renderPlayer();
});

$('play-speed').addEventListener('change', (e) => {
  state.speed = Number(e.target.value);
});

$('timeline').addEventListener('input', (e) => {
  if (!state.session) return;
  state.time = Math.min(Math.max(Number(e.target.value), 0), state.session.duration);
  renderPlayer();
});

$('btn-jump').addEventListener('click', () => {
  clearErr($('player-error'));
  if (!state.session) return showErr($('player-error'), '请先选择并加载一个演出版本。');
  const t = Number($('jump-time').value);
  if (!Number.isFinite(t)) return showErr($('player-error'), '跳转时刻必须是数字。');
  if (t < 0) return showErr($('player-error'), `非法时码：${$('jump-time').value}（不得为负）。`);
  state.time = Math.min(t, state.session.duration);
  renderPlayer();
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)) {
    e.preventDefault();
    state.playing ? pause() : $('btn-play').click();
  }
});

// 舞台灯具渲染（本地播放器与共享房间共用；渐变规则完全一致，仅逐帧重算）
function renderStageInto(el, lights, levels) {
  el.innerHTML = lights
    .map((l) => {
      const v = Math.round(levels[l.id] * 10) / 10;
      const a = v / 100;
      return `
        <div class="lamp">
          <div class="beam" style="
              background: rgba(245,185,66,${(0.05 + a * 0.95).toFixed(3)});
              box-shadow: 0 0 ${(12 + a * 46).toFixed(0)}px rgba(245,185,66,${(a * 0.85).toFixed(3)});
              border-color: rgba(245,185,66,${(0.2 + a * 0.6).toFixed(3)});
              color: ${a > 0.5 ? '#2a1d04' : '#555'};">${fmt(v)}</div>
          <div class="name" title="${esc(l.name)}">#${l.id} ${esc(l.name)}</div>
        </div>`;
    })
    .join('');
}

function renderLevelsInto(el, lights, levels) {
  el.innerHTML = lights
    .map((l) => {
      const v = levels[l.id];
      return `
        <div class="level-item">
          <label><span>#${l.id} ${esc(l.name)}</span><span class="v">${fmt(v)}</span></label>
          <div class="level-track"><div class="level-fill" style="width:${v.toFixed(2)}%"></div></div>
        </div>`;
    })
    .join('');
}

function renderPlayer() {
  const s = state.session;
  const t = state.time;

  $('time-current').textContent = fmt(t);
  const tl = $('timeline');
  tl.value = String(t);

  if (!s) {
    $('stage').innerHTML = '<p class="muted" style="margin:auto">暂无演出版本</p>';
    $('levels').innerHTML = '';
    $('cue-timeline').querySelector('tbody').innerHTML = '';
    return;
  }

  const levels = Engine.levelsAt(s.cues, s.lights, t);

  // 舞台灯具与亮度条（共享房间页复用同一渲染）
  renderStageInto($('stage'), s.lights, levels);
  renderLevelsInto($('levels'), s.lights, levels);

  // Cue 时间线状态
  const nameOf = {};
  s.lights.forEach((l) => (nameOf[l.id] = l.name));
  $('cue-timeline').querySelector('tbody').innerHTML = s.cues
    .map((c) => {
      const end = c.time + c.duration;
      let status, cls;
      if (t < c.time) {
        status = '<span class="badge waiting">等待</span>';
        cls = '';
      } else if (c.duration > 0 && t < end) {
        status = '<span class="badge fading">渐变中</span>';
        cls = 'fading';
      } else {
        status = '<span class="badge done">已触发</span>';
        cls = 'done';
      }
      return `
        <tr class="${cls}">
          <td>${c.cueNo}</td>
          <td>#${c.lightId} ${esc(nameOf[c.lightId] || '?')}</td>
          <td>${fmt(c.time)}</td>
          <td>${fmt(c.target)}</td>
          <td>${fmt(c.duration)}</td>
          <td>${status}</td>
        </tr>`;
    })
    .join('');
}

/* ----------------------------- 版本比对 ----------------------------- */

function renderCompareOptions() {
  const make = (sel) => {
    if (state.versions.length === 0) {
      sel.innerHTML = '<option value="">— 暂无已发布版本 —</option>';
      return;
    }
    sel.innerHTML = state.versions
      .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}</option>`)
      .join('');
  };
  make($('cmp-version-a'));
  make($('cmp-version-b'));
  // 默认 A 选最新、B 选次新（或相同版本）
  if (state.versions.length > 0) $('cmp-version-a').value = String(state.versions[0].id);
  if (state.versions.length > 1) $('cmp-version-b').value = String(state.versions[1].id);
}

function intervalText(iv) {
  // [含端点 / (不含端点；start=end 表示仅该瞬间超差的零长度闭区间
  const s = iv.start_inclusive ? '[' : '(';
  const e = iv.end_inclusive ? ']' : ')';
  return `${s}${fmt(iv.start)}, ${fmt(iv.end)}${e}`;
}

$('form-compare').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('compare-error'));
  const body = {
    version_a: $('cmp-version-a').value,
    version_b: $('cmp-version-b').value,
    start: $('cmp-start').value,
    end: $('cmp-end').value,
    at: $('cmp-at').value,
    threshold: $('cmp-threshold').value,
  };
  try {
    const d = await api('POST', '/api/compare', body);
    renderCompare(d);
  } catch (err) {
    $('compare-result').hidden = true;
    showErr($('compare-error'), '比对失败：' + err.message);
  }
});

function renderCompare(d) {
  $('compare-result').hidden = false;
  $('cmp-at-title').textContent =
    `查看时刻 t = ${fmt(d.at)} s：两版逐灯亮度（阈值 ${fmt(d.threshold)}）`;

  // 逐灯亮度
  $('cmp-levels').querySelector('tbody').innerHTML = d.levels
    .map((r) => `
      <tr class="${r.exceeds ? 'cmp-hot' : ''}">
        <td>#${r.light_id} ${esc(r.name)}</td>
        <td>${fmt(r.brightness_a)}</td>
        <td>${fmt(r.brightness_b)}</td>
        <td>${fmt(r.difference)}</td>
        <td>${r.exceeds ? '<span class="badge fading">超差</span>' : '<span class="badge done">否</span>'}</td>
      </tr>`)
    .join('');

  // 区间
  const zeroWindow = d.window.start === d.window.end;
  $('cmp-window-note').textContent = zeroWindow
    ? `零长度时窗 [${fmt(d.window.start)}, ${fmt(d.window.end)}]：仅返回该时刻亮度，不产生区间。`
    : `时窗 [${fmt(d.window.start)}, ${fmt(d.window.end)}] 秒，区间端点含 [ ] / 不含 ( )。`;
  $('cmp-intervals').querySelector('tbody').innerHTML = d.intervals
    .map((g) => `
      <tr>
        <td>#${g.light_id} ${esc(g.name)}</td>
        <td class="cmp-iv-list">${g.intervals.map(intervalText).map(esc).join('，')}</td>
        <td>${g.intervals.length}</td>
      </tr>`)
    .join('');
  $('cmp-no-diff').hidden = d.intervals.length > 0;

  // 配置差异
  const renderOnly = (list, label, cls) =>
    list.length
      ? `<div class="cmp-cfg-group ${cls}"><b>${label}（${list.length}）</b>：` +
        list.map((l) => `#${l.light_id} ${esc(l.name)}`).join('、') +
        '</div>'
      : '';
  const cfgHtml =
    renderOnly(d.config_differences.only_in_a, `仅存在于版本 A（#${d.versions.a.id}）`, 'only-a') +
    renderOnly(d.config_differences.only_in_b, `仅存在于版本 B（#${d.versions.b.id}）`, 'only-b');
  $('cmp-config').innerHTML = cfgHtml || '<p class="muted">两版灯具配置一致。</p>';
}

/* ------------------------- 回路负载预判 ------------------------- */

function renderLoadOptions() {
  const vs = $('load-version');
  if (state.versions.length === 0) {
    vs.innerHTML = '<option value="">— 暂无已发布版本 —</option>';
  } else {
    vs.innerHTML = state.versions
      .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}</option>`)
      .join('');
  }
  const rs = $('load-record');
  if (state.records.length === 0) {
    rs.innerHTML = '<option value="">— 暂无调光记录 —</option>';
  } else {
    rs.innerHTML = state.records
      .map((r) => `<option value="${r.id}">#${r.id} ${esc(r.label)}（绑定版本 #${r.version_id}）</option>`)
      .join('');
  }
}

$('load-target-type').addEventListener('change', (e) => {
  const isRecord = e.target.value === 'record';
  $('load-version-wrap').hidden = isRecord;
  $('load-record-wrap').hidden = !isRecord;
});

$('form-load').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('load-error'));
  const isRecord = $('load-target-type').value === 'record';
  const body = {
    start: $('load-start').value,
    end: $('load-end').value,
    at: $('load-at').value,
  };
  if (isRecord) body.record_id = $('load-record').value;
  else body.version_id = $('load-version').value;
  try {
    const d = await api('POST', '/api/load', body);
    renderLoad(d);
  } catch (err) {
    $('load-result').hidden = true;
    showErr($('load-error'), '分析失败：' + err.message);
  }
});

function renderLoad(d) {
  $('load-result').hidden = false;
  const src =
    d.source.kind === 'record'
      ? `调光记录 #${d.source.record.id}（${esc(d.source.record.label)}，修订号 ${d.source.record.revision}）· 绑定版本 #${d.source.version.id}`
      : `已发布版本 #${d.source.version.id}（${esc(d.source.version.label)}）`;
  $('load-at-title').textContent = `查看时刻 t = ${fmt(d.at)} s 的回路负载（${src}）`;
  const zeroWindow = d.window.start === d.window.end;
  $('load-window-note').textContent = zeroWindow
    ? `零长度时窗 [${fmt(d.window.start)}, ${fmt(d.window.end)}]：仅返回该时刻负载，不产生区间。`
    : `时窗 [${fmt(d.window.start)}, ${fmt(d.window.end)}] 秒；负载严格大于容量才计入超载区间，端点 [含 / (不含。`;

  if (!d.has_circuit_config) {
    $('load-table').querySelector('tbody').innerHTML =
      '<tr><td colspan="6" class="muted">该版本发布时没有任何回路配置：播放照常，不产生回路负载。</td></tr>';
    $('load-intervals').querySelector('tbody').innerHTML = '';
    $('load-no-over').hidden = true;
    return;
  }

  $('load-table').querySelector('tbody').innerHTML = d.circuits
    .map((c) => {
      const margin = c.capacity - c.load_at;
      const badge = c.overloaded
        ? '<span class="badge fading">超载</span>'
        : '<span class="badge done">正常</span>';
      const members =
        c.lights.length === 0
          ? '<span class="muted">（无灯具）</span>'
          : c.lights.map((l) => `#${l.light_id} ${esc(l.name)}·${fmt(l.watts)}W`).join('、');
      return `
        <tr class="${c.overloaded ? 'cmp-hot' : ''}">
          <td>#${c.circuit_id} ${esc(c.name)}</td>
          <td>${fmt(c.capacity)}</td>
          <td><b>${fmt(c.load_at)}</b></td>
          <td>${margin < 0 ? `<span class="danger-text">${fmt(margin)}</span>` : fmt(margin)}</td>
          <td>${badge}</td>
          <td class="cmp-iv-list">${members}</td>
        </tr>`;
    })
    .join('');

  const hot = d.circuits.filter((c) => c.intervals.length > 0);
  $('load-intervals').querySelector('tbody').innerHTML = hot
    .map(
      (c) => `
      <tr>
        <td>#${c.circuit_id} ${esc(c.name)}</td>
        <td class="cmp-iv-list">${c.intervals.map(intervalText).map(esc).join('，')}</td>
        <td>${c.intervals.length}</td>
      </tr>`
    )
    .join('');
  $('load-no-over').hidden = hot.length > 0;
}

/* ------------------------- 临时调光记录（覆盖/归还） ------------------------- */

const HASH_RECORD = 'record';
const HASH_TIME = 't';

function readHash() {
  const out = {};
  window.location.hash
    .replace(/^#/, '')
    .split('&')
    .filter(Boolean)
    .forEach((kv) => {
      const [k, v] = kv.split('=');
      out[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    });
  return out;
}

function writeHash(recId, t) {
  const parts = [`${HASH_RECORD}=${recId}`];
  if (t > 0) parts.push(`${HASH_TIME}=${t}`);
  history.replaceState(null, '', `#${parts.join('&')}`);
}

function renderRecordVersionOptions() {
  const sel = $('rec-version');
  if (state.versions.length === 0) {
    sel.innerHTML = '<option value="">— 暂无已发布版本 —</option>';
    return;
  }
  sel.innerHTML = state.versions
    .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}（${v.cue_count} 条 Cue）</option>`)
    .join('');
}

async function loadRecordList({ preserveOpen = false } = {}) {
  const openId = state.record?.id;
  state.records = await api('GET', '/api/records');
  renderRecordTable();
  renderRecordVersionOptions();
  renderLoadOptions();
  if (preserveOpen && openId && state.records.some((r) => r.id === openId)) {
    await loadRecord(openId, false); // 追加成功后用服务器返回的新修订号刷新详情
  }
}

function renderRecordTable() {
  const tb = $('record-table').querySelector('tbody');
  if (state.records.length === 0) {
    tb.innerHTML = '<tr><td colspan="7" class="muted">还没有调光记录。</td></tr>';
    return;
  }
  tb.innerHTML = state.records
    .map(
      (r) => `
      <tr class="${state.record && state.record.id === r.id ? 'fading' : ''}">
        <td>#${r.id}</td>
        <td>${esc(r.label)}</td>
        <td>#${r.version_id} ${esc(r.version_label)}</td>
        <td>${r.revision}</td>
        <td>${r.op_count}</td>
        <td>${new Date(r.created_at * 1000).toLocaleString('zh-CN', { hour12: false })}</td>
        <td>
          <button data-open-record="${r.id}">打开</button>
          <button class="danger" data-del-record="${r.id}">删除</button>
        </td>
      </tr>`
    )
    .join('');
}

async function loadRecord(id, resetTime) {
  clearErr($('op-error'));
  const d = await api('GET', `/api/records/${id}`);
  const baseCues = Engine.prepareCues(d.cues);
  state.record = { ...d, baseCues, byLight: Engine.prepareOverrides(d.ops, baseCues) };
  $('record-workspace').hidden = false;
  renderRecordTable();
  renderOpFormLights();
  renderOps();
  renderRecordMeta();
  const maxT = Math.max(
    Engine.showDuration(baseCues),
    ...d.ops.map((o) => o.time + o.duration),
    0
  );
  $('rec-timeline').max = String(maxT);
  if (resetTime) state.recordTime = 0;
  renderRecordOutput();
}

function renderRecordMeta() {
  const r = state.record;
  $('rec-title').textContent = `调光记录 #${r.id}：${r.label}`;
  $('rec-meta').textContent =
    `绑定版本 #${r.version.id}（${r.version.label}，${r.version.cue_count} 条 Cue） · ` +
    `当前修订号 ${r.revision} · ${r.ops.length} 条操作 · 快照已冻结，草稿与新版本不影响本记录`;
}

function renderOpFormLights() {
  $('op-light').innerHTML = state.record.lights
    .map((l) => `<option value="${l.id}">#${l.id} ${esc(l.name)}</option>`)
    .join('');
  // 默认时码预填为末项时码，方便连续追加
  const last = state.record.ops[state.record.ops.length - 1];
  if (last) $('op-time').value = String(last.time);
}

$('op-type').addEventListener('change', (e) => {
  $('op-target').disabled = e.target.value !== 'override';
});

$('form-record-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('record-create-error'));
  const version_id = $('rec-version').value;
  if (!version_id) return showErr($('record-create-error'), '还没有已发布版本，请先到「发布版本」页冻结一版。');
  try {
    const r = await api('POST', '/api/records', { version_id, label: $('rec-label').value });
    $('rec-label').value = '';
    await loadRecordList();
    await loadRecord(r.id, true);
    switchToRecordsTab();
  } catch (err2) {
    showErr($('record-create-error'), err2.message);
  }
});

$('record-table').addEventListener('click', async (e) => {
  const openId = e.target.dataset?.openRecord;
  const delId = e.target.dataset?.delRecord;
  try {
    if (openId) {
      await loadRecord(Number(openId), true);
      writeHash(openId, 0);
      switchToRecordsTab();
    } else if (delId) {
      if (!confirm(`确认删除调光记录 #${delId}？该记录的全部操作将一并删除。`)) return;
      await api('DELETE', `/api/records/${delId}`);
      if (state.record && String(state.record.id) === String(delId)) {
        state.record = null;
        $('record-workspace').hidden = true;
        if (readHash()[HASH_RECORD]) history.replaceState(null, '', window.location.pathname);
      }
      await loadRecordList();
    }
  } catch (err2) {
    showErr($('record-create-error'), err2.message);
  }
});

function switchToRecordsTab() {
  document.querySelector('.tab[data-tab="records"]').click();
}

$('form-op').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = state.record;
  clearErr($('op-error'));
  const body = {
    revision: r.revision,
    op: {
      light_id: Number($('op-light').value),
      time: $('op-time').value,
      op_type: $('op-type').value,
      duration: $('op-duration').value,
    },
  };
  if (body.op.op_type === 'override') body.op.target = $('op-target').value;
  try {
    await appendOpsAndReload([body.op]);
  } catch (err2) {
    showErr($('op-error'), '追加失败：' + err2.message);
  }
});

// 统一追加入口：携带当前修订号；409 冲突时拉取最新详情（不覆盖查看时刻）后提示重试
async function appendOpsAndReload(ops) {
  const r = state.record;
  try {
    const d = await api('POST', `/api/records/${r.id}/ops`, { revision: r.revision, ops });
    state.record = {
      ...d,
      baseCues: Engine.prepareCues(d.cues),
      byLight: Engine.prepareOverrides(d.ops, Engine.prepareCues(d.cues)),
    };
    renderRecordTable();
    renderOps();
    renderRecordMeta();
    renderRecordOutput();
    // 同步列表中的修订号/操作数（不重新拉取详情，避免覆盖查看时刻）
    const row = state.records.find((x) => x.id === r.id);
    if (row) {
      row.revision = d.revision;
      row.op_count = d.ops.length;
      renderRecordTable();
    }
  } catch (err2) {
    if (/修订号冲突/.test(err2.message)) {
      await loadRecord(r.id, false); // 过期：以服务器序列为准重算
    }
    throw err2;
  }
}

function renderOps() {
  const nameOf = Object.fromEntries(state.record.lights.map((l) => [l.id, l.name]));
  $('op-table').querySelector('tbody').innerHTML = state.record.ops
    .map((o) => {
      const type =
        o.op_type === 'override'
          ? '<span class="badge fading">覆盖</span>'
          : '<span class="badge done">归还</span>';
      return `
        <tr>
          <td>${o.seq}</td>
          <td>#${o.light_id} ${esc(nameOf[o.light_id] || '?')}</td>
          <td>${fmt(o.time)}</td>
          <td>${type}</td>
          <td>${o.target === null || o.target === undefined ? '—' : fmt(o.target)}</td>
          <td>${fmt(o.duration)}</td>
        </tr>`;
    })
    .join('');
}

$('btn-rec-jump').addEventListener('click', () => {
  const t = Number($('rec-time').value);
  if (!Number.isFinite(t)) return showErr($('op-error'), '查看时刻必须是数字。');
  if (t < 0) return showErr($('op-error'), `非法时码：${$('rec-time').value}（不得为负）。`);
  state.recordTime = t;
  renderRecordOutput();
});

$('rec-timeline').addEventListener('input', (e) => {
  state.recordTime = Number(e.target.value);
  renderRecordOutput();
});

// 实际输出既可用服务器 /output，也可由快照+操作序列在本地重算；此处本地重算（与服务器同一引擎）
function renderRecordOutput() {
  const r = state.record;
  if (!r) return;
  const t = state.recordTime;
  $('rec-time').value = String(t);
  $('rec-timeline').value = String(t);
  writeHash(r.id, t);

  $('rec-levels').querySelector('tbody').innerHTML = r.lights
    .map((l) => {
      const orig = Engine.brightnessAt(r.baseCues, l.id, t);
      const actual = Engine.overrideBrightnessAt(r.byLight, r.baseCues, l.id, t);
      const active = Engine.activeOverride(r.byLight, l.id, t);
      const stateBadge =
        active === null
          ? '<span class="badge done">跟随原版</span>'
          : active.state === 'override'
            ? '<span class="badge fading">覆盖中</span>'
            : '<span class="badge waiting">归还融合中</span>';
      return `
        <tr class="${active ? 'fading' : ''}">
          <td>#${l.id} ${esc(l.name)}</td>
          <td class="muted">${fmt(orig)}</td>
          <td><b>${fmt(actual)}</b></td>
          <td>${stateBadge}</td>
          <td><div class="level-track"><div class="level-fill" style="width:${actual.toFixed(2)}%"></div></div></td>
        </tr>`;
    })
    .join('');
}

/* ----------------------------- 版本合并 ----------------------------- */

state.merge = null; // 当前预览结果

function renderMergeOptions() {
  const make = (sel) => {
    if (state.versions.length === 0) {
      sel.innerHTML = '<option value="">— 暂无已发布版本 —</option>';
      return;
    }
    sel.innerHTML = state.versions
      .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}</option>`)
      .join('');
  };
  make($('merge-base'));
  make($('merge-incoming'));
  // 默认基线选次新、待合入选最新（两组各自改稿后发布的典型顺序）
  if (state.versions.length > 0) $('merge-incoming').value = String(state.versions[0].id);
  if (state.versions.length > 1) $('merge-base').value = String(state.versions[1].id);
}

function formatMergeValue(kind, v) {
  if (v === null || v === undefined) return '<span class="badge waiting">— 已删除 —</span>';
  if (kind === 'light') return `名称：${esc(v.name)}`;
  if (kind === 'circuit') return `名称：${esc(v.name)}；容量：${fmt(v.capacity)} W`;
  if (kind === 'cue') {
    return `灯具：#${v.light_id} ${esc(v.light_name || '')}；时码：${fmt(v.time)}s；` +
      `目标：${fmt(v.target)}；渐变：${fmt(v.duration)}s`;
  }
  if (v.circuit_id === null) return '未分配回路（不计入负载）';
  return `回路：#${v.circuit_id} ${esc(v.circuit_name || '')}；额定：${fmt(v.watts)} W`;
}

function actionBadge(action, text) {
  const cls = action === 'delete' ? 'danger-text' : '';
  return `<span class="${cls}">${esc(text)}</span>`;
}

$('form-merge-preview').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('merge-error'));
  const body = {
    base_version_id: $('merge-base').value,
    incoming_version_id: $('merge-incoming').value,
  };
  try {
    state.merge = await api('POST', '/api/merge/preview', body);
    renderMergePreview();
  } catch (err2) {
    state.merge = null;
    $('merge-workspace').hidden = true;
    showErr($('merge-error'), '预览失败：' + err2.message);
  }
});

function renderMergePreview() {
  const m = state.merge;
  $('merge-workspace').hidden = false;
  clearErr($('merge-commit-error'));
  $('merge-title').textContent =
    `合并预览：基线 #${m.base.id}（${m.base.label}） → 合入 #${m.incoming.id}（${m.incoming.label}）`;
  $('merge-meta').textContent =
    `自动合入 ${m.summary.auto_total} 项` +
    `（新增 ${m.summary.auto_add} / 修改 ${m.summary.auto_update} / 删除 ${m.summary.auto_delete}），` +
    `冲突 ${m.summary.conflicts_total} 项。预览只读，尚未改动草稿。`;

  $('merge-auto-table').querySelector('tbody').innerHTML = m.auto
    .map(
      (a) => `
      <tr>
        <td>${esc(a.title)}</td>
        <td>${actionBadge(a.action, a.action_text)}</td>
        <td class="merge-side">${formatMergeValue(a.kind, a.base)}</td>
        <td class="merge-side">${formatMergeValue(a.kind, a.current)}</td>
        <td class="merge-side">${formatMergeValue(a.kind, a.incoming)}</td>
        <td class="merge-side"><b>${formatMergeValue(a.kind, a.applied)}</b></td>
      </tr>`
    )
    .join('');
  $('merge-no-auto').hidden = m.auto.length > 0;

  const box = $('merge-conflicts');
  if (m.conflicts.length === 0) {
    box.innerHTML = '';
    $('merge-no-conflict').hidden = false;
    return;
  }
  $('merge-no-conflict').hidden = true;
  box.innerHTML = m.conflicts
    .map(
      (c, idx) => {
        const warn = (side) =>
          c.reasons
            .filter((r) => r.side === side)
            .map((r) => `<li class="danger-text">⚠ ${esc(r.text)}</li>`)
            .join('');
        return `
        <div class="merge-conflict" data-conflict-index="${idx}">
          <div class="merge-conflict-head">
            <b>${esc(c.title)}</b>
            <span class="muted">${esc(c.reason_text)}</span>
          </div>
          <div class="merge-conflict-cols">
            <label class="merge-choice ${c.draft === null ? 'is-deleted' : ''}">
              <input type="radio" name="merge-choice-${idx}" value="draft" />
              <div>
                <div class="merge-choice-label">保留草稿</div>
                <div class="merge-side">${formatMergeValue(c.kind, c.draft)}</div>
                <ul class="merge-warns">${warn('draft')}</ul>
              </div>
            </label>
            <label class="merge-choice ${c.incoming === null ? 'is-deleted' : ''}">
              <input type="radio" name="merge-choice-${idx}" value="incoming" />
              <div>
                <div class="merge-choice-label">采用待合入版本</div>
                <div class="merge-side">${formatMergeValue(c.kind, c.incoming)}</div>
                <ul class="merge-warns">${warn('incoming')}</ul>
              </div>
            </label>
          </div>
        </div>`;
      }
    )
    .join('');
}

$('btn-merge-commit').addEventListener('click', async () => {
  const m = state.merge;
  if (!m) return;
  clearErr($('merge-commit-error'));

  const resolutions = {};
  const unanswered = [];
  m.conflicts.forEach((c, idx) => {
    const picked = document.querySelector(`input[name="merge-choice-${idx}"]:checked`);
    if (!picked) unanswered.push(c.title);
    else resolutions[c.key] = picked.value;
  });
  if (unanswered.length > 0) {
    return showErr(
      $('merge-commit-error'),
      `还有 ${unanswered.length} 个冲突未选择：${unanswered.slice(0, 5).join('、')}${
        unanswered.length > 5 ? ' 等' : ''
      }`
    );
  }

  try {
    const d = await api('POST', '/api/merge/commit', { token: m.token, resolutions });
    state.merge = null;
    $('merge-workspace').hidden = true;
    // 用合并后的新草稿刷新各页
    await loadLights();
    await loadCircuits();
    await loadCues();
    await loadVersions({ keepSelection: false });
    alert(
      `合并成功：自动合入 ${d.summary.auto_total} 项，冲突已全部按抉择处理。` +
      '当前草稿已更新；已发布版本与调光记录保持不变。'
    );
  } catch (err2) {
    if (/重新预览/.test(err2.message)) {
      state.merge = null;
      $('merge-workspace').hidden = true;
    }
    showErr($('merge-commit-error'), '合并提交失败：' + err2.message);
  }
});

/* ----------------------------- 共享房间 ----------------------------- */

state.rooms = [];
state.room = null; // 当前打开的房间：detail（含快照）+ key? + 本地推算状态
state.roomRaf = null;
state.roomPollTimer = null;

function renderRoomVersionOptions() {
  const sel = $('room-version');
  if (!sel) return;
  if (state.versions.length === 0) {
    sel.innerHTML = '<option value="">— 暂无已发布版本 —</option>';
    return;
  }
  sel.innerHTML = state.versions
    .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}（${v.cue_count} 条 Cue）</option>`)
    .join('');
}

function roomStatusText(r) {
  if (r.at_end) return '<span class="badge waiting">已到末尾</span>';
  return r.playing
    ? '<span class="badge fading">播放中</span>'
    : '<span class="badge done">暂停</span>';
}

async function loadRoomList() {
  state.rooms = await api('GET', '/api/rooms');
  renderRoomTable();
}

function renderRoomTable() {
  const tb = $('room-table').querySelector('tbody');
  if (state.rooms.length === 0) {
    tb.innerHTML = '<tr><td colspan="8" class="muted">还没有共享房间。</td></tr>';
    return;
  }
  tb.innerHTML = state.rooms
    .map(
      (r) => `
      <tr class="${state.room && state.room.detail.code === r.code ? 'fading' : ''}">
        <td><b>${esc(r.code)}</b></td>
        <td>#${r.version_id} ${esc(r.version_label)}</td>
        <td>${roomStatusText(r)}</td>
        <td>${fmt(r.time)} / ${fmt(r.duration)}</td>
        <td>${fmt(r.speed)}×</td>
        <td>${r.revision}</td>
        <td>${new Date(r.created_at * 1000).toLocaleString('zh-CN', { hour12: false })}</td>
        <td><button data-join-room="${r.code}">观看</button></td>
      </tr>`
    )
    .join('');
}

$('form-room-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('room-create-error'));
  const version_id = $('room-version').value;
  if (!version_id) return showErr($('room-create-error'), '还没有已发布版本，请先到「发布版本」页冻结一版。');
  try {
    const d = await api('POST', '/api/rooms', { version_id });
    await loadRoomList();
    await openRoom(d.code, d.control_key, { isCreator: true });
  } catch (err2) {
    showErr($('room-create-error'), err2.message);
  }
});

$('form-room-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('room-join-error'));
  const code = $('room-join-code').value.trim().toUpperCase();
  const key = $('room-join-key').value.trim();
  if (!code) return showErr($('room-join-error'), '请填写 6 位房间码。');
  try {
    await openRoom(code, key || null, { isCreator: false });
  } catch (err2) {
    showErr($('room-join-error'), err2.message);
  }
});

$('room-table').addEventListener('click', async (e) => {
  const code = e.target.dataset?.joinRoom;
  if (!code) return;
  clearErr($('room-join-error'));
  $('room-join-code').value = code;
  try {
    await openRoom(code, null, { isCreator: false });
  } catch (err2) {
    showErr($('room-join-error'), err2.message);
  }
});

/**
 * 打开房间：拉取权威状态（含固定版本快照），建立本地校时并开始 rAF + 轮询。
 * key 非空时以创建者身份加入（可控制）；null 为纯观看者。
 */
async function openRoom(code, key, { isCreator = false } = {}) {
  const url = key ? `/api/rooms/${encodeURIComponent(code)}?key=${encodeURIComponent(key)}`
                  : `/api/rooms/${encodeURIComponent(code)}`;
  const d = await api('GET', url);
  enterRoom(d, key, isCreator);
}

function enterRoom(detail, key, isCreator) {
  const cues = Engine.prepareCues(detail.snapshot.cues);
  state.room = {
    detail,
    key: detail.controllable ? key : null,
    isController: !!detail.controllable,
    cues,
    lights: detail.snapshot.lights,
    duration: detail.duration,
    scrubbing: false,
    // 校时：server_now 为响应构造时的服务端挂钟；本地据此推算当前服务端时码
    fetchWall: Date.now() / 1000,
  };
  $('room-workspace').hidden = false;
  $('room-timeline').max = String(Math.max(state.room.duration, 0));
  $('room-code-text').textContent = detail.code;
  $('room-key-area').hidden = !state.room.isController;
  if (state.room.isController) $('room-key-text').textContent = key;
  writeRoomHash(detail.code, state.room.isController ? key : null);
  renderRoomMeta();
  syncRoomControls();
  startRoomLoop();
}

function writeRoomHash(code, key) {
  const parts = [`room=${code}`];
  if (key) parts.push(`roomkey=${encodeURIComponent(key)}`);
  history.replaceState(null, '', `#${parts.join('&')}`);
}

function renderRoomMeta() {
  const r = state.room;
  const d = r.detail;
  $('room-title').textContent = `共享房间 ${d.code}`;
  const role = r.isController ? '你是创建者（持密钥，可控制）' : '你是观看者（只读同步）';
  const st = d.at_end ? '已到末尾停住' : d.playing ? '播放中' : '暂停';
  $('room-meta').textContent =
    `固定版本 #${d.version.id}（${esc(d.version.label || '')}，${d.snapshot.cue_count} 条 Cue） · ` +
    `${st} · 速度 ${fmt(d.speed)}× · 修订号 ${d.revision} · ${role}` +
    (r.isController ? '' : ' · 播放/暂停/跳转由持密钥者控制');
  $('room-role-hint').textContent = r.isController
    ? '你的控制会立即同步给全部观看者；每次成功控制修订号 +1，过期提交会收到 409 并自动按服务器状态校正。'
    : '观看端按服务端状态校时并沿用既有线性渐变规则本地重算逐灯亮度；无需手动刷新。';
  $('room-time-total').textContent = fmt(r.duration);
}

// 观看者禁用所有控制；速度选择仅创建者可改
function syncRoomControls() {
  const r = state.room;
  const can = r.isController;
  for (const id of ['btn-room-play', 'btn-room-pause', 'btn-room-stop', 'btn-room-jump', 'room-speed', 'room-jump-time']) {
    $(id).disabled = !can;
  }
  $('room-speed').value = String(r.detail.speed);
  $('room-timeline').disabled = false; // 观看者也可拖动预览本地画面，但不发送控制
}

// 当前权威时码：按服务端基准在本地挂钟上推算（播放中才推进）
function roomCurrentTime(r, nowWall = Date.now() / 1000) {
  const d = r.detail;
  if (!d.playing || d.at_end) return d.at_end ? d.duration : d.time;
  const serverNow = d.server_now + (nowWall - r.fetchWall);
  let t = d.base_time + d.speed * (serverNow - d.anchor_at);
  if (t >= d.duration) return d.duration;
  if (t < 0) return 0;
  return t;
}

function startRoomLoop() {
  stopRoomLoop();
  const frame = () => {
    renderRoomFrame();
    state.roomRaf = requestAnimationFrame(frame);
  };
  state.roomRaf = requestAnimationFrame(frame);
  // 观看端/创建者都定期拉取权威状态（他人控制、自动停住、修订号变化）
  state.roomPollTimer = setInterval(pollRoom, 1000);
}

function stopRoomLoop() {
  if (state.roomRaf) cancelAnimationFrame(state.roomRaf);
  state.roomRaf = null;
  if (state.roomPollTimer) clearInterval(state.roomPollTimer);
  state.roomPollTimer = null;
}

// 以新的权威状态重建校时（保留创建者身份与本地固定版本快照——房间版本不变，快照只取一次）
function adoptRoomDetail(d) {
  const r = state.room;
  const wasRevision = r.detail.revision;
  const prevSnapshot = r.detail.snapshot;
  r.detail = { ...d, snapshot: d.snapshot || prevSnapshot };
  r.fetchWall = Date.now() / 1000;
  renderRoomMeta();
  $('room-speed').value = String(d.speed);
  if (d.revision !== wasRevision) renderRoomTable();
}

async function pollRoom() {
  const r = state.room;
  if (!r) return;
  try {
    const url = r.key
      ? `/api/rooms/${r.detail.code}?key=${encodeURIComponent(r.key)}`
      : `/api/rooms/${r.detail.code}`;
    const d = await api('GET', url);
    // 仅在服务端修订号或播放态不同步时重锚，避免轮询响应抖动本地时钟
    if (d.revision !== r.detail.revision || d.playing !== r.detail.playing || d.speed !== r.detail.speed) {
      adoptRoomDetail(d);
    } else {
      r.detail.server_now = d.server_now; // 轻量校时
      r.fetchWall = Date.now() / 1000;
    }
  } catch (err2) {
    // 房间已被创建者关闭：退出工作区
    if (/房间不存在|房间码无效/.test(err2.message)) {
      stopRoomLoop();
      state.room = null;
      $('room-workspace').hidden = true;
      await loadRoomList();
      showErr($('room-join-error'), '该房间已被创建者关闭。');
      return;
    }
    // 网络瞬时失败：下一帧继续按本地时钟推进，下轮轮询再校正
  }
}

function renderRoomFrame() {
  const r = state.room;
  if (!r) return;
  // 观看者正在拖动时间轴本地预览时，不被逐帧权威时码覆盖（松手/下轮轮询即恢复同步）
  if (r.scrubbing) return;
  const t = roomCurrentTime(r);
  $('room-time-current').textContent = fmt(t);
  $('room-timeline').value = String(Math.min(t, r.duration));
  const levels = Engine.levelsAt(r.cues, r.lights, t);
  renderStageInto($('room-stage'), r.lights, levels);
  renderLevelsInto($('room-levels'), r.lights, levels);
}

/**
 * 发送控制请求。携带当前修订号；成功采用服务器返回的新状态；
 * 409（修订号过期）则拉取最新房间状态后提示——房间不被本次请求改动。
 */
async function roomControl(body, { quiet = false } = {}) {
  const r = state.room;
  if (!r || !r.isController) return;
  clearErr($('room-control-error'));
  try {
    const d = await api('POST', `/api/rooms/${r.detail.code}/control`, {
      ...body,
      key: r.key,
      revision: r.detail.revision,
    });
    adoptRoomDetail(d);
  } catch (err2) {
    if (err2.message && err2.message.includes('修订号冲突')) {
      const latest = await api('GET', `/api/rooms/${r.detail.code}?key=${encodeURIComponent(r.key)}`);
      adoptRoomDetail(latest);
    }
    if (!quiet) showErr($('room-control-error'), '控制失败：' + err2.message);
  }
}

$('btn-room-play').addEventListener('click', () => roomControl({ action: 'play' }));
$('btn-room-pause').addEventListener('click', () => roomControl({ action: 'pause' }));
$('btn-room-stop').addEventListener('click', () => roomControl({ action: 'seek', time: 0 }));
$('btn-room-jump').addEventListener('click', () => {
  const raw = $('room-jump-time').value;
  const t = Number(raw);
  if (!Number.isFinite(t)) return showErr($('room-control-error'), '跳转时刻必须是数字。');
  if (t < 0) return showErr($('room-control-error'), `非法时码：${raw}（不得为负）。`);
  roomControl({ action: 'seek', time: t });
});

// 改速立即生效（播放中由服务端重锚，画面不跳变）
$('room-speed').addEventListener('change', (e) => {
  if (!state.room?.isController) return;
  roomControl({ action: 'speed', speed: Number(e.target.value) });
});

// 观看者拖动时间轴只在本地预览（松手即被权威状态拉回）；创建者松手则跳转
$('room-timeline').addEventListener('pointerdown', () => {
  const r = state.room;
  if (r && !r.isController) r.scrubbing = true;
});
$('room-timeline').addEventListener('change', (e) => {
  const r = state.room;
  if (!r) return;
  const t = Number(e.target.value);
  if (r.isController) {
    roomControl({ action: 'seek', time: t });
  } else {
    r.scrubbing = false;
    renderRoomFrame();
  }
});
$('room-timeline').addEventListener('input', () => {
  const r = state.room;
  if (!r) return;
  if (!r.isController) {
    const t = Number($('room-timeline').value);
    const levels = Engine.levelsAt(r.cues, r.lights, t);
    renderStageInto($('room-stage'), r.lights, levels);
    renderLevelsInto($('room-levels'), r.lights, levels);
    $('room-time-current').textContent = fmt(t);
  }
});

$('btn-room-leave').addEventListener('click', () => {
  stopRoomLoop();
  state.room = null;
  $('room-workspace').hidden = true;
  if (readHash().room) history.replaceState(null, '', window.location.pathname);
  renderRoomTable();
});

$('btn-copy-code').addEventListener('click', () => {
  if (!state.room) return;
  navigator.clipboard?.writeText(state.room.detail.code);
});
$('btn-copy-key').addEventListener('click', () => {
  if (!state.room?.key) return;
  const link = `${window.location.origin}${window.location.pathname}#room=${state.room.detail.code}&roomkey=${encodeURIComponent(state.room.key)}`;
  navigator.clipboard?.writeText(link);
});

/* ----------------------------- 启动 ----------------------------- */

(async function init() {
  try {
    [state.lights, state.circuits, state.cues, state.versions, state.records, state.rooms] =
      await Promise.all([
        api('GET', '/api/lights'),
        api('GET', '/api/circuits'),
        api('GET', '/api/cues'),
        api('GET', '/api/versions'),
        api('GET', '/api/records'),
        api('GET', '/api/rooms'),
      ]);
    renderLights();
    renderLightOptions();
    renderCircuits();
    renderCues();
    renderVersions();
    renderVersionOptions(null);
    renderCompareOptions();
    renderRecordVersionOptions();
    renderRecordTable();
    renderLoadOptions();
    renderRoomVersionOptions();
    renderRoomTable();

    // 刷新后按 #record=<id>&t=<time> 重算该记录
    const hash = readHash();
    if (hash[HASH_RECORD]) {
      const rid = Number(hash[HASH_RECORD]);
      if (state.records.some((r) => r.id === rid)) {
        switchToRecordsTab();
        await loadRecord(rid, true);
        const t = Number(hash[HASH_TIME]);
        if (Number.isFinite(t) && t >= 0) {
          state.recordTime = t;
          renderRecordOutput();
        }
      }
    }

    // 刷新/重连后按 #room=<code>[&roomkey=<key>] 恢复房间进度（持密钥即恢复控制身份）
    if (hash.room) {
      const code = String(hash.room).toUpperCase();
      const rkey = hash.roomkey ? decodeURIComponent(hash.roomkey) : null;
      document.querySelector('.tab[data-tab="rooms"]').click();
      $('room-join-code').value = code;
      if (rkey) $('room-join-key').value = rkey;
      try {
        await openRoom(code, rkey, { isCreator: !!rkey });
      } catch (err3) {
        showErr($('room-join-error'), '恢复房间失败：' + err3.message);
      }
    }

    if (state.versions.length > 0) {
      await loadSession(state.versions[0].id, true); // 默认加载最新版本，停在 0 秒
    } else {
      renderPlayer();
    }
  } catch (err) {
    showErr($('player-error'), '初始化失败：' + err.message);
  }
})();
