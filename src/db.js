'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lights (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  created_at REAL NOT NULL,
  circuit_id INTEGER,                       -- 所属回路；NULL = 未分配（不计入任何回路负载）
  watts      REAL                           -- 正数额定瓦数；仅分配回路时填写
);

CREATE TABLE IF NOT EXISTS cues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cue_no     INTEGER NOT NULL,
  light_id   INTEGER NOT NULL REFERENCES lights(id),
  time       REAL NOT NULL CHECK (time >= 0),
  target     REAL NOT NULL CHECK (target >= 0 AND target <= 100),
  duration   REAL NOT NULL CHECK (duration >= 0),
  UNIQUE (cue_no)
);

CREATE INDEX IF NOT EXISTS idx_cues_time ON cues (time, cue_no);
CREATE INDEX IF NOT EXISTS idx_cues_light ON cues (light_id);

-- 灯光回路（草稿）：正数容量（瓦）。灯具经 lights.circuit_id 归属回路
CREATE TABLE IF NOT EXISTS circuits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  capacity   REAL NOT NULL CHECK (capacity > 0),
  created_at REAL NOT NULL
);

-- 已发布的不可变演出版本
CREATE TABLE IF NOT EXISTS versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  created_at REAL NOT NULL,
  cue_count  INTEGER NOT NULL DEFAULT 0
);

-- 版本快照：发布时灯具与 Cue 的完整冻结副本
CREATE TABLE IF NOT EXISTS version_lights (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  light_id   INTEGER NOT NULL,
  name       TEXT NOT NULL,
  pos        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS version_cues (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  cue_no     INTEGER NOT NULL,
  light_id   INTEGER NOT NULL,
  time       REAL NOT NULL,
  target     REAL NOT NULL,
  duration   REAL NOT NULL,
  pos        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_version_cues ON version_cues (version_id, time, cue_no);

-- 版本快照中的回路（早期版本可能无回路配置：该版负载恒为空）
CREATE TABLE IF NOT EXISTS version_circuits (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  circuit_id INTEGER NOT NULL,
  name       TEXT NOT NULL,
  capacity   REAL NOT NULL,
  pos        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS version_light_wiring (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  light_id   INTEGER NOT NULL,
  circuit_id INTEGER,                       -- 发布时所属回路；NULL = 未分配
  watts      REAL                           -- 发布时正数额定瓦数
);

CREATE INDEX IF NOT EXISTS idx_version_circuits ON version_circuits (version_id, pos);
CREATE INDEX IF NOT EXISTS idx_version_wiring ON version_light_wiring (version_id, light_id);

-- 临时调光记录：针对已发布版本建立，绑定版本快照，独立于草稿
CREATE TABLE IF NOT EXISTS rehearsal_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  label      TEXT NOT NULL,
  created_at REAL NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 0  -- 操作序列修订号：成功追加次数，过期提交按它判冲突
);

-- 记录中的操作序列（按 seq 追加顺序；同秒操作也按 seq 顺序生效）
CREATE TABLE IF NOT EXISTS record_ops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id  INTEGER NOT NULL REFERENCES rehearsal_records(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  light_id   INTEGER NOT NULL,
  time       REAL NOT NULL CHECK (time >= 0),
  op_type    TEXT NOT NULL CHECK (op_type IN ('override', 'return')),
  target     REAL,                       -- 仅 override 需要：0～100 目标亮度
  duration   REAL NOT NULL CHECK (duration >= 0),
  UNIQUE (record_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_record_ops ON record_ops (record_id, seq);

-- 共享排演房间：基于已发布版本创建，固定版本快照；服务端按挂钟推算当前时码
CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,        -- 6 位房间码（大写字母+数字，去除易混字符），凭码加入观看
  control_key TEXT NOT NULL,              -- 创建者控制密钥（48 位十六进制），仅创建响应中返回一次
  version_id  INTEGER NOT NULL REFERENCES versions(id),
  duration    REAL NOT NULL,              -- 房间固定版本的末尾时刻（建房间时由快照 Cue 推算）
  playing     INTEGER NOT NULL DEFAULT 0, -- 1=播放中 0=暂停
  base_time   REAL NOT NULL DEFAULT 0,    -- 基准时码（anchor_at 时刻对应的演出秒数）
  speed       REAL NOT NULL DEFAULT 1,    -- 播放速度：仅允许 0.5 / 1 / 2
  anchor_at   REAL NOT NULL,              -- 状态写入时的服务器挂钟秒数（Date.now()/1000，重启后仍可推算）
  at_end      INTEGER NOT NULL DEFAULT 0, -- 是否已到版本末尾自动停住
  revision    INTEGER NOT NULL DEFAULT 0, -- 修订号：每次成功控制（含自动停住）+1，控制请求乐观并发
  created_at  REAL NOT NULL
);

-- 草稿合并预览令牌：预览不写库，提交时凭令牌校验抉择并确认草稿未被改动
CREATE TABLE IF NOT EXISTS merge_previews (
  token        TEXT PRIMARY KEY,
  base_id      INTEGER NOT NULL REFERENCES versions(id),
  incoming_id  INTEGER NOT NULL REFERENCES versions(id),
  -- 生成预览时草稿内容（灯具/回路/Cue/接线）的版本戳；提交时须与当前一致
  draft_stamp  TEXT NOT NULL,
  -- 预览给出的自动改动与冲突（JSON），提交时复核抉择只能引用其中的冲突项
  payload      TEXT NOT NULL,
  created_at   REAL NOT NULL
);
`;

let db;

// 既有库的轻量迁移：早期 lights 表没有回路字段，按需补列（新库由建表语句直接包含）
function migrate(database) {
  const cols = database.prepare('PRAGMA table_info(lights)').all().map((c) => c.name);
  if (!cols.includes('circuit_id')) {
    database.exec('ALTER TABLE lights ADD COLUMN circuit_id INTEGER');
  }
  if (!cols.includes('watts')) {
    database.exec('ALTER TABLE lights ADD COLUMN watts REAL');
  }
}

function open(dbPath) {
  if (db) return db;
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function get() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

module.exports = { open, get };
