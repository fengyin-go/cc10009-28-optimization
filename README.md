# 网页采集配置管理工具

离线版采集配置管理工具，涵盖站点管理、抽取模板编排、代理池配置、限速策略、重试机制、增量采集与数据落盘规则，所有配置持久化到浏览器本地存储。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 站点管理 | `site` | 采集站点 | 站点编号、域名地址、站点类型 |
| 抽取模板 | `template` | 网页模板 | 模板编号、入口地址、列表选择器 |
| 代理池管理 | `proxy` | 代理节点 | 节点编号、代理地址、代理协议 |
| 采集任务 | `spider` | 采集作业 | 作业编号、目标站点、抽取模板 |
| 调度策略 | `schedule` | 调度规则 | 规则编号、关联站点、调度表达式 |
| 反爬对抗 | `antibot` | 对抗策略 | 策略编号、验证码类型、识别服务 |
| 限速控制 | `ratelimit` | 限速配置 | 配置编号、目标站点、每秒请求上限 |
| 失败重试 | `retry` | 重试策略 | 策略编号、关联任务、最大重试次数 |
| 字段映射 | `extractor` | 映射规则 | 规则编号、源字段名称、目标字段名称 |
| 采集流水线 | `pipeline` | 流水线步骤 | 步骤编号、步骤名称、输入数据源 |
| 结果校验 | `validator` | 校验规则 | 规则编号、校验对象、校验类型 |
| 数据落盘 | `storage` | 存储配置 | 配置编号、存储类型、输出路径 |
| 采集监控 | `monitor` | 监控指标 | 指标编号、关联任务、指标名称 |
| 数据清洗 | `cleanse` | 清洗规则 | 规则编号、目标字段、空值替换 |
| 增量采集 | `delta` | 增量游标 | 游标编号、目标站点、增量字段 |
| 数据分发 | `export` | 分发通道 | 通道编号、输出数据集、目标系统 |
| RPA流程 | `rpaflow` | 自动化流程 | 流程编号、目标页面、操作序列 |
| 登录凭证 | `auth` | 凭证配置 | 凭证编号、目标站点、认证方式 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `scraper-config-studio:entries` 这一项，或调用 `resetModule(模块)`。

## 节点编排（依赖图与并行波次）

采集流水线按「编排图」分组，依赖解析与波次判断收拢为一套统一实现，流水线页面与
RPA 批次清单共用，任何模块都不再自行解析依赖：

```text
frontend/src/orchestrator/
├── types.ts             编排图、波次记录、步骤运行结果等公共类型
├── dependency-graph.ts  统一边界：依赖解析、循环/冲突仲裁、波次判断（纯函数）
├── engine.ts            波次执行引擎：并行推进、失败区间重做、重入只写一次
└── run-store.ts         运行态持久化（按 graphId 分别记录，独立于业务清单）
```

- 依赖边有两个来源：「依赖步骤」的显式依赖，以及输出目标 == 下游输入数据源的数据依赖；
  无依赖节点落在第 0 波并行，下游波次等待前序波次全部成功（输出目录完整）后才启动。
- 仲裁优先级：循环依赖 / 未知依赖 / 不可达节点硬阻塞；输出目标冲突不阻塞，同波只允许一个
  写者、其余顺延串行；普通依赖按 Kahn 分层分波。
- 执行波次（`waves`）与未完成步骤（`unfinishedNodeIds`）分两组结构记录；失败后仅重做失败
  波内的 failed 节点，已成功节点不重写，并发重入同波次时每节点 `writeCount` 至多为 1。
- RPA 流程页按「执行批次」（`BATCH-<编排图>`）同步阻塞节点与分波次步骤运行结果，并回写
  到批次清单的「阻塞节点 / 步骤运行结果」两列。
- 统一实现带单元测试（含 ABCD 四步图与 N1/N2 分叉汇聚图两个指定场景）：

```bash
cd frontend
npm test          # vitest run，23 个用例
npm run typecheck
npm run build
```


领域：数据工程
子方向：数据采集、爬虫与RPA
