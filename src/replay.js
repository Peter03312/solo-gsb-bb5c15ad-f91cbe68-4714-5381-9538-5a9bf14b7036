'use strict';

/*
 * 共享房间复盘（事件重放）纯函数模块。
 *
 * 房间从创建（或本功能启用时的权威快照）起留存“生效事件”，每条事件含：
 *   - at_server：事件生效的服务端挂钟秒；
 *   - revision_after：生效后的房间修订号（同一时刻据此定序）；
 *   - 操作前后的时码（before_time/after_time）、速度、播放态与修订号。
 *
 * 任意时刻的播放状态完全由“截至该时刻（at_server 不晚于查询时刻、
 * 同一时刻按修订号）已生效事件”重放得到：
 *   - 暂停段时码不推进；
 *   - 播放段时码 = after_time + after_speed × (t − at_server)，但不超过版本末尾；
 *   - 跳转（seek）与改速（speed）从事件边界接续（事件 after_time 即边界时码）；
 *   - 到末尾自动停住是一条独立的 auto_stop 事件，发生在到达版本末尾的实际挂钟时刻；
 *   - 关闭（close）后冻结，不再推进。
 *
 * 本模块只做纯计算，不访问数据库，不依赖挂钟。
 */

/**
 * 把数据库行转成事件对象（数值字段做一次归一）。
 * 事件定序：at_server 升序，同一时刻 revision_after 升序，再以 id 兜底。
 */
function normalizeEvent(row) {
  return {
    id: row.id,
    seq: row.seq,
    type: row.type,
    at_server: row.at_server,
    revision_after: row.revision_after,
    before_time: row.before_time,
    after_time: row.after_time,
    before_playing: row.before_playing === null ? null : !!row.before_playing,
    after_playing: row.after_playing === null ? null : !!row.after_playing,
    before_speed: row.before_speed,
    after_speed: row.after_speed,
    before_revision: row.before_revision,
    after_revision: row.after_revision,
  };
}

function sortEvents(events) {
  return [...events].sort(
    (a, b) =>
      a.at_server - b.at_server ||
      a.revision_after - b.revision_after ||
      a.seq - b.seq ||
      a.id - b.id
  );
}

/**
 * 由已按定序排好的事件，重放挂钟时刻 at（秒）的房间播放状态。
 * duration 为房间固定版本的末尾时刻。返回：
 *   { playing, paused, at_end, closed, time, speed, revision, anchor_at, base_time, event }
 * 其中 event 为最后生效的那一条事件（留存起点之前无事件时为 null）。
 */
function stateAt(sortedEvents, duration, at) {
  const EPS = 1e-9;
  let state = null;
  let governing = null;
  for (const ev of sortedEvents) {
    if (ev.at_server <= at + EPS) {
      state = ev;
      governing = ev;
    } else {
      break;
    }
  }

  if (!state) {
    // 查询时刻早于留存起点：调用方负责拒绝；此处给出防御性空状态
    return {
      playing: false,
      paused: true,
      at_end: false,
      closed: false,
      time: 0,
      speed: 1,
      revision: 0,
      anchor_at: null,
      base_time: null,
      event: null,
    };
  }

  let time = state.after_time;
  let playing = state.after_playing;
  let atEnd = false;
  let closed = state.type === 'close';

  if (!closed && playing) {
    // 播放段：时码随挂钟按速度推进，到版本末尾即停（即使自动停住事件尚未被读到落库，
    // 只要查询点已越过末尾，复盘同样呈现“停在末尾”的状态）
    time = state.after_time + state.after_speed * (at - state.at_server);
    if (time >= duration) {
      time = duration;
      playing = false;
      atEnd = true;
    } else if (time < 0) {
      time = 0; // 防御：挂钟异常回拨时不为负
    }
  } else if (state.type === 'auto_stop') {
    atEnd = true;
  } else if (closed) {
    atEnd = state.after_time >= duration - EPS; // 零时长版本关闭时仍视为停在末尾
  } else if (state.after_time >= duration - EPS) {
    // 暂停在末尾（含跳转到末尾）即停住；duration=0 的房间创建时即在末尾
    atEnd = true;
  }

  return {
    playing,
    paused: !playing,
    at_end: atEnd,
    closed,
    time,
    speed: state.after_speed,
    revision: state.after_revision,
    anchor_at: state.at_server,
    base_time: state.after_time,
    event: governing,
  };
}

/**
 * 推断一条“播放中已到末尾”的自动停住事件实际发生挂钟时刻。
 * 由播放起始事件边界：t_end = at_server + (duration − after_time) / speed。
 */
function autoStopAt(ev, duration) {
  return ev.at_server + (duration - ev.after_time) / ev.after_speed;
}

module.exports = { normalizeEvent, sortEvents, stateAt, autoStopAt };
