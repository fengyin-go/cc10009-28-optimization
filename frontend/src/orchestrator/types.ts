/**
 * 节点编排统一核心的公共类型。
 * 流水线（pipeline）与 RPA 批次同步（rpaflow）都只依赖这里的结构，不各自定义图模型。
 */

/** 编排图输入节点：由业务行（EntryRow）解析得到，解析逻辑集中在 dependency-graph.ts。 */
export type GraphNodeInput = {
  /** 节点稳定标识，业务侧一般用行 id 字符串。 */
  id: string
  /** 步骤编号，依赖步骤字段通过它引用节点，例如 PIPE-0001。 */
  code: string
  /** 步骤名称。 */
  name: string
  /** 输入数据源，可多个；与其他节点输出目标一致时自动形成数据依赖边。 */
  inputSources: string[]
  /** 输出目标（输出目录/数据集），节点成功即表示该目录已完整写入。 */
  outputTarget: string
  /** 显式依赖的步骤编号列表，来自「依赖步骤」字段。 */
  dependencyCodes: string[]
}

export type IssueLevel = 'error' | 'warning'

export type GraphIssueType =
  | 'cycle'
  | 'unknown-dependency'
  | 'output-conflict'
  | 'unreachable'

/** 编排校验问题：error 级会阻塞节点调度，warning 级只做告警与串行化处理。 */
export type GraphIssue = {
  level: IssueLevel
  type: GraphIssueType
  message: string
  nodeIds: string[]
}

/** 依赖边：explicit 来自「依赖步骤」，data 来自输入数据源/输出目标匹配。 */
export type DependencyEdge = {
  from: string
  to: string
  kind: 'explicit' | 'data'
}

/** 阻塞节点记录：rpaflow 批次清单同步的就是这份阻塞信息。 */
export type BlockedNode = {
  nodeId: string
  reason: string
}

/**
 * 依赖图 + 波次规划结果（纯数据，可序列化持久化）。
 * waves 是分层后的并行波次：同一波次内无依赖关系、可同时运行；
 * 下游波次必须等待前序波次节点的输出目录完整写入后才启动。
 */
export type DependencyGraph = {
  graphId: string
  nodes: GraphNodeInput[]
  nodeIds: string[]
  edges: DependencyEdge[]
  outgoing: Record<string, string[]>
  incoming: Record<string, string[]>
  issues: GraphIssue[]
  blocked: BlockedNode[]
  /** waves[i] 为第 i 波可并行节点 id，波次从 0 开始。 */
  waves: string[][]
}

export type StepState = 'idle' | 'running' | 'succeeded' | 'failed' | 'blocked'

/** 单步骤运行结果：writeCount 记录实际写入次数，用于校验重入只写一次。 */
export type StepRecord = {
  nodeId: string
  wave: number
  state: StepState
  attempts: number
  writeCount: number
  error: string | null
  updatedAt: string | null
}

export type WaveStatus = 'pending' | 'running' | 'succeeded' | 'failed'

/** 执行波次记录，与未完成步骤分开存储。 */
export type WaveRecord = {
  wave: number
  nodeIds: string[]
  status: WaveStatus
  startedAt: string | null
  finishedAt: string | null
  failureNodeIds: string[]
}

/** 一张依赖图的一次批次运行态，按 graphId 分别持久化。 */
export type RunState = {
  graphId: string
  batchId: string
  createdAt: string
  updatedAt: string
  nodeStates: Record<string, StepRecord>
  waves: WaveRecord[]
  /** 未完成步骤（idle/running/failed，不含 blocked），与波次记录分别维护。 */
  unfinishedNodeIds: string[]
  blockedNodeIds: string[]
  /** 故障注入标记：被标记节点执行器会返回失败，用于演示失败区间重做。 */
  faultNodeIds: string[]
}

export type ExecutorResult = {
  ok: boolean
  message?: string
}

/** 节点执行器：引擎不关心真实执行方式，只约定成功代表输出目录完整、失败进入失败区间。 */
export type NodeExecutor = (node: GraphNodeInput) => Promise<ExecutorResult>
