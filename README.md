# 小剧场灯光 Cue 排演（Lighting Cue Rehearsal）

一款用于小剧场灯光排演的 Web 应用。录入**灯具**与按演出秒数触发的 **Cue**
（灯具编号、目标亮度、非负渐变时长），所有灯光效果都在浏览器中模拟，**无需连接任何真实灯具**。
支持播放 / 暂停 / 跳转，并实时显示任意时刻每盏灯的实际亮度；发布后生成**不可变演出版本**。
排演人员还可针对已发布版本建立**临时调光记录**，按演出时码追加「覆盖 / 归还」操作，
随时查看任意时刻的**逐灯实际输出**；记录绑定版本快照，草稿修改与新版本发布都不影响既有记录。
此外可在草稿期配置**灯光回路**（正数容量）与灯具的所属回路/正数额定瓦数，随发布一并冻结，
并对已发布版本或绑定它的调光记录做**回路超载预判**：返回查看时刻负载与时窗内严格超出容量的
全部连续区间（精确求根，不做固定步长采样）。
排演人员还可基于一个已发布版本创建**共享房间**：创建者取得控制密钥，其他人凭 6 位房间码
观看同一舞台与逐灯亮度；服务端按挂钟时间推算当前时码、到版本末尾自动停住，页面刷新、
服务重启或观看者重连后均能恢复房间进度，后续草稿修改与新版本发布不影响已建房间。

技术栈：Node.js + Express + SQLite（better-sqlite3），原生 HTML/CSS/JS 前端，无前端构建步骤。

## 灯光规则

- 亮度范围 **0～100**，按**线性渐变**变化。
- 每条 Cue 在指定时码（非负秒数，支持小数）触发，把目标灯具从触发瞬间的**实际亮度**
  渐变到目标亮度；渐变时长为非负秒数，`0` 表示瞬变。
- **中途接管**：新 Cue 到来时，若同一盏灯仍在渐变中，效果从该时刻的实际亮度直接转向
  新目标（不跳变、不重置）。
- **同秒顺序**：同一秒触发的多条 Cue，按 Cue 编号（正整数、唯一）从小到大依次生效。
- **不可变版本**：发布即对当前灯具与草稿 Cue 做完整快照。开始播放后始终使用开始时所选的
  版本；之后继续编辑草稿或发布新版本，都不会影响正在/已开始的那次播放。
- 提交校验：非法时码（负数/非数字）、未知灯具编号、无效亮度（超出 0～100/非数字）
  或非法渐变时长会明确指出错误，并且**整次提交被拒绝**（批量录入任意一行非法则全部不落库）。

## 临时调光记录（覆盖 / 归还）

排演人员可针对**已发布版本**建立独立的临时调光记录（不改动任何版本与草稿）：

- **绑定快照**：记录建立时绑定该版本完整快照；原版 Cue 仍按既有规则（线性渐变、同秒顺序、
  中途接管）在后台运行。之后修改草稿或发布新版本**都不改变既有记录**。
- **覆盖（override）**：从操作瞬间的**实际输出**线性渐变到 0～100 的目标亮度，此后保持，
  直到被后续操作接管；时长 0 秒立即生效。
- **归还（return）**：以操作瞬间的**实际输出**为起点，在指定时长内按进度（0→1）
  与该时刻**持续变化的原版亮度**线性融合，结束后完全跟随原版；时长 0 秒立即生效。
- **接管与同秒**：下一操作可接管未完成的渐变（起点取接管瞬间实际输出，不跳变）；
  同一时码的多条操作按**追加顺序**依次生效。
- **操作字段**：灯具、非负时码、类型（`override`/`return`）、非负时长；覆盖另需目标亮度 0～100。
- **只准追加**：时码不得早于末项操作（同秒可继续追加）。
- **修订号（乐观并发）**：每次成功追加后记录修订号 +1，提交必须携带当前修订号；
  过期修订号返回 **409 冲突且不写入**，刷新后可用最新序列重试。
- **原子提交**：无效参数、未知灯具（不在绑定快照中）、时码回退、记录不存在等都明确报错，
  整次提交（含批量）**不部分写入**。
- **随时重算**：跳转或刷新页面后，依据绑定的版本快照与操作序列重算任意时刻逐灯实际输出
  （页面地址栏 `#record=<id>&t=<时刻>` 可直接定位到某记录的某时刻）。

## 回路负载预判（超载区间）

排演时还可预判灯光回路是否超载：

- **草稿配置**：在灯具页建立回路并设置**正数容量（瓦）**；为每盏灯选择所属回路并登记
  **正数额定瓦数**。**未分配回路**的灯具不计入任何回路负载。
- **随发布冻结**：发布版本时连同灯具、Cue 一起把回路与接线（灯具→回路、额定瓦数）
  写入不可变快照；之后再改草稿回路配置不影响已发布版本，也不影响绑定该版本的调光记录。
  早于本功能发布、快照内没有回路配置的旧版本仍可正常播放，负载分析返回空回路（不产生负载）。
- **分析目标**：选择一个**已发布版本**，或**绑定它的临时调光记录**（后者按覆盖/归还后的
  实际输出计算）。给定**非负时窗** `[start,end]` 与窗内查看时刻 `at`。
- **负载口径**：每盏灯 `实际亮度 ÷ 100 × 额定瓦数`，按所属回路汇总（实际亮度遵循线性渐变、
  同秒顺序、瞬变、中途接管，以及归还时与持续变化的原版亮度融合等既有规则）。
- **返回内容**：查看时刻各回路的负载/余量/是否超载，与时窗内负载**严格大于**容量的
  **全部连续区间**及端点包含性（`[ ]` 含端点、`( )` 不含端点；零长度时窗只返回该时刻负载）。
- **精确解析，不做固定步长采样**：相邻转折点（Cue 触发/渐变结束、覆盖/归还操作的触发与结束）
  之间，每灯实际亮度至多为一次式；归还融合段为“线性进度 × 原版线性亮度”，回路负载呈
  **二次形**，系统用一次/二次方程精确求根，因此夹在转折点之间的极短超载也不会漏。
- **只读**：分析不修改草稿、版本、调光记录，也不影响播放；既有亮度接口语义保持不变。
- **明确拒绝**：非正数容量、非正数额定瓦数、引用不存在的回路、负数/非数字时窗、起点大于终点、
  查看时刻越界、分析目标缺失或同时给出版本与记录等，均返回 `400/404` 中文错误且**不部分保存**。

## 草稿三方合并（把另一已发布版本合入当前草稿）

两组排演人员从**同一已发布版本**分别改稿后，可把另一组发布的版本合入当前草稿：

- **输入**：`base_version_id`（两组共同的基线版本）与 `incoming_version_id`（另一组发布的
  待合入版本）；当前草稿（draft）为其中一方的成果。
- **比较维度**：按**灯具/回路编号、Cue 编号、灯具接线**（灯具→回路、额定瓦数）做三方比较。
- **自动合入**：仅一侧改动（待合入侧的新增/修改/删除，草稿侧未动）、或两侧改成相同内容。
  草稿侧自身的改动保持现状。
- **列为冲突**（页面可逐项选择**保留草稿**或**采用待合入版本**）：
  - 两侧相对基线做了**不同修改**；
  - **删除与修改并存**（一侧删除、另一侧改名/改值）；
  - **同编号新增异值**（两侧都新增了同一编号但内容不同）；
  - **名称重名**（灯具名称、回路名称唯一；会在会导致重名的那一侧标注警示）；
  - **Cue 引用缺失**（Cue 引用的灯具在合并结果中不存在）；
  - **接线引用缺失**（接线指向的回路在合并结果中不存在）；
  - Cue/接线所依赖的灯具/回路在另一侧被删除时，被引用实体作为**联动冲突**一并列出，
    需与引用方选择同一侧；随冲突灯具新增的接线等**附着项**自动跟随主体同侧。
- **预览不写库**：`POST /api/merge/preview` 只读比较并返回自动改动、冲突两侧值与一次性
  预览令牌（`token`）。
- **提交规则**：`POST /api/merge/commit` 携带令牌与逐项 `resolutions`。
  - 草稿在预览之后被编辑过（灯具/回路/接线/Cue 任一变化）→ **409**，令牌作废，须重新预览；
  - 仍有冲突未选择、抉择值非法、或最终结果仍违反唯一性/引用规则 → **400 整次拒绝**，不写入；
  - 通过后以**一次事务**重写灯具、回路、接线和 Cue，返回合并后的新草稿；
  - **已发布版本及绑定它们的调光记录不变**（快照不可变）。
- 预览令牌有效期 24 小时，成功提交后立即失效（一次性）。

调用示例见下文「草稿合并 HTTP API」。

## 共享排演房间（房间码 + 控制密钥）

排演人员可基于一个**已发布版本**创建共享房间，让多人同步观看同一舞台与逐灯亮度：

- **创建与身份**：创建房间即固定该版本完整快照，返回 6 位**房间码**与一次性显示的
  **控制密钥**。其他人凭房间码加入即为**观看者**（只读）；创建者持密钥，可播放、暂停、
  跳转与设置现有的 **0.5 / 1 / 2 倍速**。
- **服务端权威时码**：房间保存播放/暂停状态、**基准时码**（锚点时刻的演出秒数）、速度与
  **修订号**。服务端按 `基准时码 + 速度 ×（当前挂钟 − 锚点挂钟）` 推算当前时码；
  播放到版本末尾**自动停住**（冻结在末尾，修订号 +1）。
- **刷新 / 重启 / 重连可恢复**：状态全部持久化（含锚点挂钟），页面刷新、服务进程重启或
  观看者重连后都能恢复同一进度。观看端定期拉取服务端状态并据 `server_now/anchor_at`
  **本地校时**，帧间沿用既有线性渐变规则在本地重算逐灯亮度，画面平滑且无需任何真实灯具。
- **不受后续编辑影响**：房间固定创建时所选版本；之后修改草稿、发布新版本都不改变该房间
  （版本末尾时长、灯具与 Cue 快照均不变）。
- **乐观并发（修订号）**：控制请求必须携带当前修订号；成功一次（播放/暂停/跳转/改速）
  修订号 +1。修订号过期返回 **409 冲突且不改动房间**，客户端应以服务端状态校正后重试。
- **明确报错**：无效版本（400/404）、房间码非法或不存在（404）、密钥缺失/错误（403）、
  跳转时码为负或超出版本末尾（400）、速度不在 0.5/1/2 内（400）、修订号缺失或非整数（400/409）
  均返回中文错误。
- **只读副作用边界**：房间的创建与控制**不改动版本、草稿、调光记录**；既有接口语义保持不变。
  持密钥者可关闭房间（`DELETE`）。
- **页面地址栏**：`#room=<房间码>` 以观看者身份恢复；
  `#room=<房间码>&roomkey=<密钥>` 以创建者身份恢复（页面「复制密钥 / 邀请链接」即此地址）。

调用示例见下文「共享房间 HTTP API」。

## 一键启动（Docker Compose）

需要 Docker 与 Docker Compose 插件。在本目录执行：

```bash
docker compose up --build -d
```

该命令会一次性完成：安装依赖 → 初始化 SQLite 数据库与表结构 → 启动服务。

启动后访问：

- 地址：<http://localhost:3000>
- 端口：容器内固定 `3000`，宿主机默认映射到 `3000`（可用 `HOST_PORT` 修改）

停止：

```bash
docker compose down          # 停止（数据保留在命名卷 cue-data 中）
docker compose down -v       # 停止并删除演出数据
```

查看日志：`docker compose logs -f`

## 配置（环境变量）

在 docker-compose.yml 中配置，或通过 `.env` / 环境变量覆盖：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST_PORT` | `3000` | 宿主机映射端口（访问端口），如 `HOST_PORT=8080 docker compose up -d` |
| `PORT` | `3000` | 容器内监听端口（改动需同步调整 compose 的端口映射） |
| `DB_PATH` | `/data/app.db` | SQLite 数据库文件路径；位于挂载卷中，容器重建不丢数据 |
| `NODE_ENV` | `production` | 运行环境 |

## 不使用 Docker 的本地运行方式

需要 Node.js ≥ 20。

```bash
npm install
npm start                 # 默认监听 http://localhost:3000，数据文件在 ./data/app.db
PORT=8080 DB_PATH=/tmp/cue.db npm start   # 自定义端口与数据库位置
npm test                  # 运行灯光渐变引擎单元测试
```

## 使用说明

1. **灯具录入**：添加灯具（名称唯一），系统自动分配灯具编号 `#1、#2 …`。
   - 在同页「灯光回路」中建立回路（名称唯一、正数容量），并在灯具表内为每盏灯选择所属回路、
     填写正数额定瓦数；选「未分配」即不计入任何回路负载。容量/瓦数/回路引用非法会被拒绝。
2. **草稿 Cue**：
   - 单条录入：选择灯具、填写触发秒数、目标亮度（0～100）、渐变秒数；
     Cue 编号可留空自动分配，也可手填正整数。
   - 批量录入：每行 `时码 灯具编号 目标亮度 渐变时长 [Cue编号]`，空格分隔；
     任一行非法将拒绝整次提交。
   - 草稿可随时编辑/删除；这些改动只作用于草稿。
3. **发布版本**：填写备注（可留空）后点击“冻结并发布当前草稿”，生成不可变版本。
4. **排演播放**：选择版本后即可 ▶ 播放 / ⏸ 暂停 / ⏹ 回起点 / 拖动时间轴 / 输入秒数跳转，
   可切换 0.5× / 1× / 2× 速度；舞台模拟、亮度条与 Cue 状态（等待 / 渐变中 / 已触发）
   随时间实时更新。快捷键：页面空白处按空格播放/暂停。
5. **版本比对**：选择两个已发布版本（允许相同），输入非负时窗起点/终点、时窗内的查看时刻
   与 0～100 的亮度差阈值，页面显示该时刻两版逐灯亮度，并精确列出时窗内各灯亮度差
   **严格大于**阈值的连续区间及端点包含性（`[ ]` 含端点、`( )` 不含端点，零长度 `[t,t]`
   表示仅该瞬间超差）。按灯具编号匹配；仅在一版存在的灯具单列为**配置差异**，缺失不当作熄灭；
   无差异返回空区间；零长度时窗只返回该时刻亮度。区间在转折点（Cue 触发时刻、渐变结束时刻）
   之间用一次方程求阈值交点，**不做固定间隔采样**，同秒编号顺序、瞬变、中途接管、线性渐变
   规则与播放器完全一致。比对只读发布快照，不修改草稿，也不影响任何播放会话。
6. **临时调光记录**：在「调光记录」页选择已发布版本并建立记录，打开后选择灯具、填写演出时码、
   类型（覆盖/归还）、时长（覆盖再填目标亮度）追加操作；拖动时间轴或输入查看时刻即可重算
   逐灯的原版亮度与实际输出（覆盖中/归还融合中/跟随原版）。操作只追加（时码不早于末项，
   同秒按追加顺序）；若有人同时追加导致修订号过期，会自动拉取最新序列后提示重试。
7. **回路负载**：在「回路负载」页选择已发布版本或某条调光记录，输入非负时窗与窗内查看时刻，
   页面显示该时刻各回路容量/负载/余量与超载标记，并精确列出时窗内严格超出容量的连续区间
   （`[ ]`/`( )` 标明端点是否包含）。分析只读，草稿与回路配置的后续改动不影响已冻结版本。
8. **版本合并**：在「版本合并」页选择共同基线版本与另一组发布的待合入版本，点击三方比较预览：
   页面分区列出**可自动合入的单侧改动**与**冲突**；每条冲突用单选选择「保留草稿」或
   「采用待合入版本」（会导致重名或引用缺失的一侧有红色警示；联动冲突需与引用方同侧）。
   提交后以一次事务更新草稿；若预览后草稿被改过会提示重新预览。已发布版本与调光记录不变。
9. **共享房间**：在「共享房间」页选择已发布版本创建房间，妥善保存返回的**控制密钥**，
   把 **6 位房间码**发给其他排演人员。他们在同页输入房间码即可**加入观看**同一舞台与逐灯亮度；
   你（或任何填入密钥者）可用 ▶/⏸/⏹/跳转/0.5×·1×·2× 速度控制房间，所有人同步。
   到版本末尾自动停住；刷新页面、重启服务、掉线重连都能恢复进度；之后改草稿、发新版不影响本房间。
   浏览器地址可保存为 `#room=<房间码>`（观看）或 `#room=<房间码>&roomkey=<密钥>`（带控制）。

## 回路与接线 HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/circuits` | 回路列表（含容量、灯具数） |
| POST | `/api/circuits` | 新建回路 `{name, capacity}`，容量须为正数 |
| PATCH | `/api/circuits/:id` | 修改回路名称/正数容量 |
| DELETE | `/api/circuits/:id` | 删除回路（下仍挂灯具时返回 409） |
| PUT | `/api/lights/:id/wiring` | 设置灯具所属回路与正数额定瓦数 |

接线请求体：`{"circuit_id": 1, "watts": 200}`；取消分配：`{"circuit_id": null}`
（未分配时不得带瓦数）。容量非正、瓦数非正、回路不存在、灯具不存在均返回 `400/404`
中文错误，不保存。

调用示例：

```bash
# 建立一个容量 1500W 的回路
curl -X POST http://localhost:3000/api/circuits \
  -H 'Content-Type: application/json' \
  -d '{"name":"面光回路","capacity":1500}'

# 把灯具 #1 接到回路 #1，额定 300W
curl -X PUT http://localhost:3000/api/lights/1/wiring \
  -H 'Content-Type: application/json' \
  -d '{"circuit_id":1,"watts":300}'

# 取消分配（该灯不再计入任何回路负载）
curl -X PUT http://localhost:3000/api/lights/1/wiring \
  -H 'Content-Type: application/json' \
  -d '{"circuit_id":null}'
```

## 回路负载 HTTP API

`GET /api/load`（query 参数）或 `POST /api/load`（JSON body），参数相同。
分析目标二选一：

| 参数 | 含义 |
| --- | --- |
| `version_id` | 已发布版本编号（与 `record_id` 二选一；不存在返回 404） |
| `record_id` | 绑定某版本的临时调光记录编号（按覆盖/归还后的实际输出计算） |
| `start` / `end` | 非负时窗起止秒数，`start > end` 报错；相等为零长度时窗 |
| `at` | 查看时刻（非负秒数），必须落在 `[start,end]` 内 |

负载 = 该时刻各成员灯 `实际亮度/100×额定瓦数` 之和；`intervals` 为负载**严格大于**容量的
全部连续区间。转折点之间按一次/二次方程精确求根（归还融合产生二次形），不做固定步长采样。

调用示例：

```bash
# 分析版本 1 在时窗 [0,60] 内、查看时刻 t=12s 的回路负载
curl 'http://localhost:3000/api/load?version_id=1&start=0&end=60&at=12'

curl -X POST http://localhost:3000/api/load \
  -H 'Content-Type: application/json' \
  -d '{"version_id":1,"start":0,"end":60,"at":12}'

# 分析绑定该版本的调光记录 2（含临时覆盖/归还的实际输出）
curl -X POST http://localhost:3000/api/load \
  -H 'Content-Type: application/json' \
  -d '{"record_id":2,"start":0,"end":60,"at":12}'
```

返回（节选）：

```json
{
  "source": {"kind": "version", "version": {"id": 1, "label": "首演"}},
  "window": {"start": 0, "end": 60},
  "at": 12,
  "has_circuit_config": true,
  "circuits": [
    {
      "circuit_id": 1,
      "name": "面光回路",
      "capacity": 1500,
      "lights": [
        {"light_id": 1, "name": "面光1", "watts": 300}
      ],
      "load_at": 960,
      "overloaded": false,
      "intervals": [
        {"start": 30, "end": 45, "start_inclusive": false, "end_inclusive": true}
      ]
    }
  ]
}
```

- `has_circuit_config` 为 `false` 表示该版本发布时没有回路配置（早期版本）：`circuits` 为空，
  播放照常、不产生回路负载。
- `intervals` 只含超载区间；与容量恰好相等的时刻不算超载（交点端点开区间）；
  Cue/操作触发瞬间若超载则该端点为闭端点；零长度时窗 `intervals` 恒为 `[]`。
- 未分配回路的灯具不出现在任何回路的 `lights` 中，不计入负载。
- 版本/记录不存在 → 404；时窗非法、查看时刻越界、目标缺失或同时给出版本与记录 → 400。
  分析只读，不改变草稿、版本、记录或播放。

## 版本比对 HTTP API

`GET /api/compare`（query 参数，便于直接调用/分享）或 `POST /api/compare`（JSON body），
参数相同：

| 参数 | 含义 |
| --- | --- |
| `version_a` / `version_b` | 两个已发布版本编号（正整数；允许相同；任一不存在返回 404） |
| `start` / `end` | 非负时窗起止秒数，`start > end` 报错；二者相等为零长度时窗 |
| `at` | 查看时刻（非负秒数），必须落在 `[start, end]` 内 |
| `threshold` | 亮度差阈值，0～100（含边界）；严格大于才算超差 |

调用示例：

```bash
curl 'http://localhost:3000/api/compare?version_a=1&version_b=2&start=0&end=10&at=4&threshold=30'

curl -X POST http://localhost:3000/api/compare \
  -H 'Content-Type: application/json' \
  -d '{"version_a":1,"version_b":2,"start":0,"end":10,"at":4,"threshold":30}'
```

返回（节选）：

```json
{
  "versions": {"a": {"id": 1, "label": "首演"}, "b": {"id": 2, "label": "复排"}},
  "window": {"start": 0, "end": 10},
  "at": 4,
  "threshold": 30,
  "levels": [
    {"light_id": 1, "name": "面光1", "brightness_a": 40, "brightness_b": 20,
     "difference": 20, "exceeds": false}
  ],
  "intervals": [
    {"light_id": 2, "name": "侧光L", "intervals": [
      {"start": 5, "end": 7.5, "start_inclusive": true, "end_inclusive": false}
    ]}
  ],
  "config_differences": {
    "only_in_a": [{"light_id": 3, "name": "逆光"}],
    "only_in_b": []
  }
}
```

- `intervals` 只含有差异的灯具；无差异时为 `[]`。`start_inclusive/end_inclusive`
  标明区间端点是否包含（阈值交点不含；Cue 触发瞬间若超差则含）。
- 起点大于终点、查看时刻越界、非数字/负数参数、阈值越界（<0 或 >100）、
  版本不存在等情况均返回 `400/404` 与中文错误原因。

## 临时调光记录 HTTP API

记录（record）绑定一个已发布版本；操作（op）只能追加。修订号用于乐观并发控制。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/records` | 建立记录 `{version_id, label?}`，返回记录详情（含绑定快照与空操作序列） |
| GET | `/api/records` | 记录列表（含修订号、操作数、绑定版本） |
| GET | `/api/records/:id` | 记录详情：元数据 + 绑定版本的灯具/Cue 快照 + 操作序列（刷新/跳转后据此重算） |
| DELETE | `/api/records/:id` | 删除记录及其全部操作 |
| POST | `/api/records/:id/ops` | 追加操作：单条 `{revision, op}` 或批量 `{revision, ops:[...]}`，整批事务 |
| GET | `/api/records/:id/output?at=<时码>` | 查看某时刻逐灯原版亮度与实际输出（只读重算） |

操作对象字段：

| 字段 | 含义 |
| --- | --- |
| `light_id` | 灯具编号，必须存在于**绑定版本快照**中 |
| `time` | 非负演出时码（秒，可小数），不得早于当前末项操作的时码 |
| `op_type` | `override`（覆盖）或 `return`（归还） |
| `duration` | 非负时长（秒）；`0` 立即生效 |
| `target` | 仅覆盖需要：0～100 目标亮度；归还携带该字段会报错 |

调用示例：

```bash
# 1) 基于版本 1 建立记录
curl -X POST http://localhost:3000/api/records \
  -H 'Content-Type: application/json' \
  -d '{"version_id":1,"label":"技术联排夜场"}'

# 2) 在修订号 0 上追加一条覆盖：t=2s 把 #1 从当时实际输出渐变到 80，用时 6s
curl -X POST http://localhost:3000/api/records/1/ops \
  -H 'Content-Type: application/json' \
  -d '{"revision":0,"op":{"light_id":1,"time":2,"op_type":"override","target":80,"duration":6}}'

# 3) 同秒追加两条操作（按数组顺序生效）：#2 先瞬变到 10，再用 2s 归还到原版
curl -X POST http://localhost:3000/api/records/1/ops \
  -H 'Content-Type: application/json' \
  -d '{"revision":1,"ops":[
        {"light_id":2,"time":8,"op_type":"override","target":10,"duration":0},
        {"light_id":2,"time":8,"op_type":"return","duration":2}
      ]}'

# 4) 查看 t=9s 的逐灯实际输出（原版仍在后台运行）
curl 'http://localhost:3000/api/records/1/output?at=9'
```

追加成功返回最新记录详情（`revision` 已自增、`ops` 为完整序列）。冲突示例：

```json
{ "revision": 0, "op": {"light_id":1,"time":9,"op_type":"override","target":0,"duration":1} }
```

```json
{"error":"修订号冲突：提交基于修订号 0，记录当前已为修订号 2；请刷新操作序列后重试（本次未写入）"}
```

`GET /api/records/:id/output?at=9` 返回（节选）：

```json
{
  "record": {"id": 1, "label": "技术联排夜场", "revision": 2},
  "version": {"id": 1, "label": "首演"},
  "at": 9,
  "levels": [
    {"light_id": 1, "name": "面光1", "original": 90, "actual": 80, "overridden": true,
     "state": "override", "active_seq": 1},
    {"light_id": 2, "name": "侧光L", "original": 60, "actual": 60, "overridden": false,
     "state": "original", "active_seq": null}
  ]
}
```

- `state`：`override`（覆盖保持/渐变中）、`return`（归还融合中）、`original`（完全跟随原版）。
- 版本不存在 → 404；记录不存在 → 404；版本号/灯具/时码/时长/亮度/类型非法、
  时码早于末项、归还携带目标亮度、缺少修订号 → 400；修订号过期 → 409。
  批量追加时任一条非法则整批拒绝（**不部分写入**）。

## 草稿合并 HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/merge/preview` | 三方比较预览（**只读，不写库**），返回一次性预览令牌 |
| POST | `/api/merge/commit` | 凭令牌与逐项抉择提交，一次事务更新草稿 |

### 1) 预览

请求体：

| 字段 | 含义 |
| --- | --- |
| `base_version_id` | 共同基线版本编号（正整数，不存在返回 404） |
| `incoming_version_id` | 待合入版本编号（正整数，不存在返回 404；可与基线相同） |

```bash
curl -X POST http://localhost:3000/api/merge/preview \
  -H 'Content-Type: application/json' \
  -d '{"base_version_id":1,"incoming_version_id":2}'
```

返回（节选）：

```json
{
  "token": "1f2c…（24 字节十六进制预览令牌，提交时原样带回）",
  "base": {"id": 1, "label": "共同基线"},
  "incoming": {"id": 2, "label": "B组改稿"},
  "draft_stamp": "草稿内容版本戳（提交时服务器自行比对）",
  "summary": {"auto_total": 2, "auto_add": 0, "auto_update": 1, "auto_delete": 1, "conflicts_total": 1},
  "auto": [
    {
      "kind": "circuit", "key": "circuit:1", "id": 1, "title": "回路 #1",
      "action": "update", "action_text": "采用待合入版本的修改",
      "base": {"id": 1, "name": "面光回路", "capacity": 1500},
      "current": {"id": 1, "name": "面光回路", "capacity": 1500},
      "incoming": {"id": 1, "name": "面光回路", "capacity": 2000},
      "applied": {"id": 1, "name": "面光回路", "capacity": 2000}
    },
    {
      "kind": "cue", "key": "cue:1", "id": 1, "title": "Cue #1",
      "action": "delete", "action_text": "按待合入版本删除（草稿侧未改）",
      "base": {"cue_no": 1, "light_id": 1, "light_name": "面光1", "time": 0, "target": 50, "duration": 0},
      "current": { /* 草稿侧当前值 */ },
      "incoming": null,
      "applied": null
    }
  ],
  "conflicts": [
    {
      "kind": "cue", "key": "cue:2", "id": 2, "title": "Cue #2",
      "reason": "both_modified",
      "reason_text": "两侧相对共同基线做了不同修改",
      "reasons": [{"code": "both_modified", "side": null, "text": "两侧相对共同基线做了不同修改"}],
      "base": { /* … */ },
      "draft": {"cue_no": 2, "light_id": 2, "light_name": "侧光L", "time": 2, "target": 80, "duration": 3},
      "incoming": {"cue_no": 2, "light_id": 2, "light_name": "侧光R", "time": 2, "target": 90, "duration": 1}
    }
  ],
  "draft": { "lights": [], "circuits": [], "cues": [], "wiring": [] }
}
```

条目类型 `kind`：`light`（灯具，按编号匹配名称）、`circuit`（回路，按编号匹配名称/容量）、
`cue`（Cue，按 Cue 编号匹配灯具/时码/目标/渐变）、`wiring`（接线，按灯具编号匹配
所属回路 `circuit_id`（`null`=未分配）与额定瓦数 `watts`）。
冲突原因 `reason`：

| code | 含义 |
| --- | --- |
| `both_modified` | 两侧不同修改 |
| `delete_vs_modify` | 删除与修改并存 |
| `same_key_diff` | 同编号新增异值 |
| `name_collision` | 该侧取值会造成灯具/回路名称重名（`reasons[].side` 标明是哪一侧） |
| `reference_missing` | 该侧取值下 Cue 引用的灯具、或接线引用的回路缺失 |
| `reference_dependency` | 联动冲突：Cue/接线需要本灯具/回路，须与引用方同侧 |
| `attached_to_conflict` | 随冲突主体新增的接线等，提交时自动跟随主体同侧 |

### 2) 提交

请求体：

| 字段 | 含义 |
| --- | --- |
| `token` | 预览返回的一次性令牌 |
| `resolutions` | 冲突抉择对象：`"冲突 key" → "draft"（保留草稿）/ "incoming"（采用待合入版本）`；自动改动无需列出 |

```bash
# cue:2 两侧改成了不同内容 → 保留草稿侧；自动项（回路容量→2000、删除 cue1）直接生效
curl -X POST http://localhost:3000/api/merge/commit \
  -H 'Content-Type: application/json' \
  -d '{"token":"1f2c…","resolutions":{"cue:2":"draft"}}'
```

成功返回 `200` 与合并后的新草稿：

```json
{
  "merged": true,
  "base": {"id": 1, "label": "共同基线"},
  "incoming": {"id": 2, "label": "B组改稿"},
  "summary": {"auto_total": 2, "auto_update": 1, "auto_delete": 1, "conflicts_total": 1},
  "draft": {
    "lights": [ {"id": 1, "name": "面光A", "circuit_id": 1, "watts": 300} ],
    "circuits": [ {"id": 1, "name": "面光回路", "capacity": 2000} ],
    "cues": [ {"id": 12, "cue_no": 2, "light_id": 2, "light_name": "侧光L", "time": 2, "target": 80, "duration": 3} ]
  }
}
```

错误情形（均不写入）：

- `400`：缺少/非法版本编号、`resolutions` 不是对象、引用了预览中不存在的 key、抉择值不是
  `draft`/`incoming`、仍有冲突未选择（返回 `unresolved`）、最终结果违反唯一性或引用规则
  （返回 `violations` 及其中文说明）。
- `404`：预览令牌不存在或已用过（一次性）/已过期（24 小时）。
- `409`：**草稿在预览后被编辑**——令牌作废，返回
  `草稿在预览之后已被编辑，本次合并结果已过期：请重新预览并逐项抉择后再提交（本次未写入）`，
  前端应重新发起预览。

已发布版本（含基线与待合入版本）以及绑定它们的调光记录在合并全程**不变**。

## 共享房间 HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/rooms` | 基于已发布版本创建房间 `{version_id}`，返回房间码、**控制密钥**（仅此一次）与初始状态 |
| GET | `/api/rooms` | 房间列表（含固定版本、播放态、当前时码、速度、修订号；**不含密钥**） |
| GET | `/api/rooms/:code` | 凭房间码获取房间权威状态 + 固定版本快照（观看端据此本地重算并校时）；可带 `?key=` 校验控制身份 |
| POST | `/api/rooms/:code/control` | 持密钥控制：`play` / `pause` / `seek` / `speed`（须带 `revision`） |
| DELETE | `/api/rooms/:code` | 持密钥关闭房间（密钥放 JSON body `{key}` 或 query `?key=`） |

### 房间状态字段（GET / 创建 / 控制响应）

| 字段 | 含义 |
| --- | --- | --- |
| `code` | 6 位房间码（大写字母+数字，去除 0/O、1/I 等易混字符），加入观看用 |
| `control_key` | 控制密钥（48 位十六进制），**仅创建响应返回**；控制动作须原样带回 |
| `version` / `snapshot` | 固定的已发布版本编号/备注，与该版本完整快照（灯具、Cue、回路、接线） |
| `duration` | 版本末尾时刻（房间播放总时长，秒；无 Cue 时为 0） |
| `playing` / `paused` / `at_end` | 播放中 / 暂停 / 已到末尾自动停住 |
| `time` | 服务端此刻推算出的当前时码（秒） |
| `base_time` / `anchor_at` | 基准时码与对应服务端挂钟秒；观看端据此校时 |
| `speed` | 当前速度（0.5 / 1 / 2） |
| `server_now` | 响应构造时的服务端挂钟秒（客户端对齐本地时钟用） |
| `revision` | 房间修订号：每次成功控制（含自动停住）+1，控制请求做乐观并发 |
| `controllable` | GET 带 `?key=` 且密钥正确时为 `true`；不带为 `false`；密钥错误返回 403 |

控制动作请求体（除动作参数外，均须携带 `key` 与 `revision`）：

| `action` | 参数 | 语义 |
| --- | --- | --- |
| `play` | — | 播放；已在末尾停住时按播放即**从头开始** |
| `pause` | — | 暂停并冻结当前时码 |
| `seek` | `time`（非负数字，≤ 版本末尾） | 跳转后暂停在该时刻（`time = duration` 即停在末尾） |
| `speed` | `speed`（仅 `0.5` / `1` / `2`） | 设置速度；播放中改速由服务端重锚，画面不跳变 |

调用示例：

```bash
# 1) 基于版本 1 创建共享房间（请记下 control_key，它只显示这一次）
curl -X POST http://localhost:3000/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"version_id":1}'
# => {"code":"K7QP2M","control_key":"a3f9…（48 位）","duration":10,"playing":false,
#     "time":0,"speed":1,"revision":0,"at_end":false,"server_now":…,"anchor_at":…}

# 2) 观看者凭房间码加入（任何人可调；返回快照与权威时码，不含密钥）
curl http://localhost:3000/api/rooms/K7QP2M

# 创建者核对身份（携带密钥，返回 controllable:true）
curl 'http://localhost:3000/api/rooms/K7QP2M?key=a3f9…'

# 3) 持密钥播放（修订号从 0 开始；成功后 revision 变为 1）
curl -X POST http://localhost:3000/api/rooms/K7QP2M/control \
  -H 'Content-Type: application/json' \
  -d '{"key":"a3f9…","revision":0,"action":"play"}'

# 稍后暂停：服务端按挂钟推进，time 即暂停瞬间的时码（约 3.2s），revision 变为 2
sleep 3.2
curl -X POST http://localhost:3000/api/rooms/K7QP2M/control \
  -H 'Content-Type: application/json' \
  -d '{"key":"a3f9…","revision":1,"action":"pause"}'

# 4) 跳转到 5 秒（非法：负数或超过版本末尾 10s 都会 400）
curl -X POST http://localhost:3000/api/rooms/K7QP2M/control \
  -H 'Content-Type: application/json' \
  -d '{"key":"a3f9…","revision":2,"action":"seek","time":5}'

# 5) 改为 2 倍速（只接受 0.5 / 1 / 2）
curl -X POST http://localhost:3000/api/rooms/K7QP2M/control \
  -H 'Content-Type: application/json' \
  -d '{"key":"a3f9…","revision":3,"action":"speed","speed":2}'

# 6) 修订号过期（他人已控制过）→ 409 且房间不变；刷新状态后用新 revision 重试
# {"error":"修订号冲突：提交基于修订号 3，房间当前已为修订号 4；请按服务器状态刷新后重试（本次未改动房间）"}

# 7) 持密钥关闭房间
curl -X DELETE http://localhost:3000/api/rooms/K7QP2M \
  -H 'Content-Type: application/json' -d '{"key":"a3f9…"}'
```

观看端校时（本地逐帧平滑渲染）：以某次 GET 的 `server_now` 为服务端基准、记录本地收到时刻；
播放中当前时码为 `base_time + speed × ((服务端现在) − anchor_at)`，其中
`服务端现在 = server_now +（本地现在 − 本地收到时刻）`；到 `duration` 即停住。
页面每 1 秒再 GET 一次权威状态，发现修订号/播放态/速度变化或到末尾时立即重锚。

错误情形：版本不存在 → 404；版本编号非法 → 400；房间码非法或房间不存在 → 404；
密钥缺失/错误（控制与 `?key=` 校验、删除）→ 403；动作非法、`time` 为负或超出末尾、
速度不在 0.5/1/2 → 400；缺少修订号或非非负整数 → 400；修订号过期 → 409（房间不变）。
所有房间接口均不改动版本、草稿与调光记录。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/lights` | 灯具列表（含所属回路 circuit_id 与额定瓦数 watts） |
| POST | `/api/lights` | 新增灯具 `{name}` |
| DELETE | `/api/lights/:id` | 删除灯具（仍被草稿 Cue 引用时返回 409） |
| GET | `/api/circuits` | 回路列表（含容量、灯具数） |
| POST | `/api/circuits` | 新建回路 `{name, capacity}`（容量正数） |
| PATCH | `/api/circuits/:id` | 修改回路名称/容量 |
| DELETE | `/api/circuits/:id` | 删除回路（仍挂灯具时返回 409） |
| PUT | `/api/lights/:id/wiring` | 设置灯具所属回路与额定瓦数（null 取消分配） |
| GET | `/api/cues` | 草稿 Cue 列表（按时码、编号排序） |
| POST | `/api/cues` | 新增 Cue，接受单条对象或数组（数组为批量，整批事务） |
| PATCH | `/api/cues/:id` | 修改草稿 Cue |
| DELETE | `/api/cues/:id` | 删除草稿 Cue |
| POST | `/api/versions` | 冻结当前草稿（含回路与接线），发布不可变版本 |
| GET | `/api/versions` | 版本列表 |
| GET | `/api/versions/:id` | 版本完整快照（灯具 + Cue + 回路 + 接线，供播放器使用） |
| GET/POST | `/api/compare` | 两版亮度差异比对（查看时刻逐灯亮度 + 超差连续区间 + 配置差异），只读 |
| GET/POST | `/api/load` | 版本或调光记录的回路负载（查看时刻负载 + 严格超载连续区间），只读 |
| POST | `/api/records` | 针对已发布版本建立临时调光记录 |
| GET | `/api/records` | 调光记录列表 |
| GET | `/api/records/:id` | 记录详情（绑定版本快照 + 操作序列） |
| DELETE | `/api/records/:id` | 删除记录及其操作 |
| POST | `/api/records/:id/ops` | 追加覆盖/归还操作（携带修订号，单条或批量，整批事务） |
| GET | `/api/records/:id/output` | 查询某时刻逐灯原版亮度与实际输出，只读重算 |
| POST | `/api/merge/preview` | 草稿三方合并预览（共同基线 + 待合入版本），只读，返回令牌/自动改动/冲突两侧值 |
| POST | `/api/merge/commit` | 凭预览令牌与逐项抉择提交，一次事务更新灯具/回路/接线/Cue |
| POST | `/api/rooms` | 基于已发布版本创建共享房间，返回房间码与一次性控制密钥 |
| GET | `/api/rooms` | 共享房间列表（不含密钥） |
| GET | `/api/rooms/:code` | 凭房间码获取房间权威状态与固定版本快照（可 `?key=` 校验控制身份） |
| POST | `/api/rooms/:code/control` | 持密钥播放/暂停/跳转/改速（携带修订号，过期 409 不改房间） |
| DELETE | `/api/rooms/:code` | 持密钥关闭房间 |

所有错误返回 `400/404/409` 与形如 `{"error": "具体中文原因"}` 的 JSON。

## 目录结构

```
server.js            Express 服务与 API、输入校验、版本快照事务、两版比对、临时调光记录（修订号/追加事务）、回路配置与负载分析、草稿三方合并（预览令牌/一次事务提交）、共享房间（房间码/控制密钥/挂钟推算时码/末尾自动停住/修订号乐观并发）
src/db.js            SQLite 初始化与表结构（含调光记录、操作序列、回路与版本回路快照表、合并预览令牌表、共享房间表，含旧库迁移）
src/merge.js         草稿三方合并纯函数（按灯具/回路/Cue/接线分类自动项与冲突、重名与引用校验、抉择落地）
public/engine.js     纯函数灯光渐变引擎（浏览器/Node 共用，含线性渐变、中途接管、精确差值区间、覆盖/归还重算、回路负载二次精确求根）
public/index.html    单页界面（含版本合并页、共享房间页）
public/styles.css    剧场暗色主题
public/app.js        前端交互、版本比对页、播放器、调光记录页、回路负载页、版本合并页与共享房间页（基于 requestAnimationFrame 的播放、快照本地重算、房间服务端状态校时轮询）
test/engine.test.js  渐变规则单元测试
test/compare.test.js 两版亮度差区间单元测试（交点精度、端点包含性、瞬变、接管）
test/override.test.js 覆盖/归还单元测试（渐变起点、同秒顺序、中途接管、0 秒立即生效、归还融合）
test/circuit-load.test.js 回路负载单元测试（线性/二次超载求根、端点包含性、瞬变、多灯加权、未分配、零长度）
test/merge.test.js   草稿三方合并单元测试（单侧自动合入、两侧异改/删除修改并存/同编号异值、重名、Cue/接线引用缺失、联动冲突、整次拒绝）
test/rooms.test.js   共享房间端到端测试（真实 HTTP：创建/加入/密钥、播放暂停跳转改速、挂钟推进、末尾自动停住、修订号 409、服务重启恢复、草稿与新版不影响房间、关闭鉴权）
Dockerfile           镜像构建（依赖、初始化、启动）
docker-compose.yml   一键编排
```
