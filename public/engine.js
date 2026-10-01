/*
 * 灯光 Cue 渐变引擎（纯函数，无依赖）
 * 浏览器与 Node 共用：浏览器挂到 window.LightingEngine，Node 通过 module.exports 引入。
 *
 * 规则：
 *  - 每条 Cue 在 time 秒触发，把指定灯具从触发瞬间的“实际亮度”线性渐变到 target，
 *    渐变耗时 duration 秒（0 表示瞬变）。
 *  - 新 Cue 到来时，若该灯仍在上一条 Cue 的渐变中，以上一渐变在该时刻的实际亮度
 *    为起点转向新目标（中途接管，不跳变）。
 *  - 同一秒触发的多条 Cue，按 Cue 编号（cue_no）从小到大依次生效：
 *      · 前一条是普通渐变时，它在同一瞬间尚未来得及渐变，起点取其起始亮度；
 *      · 前一条是 0 秒瞬变时，它先一步跳到目标，起点取其目标亮度。
 *  - 亮度始终限制在 0～100。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LightingEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 0;
  const MAX = 100;

  function clamp(v) {
    if (v < MIN) return MIN;
    if (v > MAX) return MAX;
    return v;
  }

  /**
   * 整理一场演出的 Cue：按触发时码、再按 Cue 编号（同秒先后次序）排序，
   * 并为每盏灯把 Cue 展开成“渐变段”，预先记录每条 Cue 触发瞬间的实际起始亮度。
   * cue 字段：{ cue_no, light_id, time, target, duration }
   */
  function prepareCues(cues) {
    const ordered = cues
      .map((c) => ({
        cueNo: c.cue_no,
        lightId: c.light_id,
        time: Number(c.time),
        target: clamp(Number(c.target)),
        duration: Number(c.duration),
        end: Number(c.time) + Number(c.duration),
        from: 0, // 触发瞬间的实际亮度，下面按灯逐条计算
      }))
      .sort((a, b) => a.time - b.time || a.cueNo - b.cueNo);

    // 每盏灯只与自己的上一条 Cue 衔接
    const last = new Map();
    for (const seg of ordered) {
      const prev = last.get(seg.lightId);
      if (!prev) {
        seg.from = 0; // 该灯的第一条 Cue：从熄灭状态起步
      } else if (seg.time > prev.time) {
        if (seg.time >= prev.end || prev.duration === 0) {
          seg.from = prev.target; // 上一渐变已结束（或为瞬变）：保持在目标
        } else {
          // 中途接管：取上一渐变在新 Cue 触发时刻的实际亮度
          const k = (seg.time - prev.time) / prev.duration;
          seg.from = clamp(prev.from + (prev.target - prev.from) * k);
        }
      } else {
        // 同一时刻触发（已按编号排好序）：
        // 瞬变 Cue 先一步跳到目标；普通渐变此刻还未产生变化，取其起始亮度
        seg.from = prev.duration === 0 ? prev.target : prev.from;
      }
      last.set(seg.lightId, seg);
    }
    return ordered;
  }

  /**
   * 计算 t 秒时某盏灯的实际亮度：
   * 只需找到该灯“触发时刻 <= t”的最后一条 Cue（即当前生效段）。
   */
  function brightnessAt(orderedCues, lightId, t) {
    let active = null;
    for (const seg of orderedCues) {
      if (seg.lightId !== lightId) continue;
      if (seg.time > t) break; // 全局已按 time, cueNo 排序
      active = seg;
    }
    if (!active) return 0;
    if (active.duration === 0 || t >= active.end) return active.target;
    const k = (t - active.time) / active.duration;
    return clamp(active.from + (active.target - active.from) * k);
  }

  /** 整场演出所有灯具在 t 秒的亮度表 { lightId: brightness } */
  function levelsAt(orderedCues, lights, t) {
    const out = {};
    for (const l of lights) {
      out[l.id] = brightnessAt(orderedCues, l.id, t);
    }
    return out;
  }

  /** 演出总时长 = 最后一条 Cue 渐变结束时刻（无 Cue 时为 0） */
  function showDuration(orderedCues) {
    let d = 0;
    for (const c of orderedCues) {
      if (c.end > d) d = c.end;
    }
    return d;
  }

  /* --------------------- 两版亮度差区间（精确解析解） --------------------- */

  // 浮点容差：用于“本应相等”的端点归类（阈值交点、重复转折点），
  // 输出也按 1e-9 四舍五入，避免二进制末位噪声。
  const EPS = 1e-9;

  function norm9(x) {
    const r = Math.round(x * 1e9) / 1e9;
    return r === 0 ? 0 : r;
  }

  /** 收集一版中某盏灯落在 [start, end] 内的全部转折点（Cue 触发时刻 + 渐变结束时刻） */
  function collectBreakpoints(orderedCues, lightId, start, end, out) {
    for (const seg of orderedCues) {
      if (seg.lightId !== lightId) continue;
      if (seg.time >= start && seg.time <= end) out.push(seg.time);
      if (seg.end >= start && seg.end <= end) out.push(seg.end);
    }
  }

  /**
   * 取 t 所在开区间上该灯亮度的线性表达式 b(t) = a*t + b0。
   * 调用方保证 t 不落在任何转折点上：此时生效段唯一，亮度必为线性（含常量）。
   */
  function lineAt(orderedCues, lightId, t) {
    let active = null;
    for (const seg of orderedCues) {
      if (seg.lightId !== lightId) continue;
      if (seg.time > t) break; // 全局已按 time, cueNo 排序
      active = seg;
    }
    if (!active) return { a: 0, b: 0 };
    if (active.duration === 0 || t >= active.end) return { a: 0, b: active.target };
    const a = (active.target - active.from) / active.duration;
    return { a, b: active.from - a * active.time };
  }

  function snapEdge(x, u, v) {
    if (Math.abs(x - u) <= EPS) return u;
    if (Math.abs(x - v) <= EPS) return v;
    return x;
  }

  /**
   * 开区间 (u,v) 内 L(t)=a*t+b0 为线性，求 |L| > threshold 的部分，
   * 以两端开区间形式加入 pieces（端点是否属于集合由转折点上的单点决定）。
   */
  function pushAbsLinearPieces(pieces, a, b0, u, v, threshold) {
    const open = (lo, hi) => {
      if (hi - lo > EPS) pieces.push({ lo, hi, loInc: false, hiInc: false });
    };
    if (Math.abs(a) <= EPS) {
      if (Math.abs(b0) - threshold > EPS) open(u, v);
      return;
    }
    // 根的处理：
    //  - 距端点 ≤ EPS（含恰在端点）：吸附到端点，随后夹取会退化为零宽分片被丢弃
    //    （严格大于的交点本身不含）；
    //  - 真正落在段外：夹取后退化为零宽，同样不产生分片（不能把端点误算成包含）；
    //  - 严格落在内部：正常切分开区间。
    const edgeOrClip = (r) => {
      const s = snapEdge(r, u, v);
      return s === r ? Math.min(v, Math.max(u, r)) : s;
    };
    const rHi = edgeOrClip((threshold - b0) / a);  // L = +threshold
    const rLo = edgeOrClip((-threshold - b0) / a); // L = -threshold
    if (a > 0) {
      if (rHi < v) open(rHi, v); // L > threshold：t > rHi
      if (rLo > u) open(u, rLo); // L < -threshold：t < rLo
    } else {
      if (rHi > u) open(u, rHi); // L > threshold：t < rHi
      if (rLo < v) open(rLo, v); // L < -threshold：t > rLo
    }
  }

  /**
   * 开区间 (u,v) 内 L(t)=a2*t^2+a1*t+b0 为二次多项式，求 L(t) > threshold
   * （严格大于：回路负载超载语义）的部分，以两端开区间加入 pieces。
   * 归还融合段的实际亮度是“线性进度 × 原版亮度（本身线性）”，回路负载随之呈二次形，
   * 必须用求根公式精确求解，不能按固定步长采样（否则会漏掉夹在转折点之间的短时超载）。
   */
  function pushQuadraticPieces(pieces, a2, a1, b0, u, v, threshold) {
    const open = (lo, hi) => {
      if (hi - lo > EPS) pieces.push({ lo, hi, loInc: false, hiInc: false });
    };
    const c = b0 - threshold; // 求 a2*t^2+a1*t+c > 0
    const edgeOrClip = (r) => {
      const e = snapEdge(r, u, v);
      return e === r ? Math.min(v, Math.max(u, r)) : e;
    };
    if (Math.abs(a2) <= 1e-14) {
      // 退化为一次/常数
      if (Math.abs(a1) <= EPS) {
        if (c > EPS) open(u, v);
        return;
      }
      const r = edgeOrClip(-c / a1);
      if (a1 > 0) {
        if (r < v) open(r, v); // L > threshold：t > r
      } else if (r > u) {
        open(u, r);
      }
      return;
    }
    const disc = a1 * a1 - 4 * a2 * c;
    if (disc < -EPS) {
      // 无实根：开口向上恒为正，开口向下恒为负
      if (a2 > 0) open(u, v);
      return;
    }
    const s = Math.sqrt(Math.max(disc, 0));
    const raw = [(-a1 - s) / (2 * a2), (-a1 + s) / (2 * a2)].sort((x, y) => x - y);
    // 近端点吸附（交点本身不含），段外根夹成退化段被丢弃
    const r1 = edgeOrClip(raw[0]);
    const r2 = edgeOrClip(raw[1]);
    if (a2 > 0) {
      // 开口向上：两根之外为正
      if (r1 > u) open(u, r1);
      if (r2 < v) open(r2, v);
    } else {
      // 开口向下：两根之间为正
      if (r1 < v && r2 > u) open(r1, r2);
    }
  }

  /**
   * 区间集合精确求解的通用核心：
   * 在排好序的转折点 points 上逐点用 valueAt(p) 判定（捕捉瞬变造成的孤立单点），
   * 相邻转折点之间由调用方通过 pushOpenPieces(pieces, u, v) 追加开端点分片，
   * 最后用 unionPieces 合并（夹在中间的闭单点可桥接两侧区间）。
   */
  function exceedanceIntervals(points, valueAt, pushOpenPieces) {
    const pieces = [];
    for (const p of points) {
      if (valueAt(p)) pieces.push({ lo: p, hi: p, loInc: true, hiInc: true });
    }
    for (let i = 0; i + 1 < points.length; i++) {
      const u = points[i];
      const v = points[i + 1];
      if (!(v - u > EPS)) continue; // 近重复点造成的退化段
      pushOpenPieces(pieces, u, v);
    }
    return unionPieces(pieces);
  }

  /**
   * 合并一维区间（含端点包含性）。相邻 [..,x] 与 [x,..] 只要任一侧包含 x 即连通，
   * 因此夹在中间的闭单点（瞬变造成的孤立超差时刻）能把两侧区间桥接起来。
   */
  function unionPieces(input) {
    const ps = input
      .map((p) => ({ ...p }))
      .sort((x, y) => x.lo - y.lo || Number(y.loInc) - Number(x.loInc));
    const out = [];
    for (const p of ps) {
      let cur = p;
      while (out.length) {
        const q = out[out.length - 1];
        const atJoint = Math.abs(cur.lo - q.hi) <= EPS;
        const overlap = cur.lo < q.hi && !atJoint;
        if (!overlap && !(atJoint && (q.hiInc || cur.loInc))) break;
        out.pop();
        let lo, loInc, hi, hiInc;
        if (q.lo < cur.lo) { lo = q.lo; loInc = q.loInc; }
        else if (cur.lo < q.lo) { lo = cur.lo; loInc = cur.loInc; }
        else { lo = q.lo; loInc = q.loInc || cur.loInc; }
        if (q.hi > cur.hi) { hi = q.hi; hiInc = q.hiInc; }
        else if (cur.hi > q.hi) { hi = cur.hi; hiInc = cur.hiInc; }
        else { hi = q.hi; hiInc = q.hiInc || cur.hiInc; }
        cur = { lo, hi, loInc, hiInc };
      }
      out.push(cur);
    }
    return out
      .filter((p) => p.hi - p.lo > EPS || (p.loInc && p.hiInc))
      .map((p) => ({
        start: norm9(p.lo),
        end: norm9(p.hi),
        start_inclusive: p.loInc,
        end_inclusive: p.hiInc,
      }));
  }

  /**
   * 计算时窗 [start, end] 内，某盏灯在两版间亮度差严格大于 threshold 的全部连续区间。
   *
   * 精确做法（不做固定间隔采样）：
   *  1. 转折点 = 两版该灯全部 Cue 触发时刻与渐变结束时刻（再加时窗端点）。
   *     瞬变只在触发点造成跳变，其余位置两版亮度均连续（中途接管不跳变）。
   *  2. 相邻转折点之间，两版亮度各为一条直线，差值 |L(t)| 为线性函数取绝对值，
   *     与 ±threshold 的交点用一次方程精确求出，严格大于故交点本身为开端点。
   *  3. 每个转折点处按引擎语义（同秒编号顺序、瞬变、接管）取真实亮度，
   *     超差则作为闭单点参与合并，从而准确界定跳变时刻的端点包含性
   *     （含“仅某一瞬间超差”的零长度区间 [t,t]）。
   *
   * cuesA/cuesB 均为 prepareCues 的结果；start === end（零长度时窗）返回 []。
   */
  function differenceIntervals(cuesA, cuesB, lightId, start, end, threshold) {
    if (!(end > start)) return [];

    const bp = [start, end];
    collectBreakpoints(cuesA, lightId, start, end, bp);
    collectBreakpoints(cuesB, lightId, start, end, bp);
    bp.sort((x, y) => x - y);
    const points = [];
    for (const t of bp) {
      if (!points.length || points[points.length - 1] !== t) points.push(t);
    }

    return exceedanceIntervals(
      points,
      // 转折点上的真实取值（瞬变跳变只可能发生在这里）
      (p) =>
        Math.abs(brightnessAt(cuesA, lightId, p) - brightnessAt(cuesB, lightId, p)) -
          threshold >
        EPS,
      // 相邻转折点之间：差值为 |线性函数|，精确解交点
      (pieces, u, v) => {
        const m = (u + v) / 2;
        const la = lineAt(cuesA, lightId, m);
        const lb = lineAt(cuesB, lightId, m);
        pushAbsLinearPieces(pieces, la.a - lb.a, la.b - lb.b, u, v, threshold);
      }
    );
  }

  /* --------------------- 临时调光（覆盖 / 归还）记录 --------------------- */

  /**
   * 段 seg 在时刻 t 的输出。仅依赖 seg.from（准备阶段已按前一段算好）与原版亮度，
   * 无需继续向前追溯：中途接管时 seg.from 就是接管起点。
   */
  function segOutput(seg, t, baseCues) {
    const base = (tt) => brightnessAt(baseCues, seg.lightId, tt);
    if (seg.duration === 0) {
      // 0 秒操作立即生效：覆盖跳到目标；归还是一条立即完成的融合，此后完全跟随原版
      return seg.opType === 'override' ? seg.target : base(t);
    }
    if (t <= seg.time) return seg.from;
    if (t >= seg.end) {
      // 覆盖到达目标后保持；归还结束后完全跟随原版
      return seg.opType === 'override' ? seg.target : base(t);
    }
    const k = (t - seg.time) / seg.duration;
    if (seg.opType === 'override') {
      return clamp(seg.from + (seg.target - seg.from) * k);
    }
    // 归还：按进度与该时刻持续变化的原版亮度线性融合
    return clamp(seg.from + (base(t) - seg.from) * k);
  }

  /**
   * 展开一份临时调光记录的操作序列。
   *
   * 操作字段：{ seq, light_id, time, op_type: 'override'|'return', target?, duration }
   * 原版 Cue 仍按既有规则在后台运行（baseCues 为 prepareCues 的结果）。
   *
   * 规则：
   *  - 覆盖(override)：从操作瞬间的【实际输出】线性渐变到 target（0～100），此后保持，
   *    直到被后续操作接管；duration 为 0 立即生效。
   *  - 归还(return)：以操作瞬间的【实际输出】为起点，在 duration 内按进度
   *    与该时刻【持续变化的原版亮度】线性融合（凸组合），结束后完全跟随原版。
   *  - 下一操作可在渐变未完成时接管，起点一律取该时刻实际输出（不跳变、不重置）；
   *    同一时刻（同秒）的多条操作按 seq 追加顺序逐条生效（与 Cue 同秒编号顺序同理）。
   *
   * 返回按灯具分组的段数组（保持全局 time, seq 顺序），每段预存起始亮度 from。
   */
  function prepareOverrides(ops, baseCues) {
    const ordered = ops
      .map((o) => ({
        seq: Number(o.seq),
        lightId: Number(o.light_id),
        time: Number(o.time),
        opType: o.op_type,
        target: o.op_type === 'override' ? clamp(Number(o.target)) : null,
        duration: Number(o.duration),
        end: Number(o.time) + Number(o.duration),
        from: 0, // 操作瞬间的实际输出，下面逐条计算
      }))
      .sort((a, b) => a.time - b.time || a.seq - b.seq);

    const last = new Map(); // 每盏灯的上一段（已按 time, seq 排好序）
    for (const seg of ordered) {
      const prev = last.get(seg.lightId);
      if (!prev) {
        seg.from = brightnessAt(baseCues, seg.lightId, seg.time);
      } else {
        // 含中途接管（此刻上一段仍在渐变中）与同秒顺序（0 秒操作已生效、普通渐变 k=0）
        seg.from = segOutput(prev, seg.time, baseCues);
      }
      last.set(seg.lightId, seg);
    }

    const byLight = new Map();
    for (const seg of ordered) {
      if (!byLight.has(seg.lightId)) byLight.set(seg.lightId, []);
      byLight.get(seg.lightId).push(seg);
    }
    return byLight;
  }

  /** 某盏灯在临时调光记录下 t 时刻的实际输出 */
  function overrideBrightnessAt(byLight, baseCues, lightId, t) {
    const segs = byLight.get(lightId);
    if (!segs) return brightnessAt(baseCues, lightId, t);
    let active = null;
    for (const seg of segs) {
      if (seg.time > t) break; // 已按 time, seq 排序
      active = seg;
    }
    if (!active) return brightnessAt(baseCues, lightId, t);
    return segOutput(active, t, baseCues);
  }

  /**
   * 某盏灯在 t 时刻是否处于临时接管状态，供界面标注：
   * 'override'（覆盖保持/渐变中）| 'return'（归还融合中）| null（完全跟随原版）。
   * 0 秒归还立即完成，除操作瞬间外均跟随原版，状态按 null 处理。
   */
  function activeOverride(byLight, lightId, t) {
    const segs = byLight.get(lightId);
    if (!segs) return null;
    let active = null;
    for (const seg of segs) {
      if (seg.time > t) break;
      active = seg;
    }
    if (!active) return null;
    if (active.opType === 'override') return { seg: active, state: 'override' };
    if (active.duration > 0 && t < active.end) return { seg: active, state: 'return' };
    return null;
  }

  /** 记录下整场（快照灯具）在 t 时刻的逐灯实际输出表 */
  function overrideLevelsAt(byLight, baseCues, lights, t) {
    const out = {};
    for (const l of lights) {
      out[l.id] = overrideBrightnessAt(byLight, baseCues, l.id, t);
    }
    return out;
  }

  /* --------------------- 回路负载与超载区间（精确解析解） --------------------- */

  /**
   * 某盏灯在时刻 t 的实际亮度关于 t 的多项式（在不含转折点的开区间内成立）：
   * 返回 { a2, a1, b0 }，表示 b(t)=a2*t^2+a1*t+b0。
   *  - 跟随原版 / 覆盖渐变 / 覆盖保持：至多一次；
   *  - 归还融合：进度与“持续变化的原版亮度”（一次）相乘，产生二次项；
   *  - 0 秒瞬变：常量（取值语义与 overrideBrightnessAt 完全一致，含同秒顺序）。
   */
  function brightnessPolyAt(byLight, baseCues, lightId, t) {
    const segs = byLight.get(lightId);
    let active = null;
    if (segs) {
      for (const seg of segs) {
        if (seg.time > t) break;
        active = seg;
      }
    }
    if (!active) {
      const l = lineAt(baseCues, lightId, t);
      return { a2: 0, a1: l.a, b0: l.b };
    }
    if (active.duration === 0 || t >= active.end) {
      if (active.opType === 'override') return { a2: 0, a1: 0, b0: active.target };
      const l = lineAt(baseCues, lightId, t); // 归还已结束 / 0 秒归还：跟随原版
      return { a2: 0, a1: l.a, b0: l.b };
    }
    if (active.opType === 'override') {
      const a1 = (active.target - active.from) / active.duration;
      return { a2: 0, a1, b0: active.from - a1 * active.time };
    }
    // 归还融合：(1-k)*from + k*base(t)，k=(t-time)/duration，base(t)=ga*t+gb
    const g = lineAt(baseCues, lightId, t);
    const d = active.duration;
    const a2 = g.a / d;
    const a1 = (g.b - active.from) / d - (g.a * active.time) / d;
    const b0 = active.from - ((g.b - active.from) * active.time) / d;
    return { a2, a1, b0 };
  }

  /** 多项式 {a2,a1,b0} 在 t 点的值 */
  function evalPoly(p, t) {
    return p.a2 * t * t + p.a1 * t + p.b0;
  }

  /**
   * 收集一盏灯落在 [start,end] 内、可能改变实际亮度表达式的全部转折点：
   * 原版 Cue 的触发时刻/渐变结束时刻，以及覆盖/归还操作的触发时刻/结束时刻。
   * 归还段内部原版若发生转折（Cue 触发、渐变结束），该点已包含在原版转折点中。
   */
  function collectActualBreakpoints(byLight, baseCues, lightId, start, end, out) {
    collectBreakpoints(baseCues, lightId, start, end, out);
    const segs = byLight.get(lightId);
    if (!segs) return;
    for (const seg of segs) {
      if (seg.time >= start && seg.time <= end) out.push(seg.time);
      if (seg.end >= start && seg.end <= end) out.push(seg.end);
    }
  }

  /**
   * 计算时窗 [start,end] 内某条回路负载【严格大于】容量的全部连续区间。
   *
   * 负载(t) = Σ（灯实际亮度 / 100 × 额定瓦数），仅 members（已分配到本回路的灯具）计入。
   * 实际亮度按既有规则（线性渐变、同秒顺序、瞬变、中途接管、覆盖/归还融合）计算。
   *
   * 精确做法（不做固定步长采样）：
   *  1. 转折点 = 本回路全部灯具的原版 Cue 转折点 + 覆盖/归还转折点（再加时窗端点）；
   *  2. 相邻转折点之间，每盏灯的实际亮度至多为二次多项式，回路负载也是二次多项式，
   *     与容量的关系用二次求根公式精确求解，严格大于故交点为开端点；
   *  3. 每个转折点按真实取值判定，超载则作为闭单点参与合并（瞬变可造成孤立超载瞬间）。
   *
   * members: [{ light_id, watts }]；start === end（零长度时窗）返回 []。
   */
  function circuitOverloadIntervals(byLight, baseCues, members, start, end, capacity) {
    if (!(end > start)) return [];

    const bp = [start, end];
    for (const m of members) {
      collectActualBreakpoints(byLight, baseCues, m.light_id, start, end, bp);
    }
    bp.sort((x, y) => x - y);
    const points = [];
    for (const t of bp) {
      if (!points.length || points[points.length - 1] !== t) points.push(t);
    }

    // 回路负载多项式 = 各灯实际亮度多项式按 瓦数/100 加权求和
    const loadPolyAt = (t) => {
      const sum = { a2: 0, a1: 0, b0: 0 };
      for (const m of members) {
        const p = brightnessPolyAt(byLight, baseCues, m.light_id, t);
        const w = m.watts / 100;
        sum.a2 += p.a2 * w;
        sum.a1 += p.a1 * w;
        sum.b0 += p.b0 * w;
      }
      return sum;
    };
    const loadAt = (t) => evalPoly(loadPolyAt(t), t);

    return exceedanceIntervals(
      points,
      (p) => loadAt(p) - capacity > EPS,
      (pieces, u, v) => {
        const p = loadPolyAt((u + v) / 2);
        pushQuadraticPieces(pieces, p.a2, p.a1, p.b0, u, v, capacity);
      }
    );
  }

  /** 某条回路在 t 时刻的负载（瓦）：每灯 实际亮度/100×额定瓦数 之和 */
  function circuitLoadAt(byLight, baseCues, members, t) {
    let load = 0;
    for (const m of members) {
      load += (overrideBrightnessAt(byLight, baseCues, m.light_id, t) / 100) * m.watts;
    }
    return load;
  }

  return {
    clamp,
    prepareCues,
    brightnessAt,
    levelsAt,
    showDuration,
    differenceIntervals,
    prepareOverrides,
    overrideBrightnessAt,
    overrideLevelsAt,
    activeOverride,
    brightnessPolyAt,
    circuitOverloadIntervals,
    circuitLoadAt,
  };
});
