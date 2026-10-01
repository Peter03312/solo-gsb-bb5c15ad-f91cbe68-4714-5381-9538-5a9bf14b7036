'use strict';

/*
 * 草稿三方合并（纯函数，无数据库依赖，便于单元测试）。
 *
 * 背景：两组排演人员从同一已发布版本（base 共同基线）各自改稿，当前草稿（draft）
 * 为其中一组的成果，现需把另一已发布版本（incoming 待合入）合入当前草稿。
 *
 * 比较维度（各自按稳定编号匹配）：
 *   light   灯具：按灯具编号 id，值为名称
 *   circuit 回路：按回路编号 id，值为名称/容量
 *   cue     Cue：按 Cue 编号 cue_no，值为灯具/时码/目标亮度/渐变时长
 *   wiring  接线：按灯具编号 light_id，值为所属回路（null=未分配）/额定瓦数
 *
 * 仅一侧改动、或两侧改成相同内容 → 可自动合入（auto）；
 * 两侧不同改动、删除与修改并存、同编号新增异值 → 冲突（conflict）。
 * 名称重名（灯具名/回路名唯一）、Cue 引用缺失灯具、接线引用缺失回路
 * 通过对「各侧投影结果」做规则校验补出，同样列为冲突。
 */

const KINDS = ['light', 'circuit', 'cue', 'wiring'];

const KIND_LABEL = {
  light: '灯具',
  circuit: '回路',
  cue: 'Cue',
  wiring: '灯具接线',
};

function keyOf(kind, id) {
  return `${kind}:${id}`;
}

function parseKey(key) {
  const idx = String(key).indexOf(':');
  return { kind: String(key).slice(0, idx), id: Number(String(key).slice(idx + 1)) };
}

/* ------------------------------- 快照取值 ------------------------------- */

function lightValue(row) {
  return { id: row.id, name: row.name };
}

function circuitValue(row) {
  return { id: row.id, name: row.name, capacity: row.capacity };
}

function cueValue(row) {
  return {
    cue_no: row.cue_no,
    light_id: row.light_id,
    time: row.time,
    target: row.target,
    duration: row.duration,
  };
}

function wiringValue(row) {
  return {
    light_id: row.light_id,
    circuit_id: row.circuit_id ?? null,
    watts: row.watts ?? null,
  };
}

// 三方快照统一成 kind -> Map(key -> 规范化值)。
// 接线只对该侧存在的灯具有意义；快照中缺接线行的灯具按「未分配」补全，
// 以免基线没有接线行（早期版本）被误判为改动。
function normalizeSnapshots(base, draft, incoming) {
  const sides = [];
  for (const snap of [base, draft, incoming]) {
    const lights = new Map();
    const circuits = new Map();
    const cues = new Map();
    const wiring = new Map();

    for (const l of snap.lights || []) lights.set(l.id, lightValue(l));
    for (const c of snap.circuits || []) circuits.set(c.id, circuitValue(c));
    for (const c of snap.cues || []) cues.set(c.cue_no, cueValue(c));

    const rawWiring = new Map((snap.wiring || []).map((w) => [w.light_id, w]));
    for (const id of lights.keys()) {
      const w = rawWiring.get(id);
      wiring.set(id, wiringValue(w ? w : { light_id: id, circuit_id: null, watts: null }));
    }

    sides.push({ light: lights, circuit: circuits, cue: cues, wiring });
  }
  return { base: sides[0], draft: sides[1], incoming: sides[2] };
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ----------------------------- 单条目三态分类 ----------------------------- */

// 返回 status（auto 候选）或 status='conflict' + reason（同编号两侧新增异值/两侧不同改动）。
function classifyOne(b, d, i) {
  const bHas = b !== undefined;
  const dHas = d !== undefined;
  const iHas = i !== undefined;

  if (bHas) {
    if (dHas && iHas) {
      const dChanged = !sameValue(b, d);
      const iChanged = !sameValue(b, i);
      if (!dChanged && !iChanged) return { status: 'unchanged' };
      if (dChanged && iChanged) {
        return sameValue(d, i)
          ? { status: 'same_change' }
          : { status: 'conflict', reason: 'both_modified' };
      }
      return dChanged ? { status: 'draft_changed' } : { status: 'incoming_changed' };
    }
    if (!dHas && !iHas) return { status: 'both_deleted' };
    // 仅一侧删除：另一侧也改过（含改名/改值）才是「删除与修改并存」；
    // 另一侧原样保留则属于「仅一侧改动」，删除可自动合入
    if (!dHas) {
      // 草稿侧删除：待合入改过 → 冲突；待合入原样 → draft_deleted（草稿现状，不产生自动项）
      return !sameValue(b, i)
        ? { status: 'conflict', reason: 'delete_vs_modify' }
        : { status: 'draft_deleted' };
    }
    // !iHas：待合入侧删除；草稿改过 → 冲突；草稿原样 → incoming_deleted（自动从草稿删除）
    return !sameValue(b, d)
      ? { status: 'conflict', reason: 'delete_vs_modify' }
      : { status: 'incoming_deleted' };
  }

  // 基线不存在：两侧新增
  if (dHas && iHas) {
    return sameValue(d, i) ? { status: 'added_same' } : { status: 'conflict', reason: 'same_key_diff' };
  }
  return dHas ? { status: 'draft_added' } : { status: 'incoming_added' };
}

// auto 条目的自然结果（合入草稿后的值，null 表示删除/不存在）。
function naturalOutcome(status, b, d, i) {
  switch (status) {
    case 'unchanged':
      return b;
    case 'same_change':
    case 'draft_changed':
    case 'draft_added':
    case 'added_same':
      return d;
    case 'incoming_changed':
    case 'incoming_added':
      return i;
    case 'both_deleted':
    case 'draft_deleted':
    case 'incoming_deleted':
      return null;
    default:
      return undefined;
  }
}

// 冲突条目在某一侧投影下的取值（该侧删除则 null）。
function sideOutcome(side, d, i) {
  return side === 'draft' ? d ?? null : i ?? null;
}

/* --------------------------- 唯一性 / 引用规则校验 --------------------------- */
// 对一份「合并结果」做校验，返回 key -> 违规原因数组。
//   灯具名称、回路名称在各自集合内唯一；
//   每条 Cue 的 light_id 必须指向结果中的灯具；
//   每盏灯的接线 circuit_id 非空时必须指向结果中的回路。
function validateResult(ls, cs, qs, ws) {
  const violations = new Map();
  const add = (kind, id, code, detail) => {
    const key = keyOf(kind, id);
    if (!violations.has(key)) violations.set(key, []);
    violations.get(key).push({ code, detail });
  };

  const checkUnique = (map, kind, code) => {
    const byName = new Map();
    for (const [id, v] of map) {
      if (!byName.has(v.name)) byName.set(v.name, []);
      byName.get(v.name).push(id);
    }
    for (const [name, ids] of byName) {
      if (ids.length > 1) {
        for (const id of ids) {
          add(kind, id, code, { name, others: ids.filter((x) => x !== id) });
        }
      }
    }
  };

  checkUnique(ls, 'light', 'name_collision');
  checkUnique(cs, 'circuit', 'name_collision');

  for (const [no, q] of qs) {
    if (!ls.has(q.light_id)) {
      add('cue', no, 'reference_missing', { missing_light_id: q.light_id });
    }
  }

  for (const [lightId, w] of ws) {
    if (!ls.has(lightId)) continue; // 灯都不存在时随灯删除，不单独报接线
    if (w.circuit_id !== null && !cs.has(w.circuit_id)) {
      add('wiring', lightId, 'reference_missing', { missing_circuit_id: w.circuit_id });
    }
  }

  return violations;
}

// 把每条目的取值投影成一份完整结果：forcedKeys 中的条目强制取 side 侧取值，
// 其余条目按自然结果（草稿侧的改动保持、待合入单侧改动落定）。
function project(maps, side, forcedKeys) {
  const out = {
    light: new Map(),
    circuit: new Map(),
    cue: new Map(),
    wiring: new Map(),
  };
  for (const kind of KINDS) {
    for (const e of maps[kind]) {
      let v;
      if (forcedKeys.has(e.key)) {
        v = sideOutcome(side, e.draft, e.incoming);
      } else {
        v = naturalOutcome(e.status, e.base, e.draft, e.incoming);
      }
      if (v !== null && v !== undefined) {
        const id = kind === 'cue' ? v.cue_no : kind === 'wiring' ? v.light_id : v.id;
        out[kind].set(id, v);
      }
    }
  }
  return out;
}

/* ------------------------------- 主分类入口 ------------------------------- */

function classify(base, draft, incoming) {
  const S = normalizeSnapshots(base, draft, incoming);
  const maps = {};
  const entryByKey = new Map();

  for (const kind of KINDS) {
    const ids = new Set([
      ...S.base[kind].keys(),
      ...S.draft[kind].keys(),
      ...S.incoming[kind].keys(),
    ]);
    maps[kind] = [...ids]
      .sort((x, y) => x - y)
      .map((id) => {
        const b = S.base[kind].get(id);
        const d = S.draft[kind].get(id);
        const i = S.incoming[kind].get(id);
        const r = classifyOne(b, d, i);
        const e = {
          kind,
          id,
          key: keyOf(kind, id),
          base: b ?? null,
          draft: d ?? null,
          incoming: i ?? null,
          ...r,
        };
        entryByKey.set(e.key, e);
        return e;
      });
  }

  // 结构性冲突（两侧不同改动 / 删除与修改并存 / 同编号新增异值）
  const conflictKeys = new Set();
  for (const kind of KINDS) {
    for (const e of maps[kind]) if (e.status === 'conflict') conflictKeys.add(e.key);
  }

  // 两遍投影校验：
  // 第 1 遍只强制结构性冲突，找出规则类冲突（重名/引用缺失）涉及的编号；
  // 第 2 遍把这些编号也按侧强制，才能准确标注「选某一侧时是否违规」。
  const projViolations = { draft: new Map(), incoming: new Map() };
  for (const side of ['draft', 'incoming']) {
    const p1 = project(maps, side, conflictKeys);
    const v1 = validateResult(p1.light, p1.circuit, p1.cue, p1.wiring);
    for (const key of v1.keys()) {
      if (!conflictKeys.has(key)) conflictKeys.add(key);
    }
  }
  for (const side of ['draft', 'incoming']) {
    const p2 = project(maps, side, conflictKeys);
    projViolations[side] = validateResult(p2.light, p2.circuit, p2.cue, p2.wiring);
  }

  // 引用耦合：某条 Cue/接线在某一侧需要某灯具/回路，而该灯具/回路在另一侧被删除
  // （自然结果缺失）。把被引用实体一并提升为冲突：要采用该侧 Cue/接线，
  // 必须同时在该侧保留灯具/回路；提示挂在相反侧的选择上。
  const extraReasons = new Map();
  const addExtra = (key, reason) => {
    if (!extraReasons.has(key)) extraReasons.set(key, []);
    extraReasons.get(key).push(reason);
  };
  for (const side of ['draft', 'incoming']) {
    const opposite = side === 'draft' ? 'incoming' : 'draft';
    for (const [key, list] of projViolations[side]) {
      for (const v of list) {
        if (v.code !== 'reference_missing') continue;
        const { kind } = parseKey(key);
        if (kind === 'cue') {
          addExtra(keyOf('light', v.detail.missing_light_id), {
            code: 'reference_dependency',
            side: opposite,
            detail: { by_kind: 'cue', by_id: parseKey(key).id },
          });
        } else if (kind === 'wiring') {
          addExtra(keyOf('circuit', v.detail.missing_circuit_id), {
            code: 'reference_dependency',
            side: opposite,
            detail: { by_kind: 'wiring', by_id: parseKey(key).id },
          });
        }
      }
    }
  }
  for (const key of extraReasons.keys()) {
    if (entryByKey.has(key)) conflictKeys.add(key);
  }

  const auto = [];
  const conflicts = [];

  // 规则类冲突（重名/引用）涉及的实体：依附于它们的自动新增项（如同编号新增灯的接线）
  // 不能自动生效——若该实体被抉择为不引入，自动项会悬空。降级为冲突，跟随主体抉择。
  const ruleConflictKinds = new Map(); // key -> true（含规则类原因即标记）
  for (const key of conflictKeys) {
    const e = entryByKey.get(key);
    if (e && e.status !== 'conflict') ruleConflictKinds.set(key, true);
  }

  for (const kind of KINDS) {
    for (const e of maps[kind]) {
      const reasons = [];
      if (e.status === 'conflict') reasons.push({ code: e.reason });
      for (const side of ['draft', 'incoming']) {
        for (const v of projViolations[side].get(e.key) || []) {
          reasons.push({ code: v.code, side, detail: v.detail });
        }
      }
      for (const v of extraReasons.get(e.key) || []) reasons.push(v);

      // 依附规则类冲突实体的自动新增项 → 降级为冲突（跟随主体取同侧）
      if (
        reasons.length === 0 &&
        e.status === 'incoming_added' &&
        ((kind === 'wiring' && ruleConflictKinds.has(keyOf('light', e.id))) ||
          (kind === 'cue' && ruleConflictKinds.has(keyOf('light', e.incoming.light_id))))
      ) {
        const hostKind = kind === 'wiring' ? 'light' : 'light';
        reasons.push({
          code: 'attached_to_conflict',
          detail: { host_kind: hostKind, host_id: kind === 'wiring' ? e.id : e.incoming.light_id },
        });
        conflictKeys.add(e.key);
      }

      if (conflictKeys.has(e.key)) {
        conflicts.push({
          kind,
          key: e.key,
          id: e.id,
          label: KIND_LABEL[kind],
          reason: reasons[0]?.code || e.reason,
          reasons,
          base: e.base,
          draft: e.draft,
          incoming: e.incoming,
        });
        continue;
      }

      // auto：仅保留会真正改动当前草稿的条目（草稿侧改动保持现状，不计入）
      let action = null;
      let applied = null;
      if (e.status === 'incoming_changed') {
        action = 'update'; // 待合入版本相对基线修改、草稿未动 → 采用该修改
        applied = e.incoming;
      } else if (e.status === 'incoming_added') {
        action = 'add'; // 待合入版本新增、草稿无同编号项 → 新增到草稿
        applied = e.incoming;
      } else if (e.status === 'incoming_deleted') {
        action = 'delete'; // 待合入版本删除、草稿原样保留 → 从草稿删除
        applied = null;
      }
      if (action) {
        auto.push({
          kind,
          key: e.key,
          id: e.id,
          label: KIND_LABEL[kind],
          action,
          base: e.base,
          current: e.draft,
          incoming: e.incoming,
          applied,
        });
      }
    }
  }

  const summary = {
    auto_total: auto.length,
    auto_add: auto.filter((e) => e.action === 'add').length,
    auto_update: auto.filter((e) => e.action === 'update').length,
    auto_delete: auto.filter((e) => e.action === 'delete').length,
    conflicts_total: conflicts.length,
  };

  return { auto, conflicts, conflictKeys, summary, maps, entryByKey };
}

/* ------------------------------ 抉择落地与校验 ------------------------------ */

/**
 * 依据页面抉择计算合并结果。
 * resolutions: { [`${kind}:${id}`]: 'draft' | 'incoming' }
 * 返回 {
 *   ok, final: {lights, circuits, cues, wiring},
 *   unresolved: [key], badResolutions: [{key,reason}], violations: [{key,code,detail}]
 * }
 */
function resolve(base, draft, incoming, resolutions = {}) {
  const cls = classify(base, draft, incoming);
  const entryByKey = cls.entryByKey;

  const badResolutions = [];
  const choice = new Map();
  for (const [key, side] of Object.entries(resolutions || {})) {
    if (!entryByKey.has(key)) {
      badResolutions.push({ key, reason: '该项目不在本次预览结果中（草稿可能已变化，请重新预览）' });
      continue;
    }
    if (side !== 'draft' && side !== 'incoming') {
      badResolutions.push({ key, reason: `抉择值无效：${JSON.stringify(side)}（须为 "draft" 或 "incoming"）` });
      continue;
    }
    choice.set(key, side);
  }

  const unresolved = [];
  for (const c of cls.conflicts) {
    if (choice.has(c.key)) continue;
    // 两侧取值相同的规则类冲突（如被重名牵连的同名灯、仅作联动提示的实体）：
    // 选哪一侧结果都一样，自动采用，不要求显式抉择
    if (c.status !== 'conflict' && sameValue(c.draft, c.incoming)) {
      choice.set(c.key, 'draft');
      continue;
    }
    // 附着冲突（随冲突主体新增的接线/Cue）：未显式抉择时跟随主体同侧
    const attached = c.reasons.find((r) => r.code === 'attached_to_conflict');
    if (attached) {
      const hostKey = keyOf(attached.detail.host_kind, attached.detail.host_id);
      const hostSide = choice.get(hostKey);
      if (hostSide) {
        choice.set(c.key, hostSide);
        continue;
      }
    }
    unresolved.push(c.key);
  }

  // 组装最终结果
  const out = {
    light: new Map(),
    circuit: new Map(),
    cue: new Map(),
    wiring: new Map(),
  };
  for (const kind of KINDS) {
    for (const e of cls.maps[kind]) {
      let v;
      if (cls.conflictKeys.has(e.key)) {
        const side = choice.get(e.key);
        v = side === undefined ? undefined : sideOutcome(side, e.draft, e.incoming);
      } else {
        v = naturalOutcome(e.status, e.base, e.draft, e.incoming);
      }
      if (v !== undefined && v !== null) {
        const id = kind === 'cue' ? v.cue_no : kind === 'wiring' ? v.light_id : v.id;
        out[kind].set(id, v);
      }
    }
  }

  // 未全部抉择时不做最终校验，先提示逐项选择
  let violations = [];
  if (badResolutions.length === 0 && unresolved.length === 0) {
    const vv = validateResult(out.light, out.circuit, out.cue, out.wiring);
    for (const [key, list] of vv) {
      for (const v of list) violations.push({ key, code: v.code, detail: v.detail });
    }
  }

  const finalState = {
    lights: [...out.light.values()]
      .sort((a, b) => a.id - b.id)
      .map((l) => {
        const w = out.wiring.get(l.id);
        return { id: l.id, name: l.name, circuit_id: w ? w.circuit_id : null, watts: w ? w.watts : null };
      }),
    circuits: [...out.circuit.values()].sort((a, b) => a.id - b.id),
    cues: [...out.cue.values()].sort((a, b) => a.cue_no - b.cue_no),
    wiring: [...out.wiring.values()].sort((a, b) => a.light_id - b.light_id),
  };

  return {
    ok: badResolutions.length === 0 && unresolved.length === 0 && violations.length === 0,
    final: finalState,
    auto: cls.auto,
    conflicts: cls.conflicts,
    summary: cls.summary,
    unresolved,
    badResolutions,
    violations,
  };
}

module.exports = {
  KINDS,
  KIND_LABEL,
  keyOf,
  parseKey,
  classify,
  resolve,
  validateResult,
};
