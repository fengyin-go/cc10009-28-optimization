/**
 * 波次执行引擎：在统一依赖图之上管理一次批次运行态。
 *
 * 约束（与需求一一对应）：
 * - 无依赖步骤同波并行，下游波次必须等待前序波次全部成功（输出目录完整）后才启动；
 * - 失败后只重做失败区间：仅 failed 节点可重跑，已成功节点的结果保留、绝不重写；
 * - 并发重入同一波次只写一次：节点进入 running 即登记，重复启动直接跳过，
 *   writeCount 记录真实写入次数，幂等性可被测试断言；
 * - 执行波次与未完成步骤分别记录在 waves / unfinishedNodeIds 两组结构里。
 */
import { waveOf } from './dependency-graph'
import type {
  DependencyGraph,
  NodeExecutor,
  RunState,
  StepRecord,
  StepState,
  WaveRecord,
} from './types'

function now(): string {
  return new Date().toISOString()
}

function buildWaves(graph: DependencyGraph): WaveRecord[] {
  return graph.waves.map((nodeIds, index) => ({
    wave: index,
    nodeIds: [...nodeIds],
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    failureNodeIds: [],
  }))
}

function buildNodeStates(graph: DependencyGraph): Record<string, StepRecord> {
  const states: Record<string, StepRecord> = {}
  for (const node of graph.nodes) {
    const wave = waveOf(graph, node.id)
    states[node.id] = {
      nodeId: node.id,
      wave,
      state: wave < 0 ? 'blocked' : 'idle',
      attempts: 0,
      writeCount: 0,
      error: null,
      updatedAt: null,
    }
  }
  return states
}

/** 创建一张图的批次运行态；图内被阻塞节点直接落 blocked，不参与调度。 */
export function createRunState(graph: DependencyGraph, batchId?: string): RunState {
  const createdAt = now()
  const state: RunState = {
    graphId: graph.graphId,
    batchId: batchId ?? `BATCH-${graph.graphId}`,
    createdAt,
    updatedAt: createdAt,
    nodeStates: buildNodeStates(graph),
    waves: buildWaves(graph),
    unfinishedNodeIds: graph.nodeIds.filter((id) => waveOf(graph, id) >= 0),
    blockedNodeIds: graph.blocked.map((item) => item.nodeId),
    faultNodeIds: [],
  }
  return state
}

/** 从持久化数据恢复运行态（结构补齐，兼容老数据）。 */
export function hydrateRunState(raw: RunState, graph: DependencyGraph): RunState {
  const fresh = createRunState(graph, raw.batchId)
  const nodeStates = { ...fresh.nodeStates }
  for (const [id, record] of Object.entries(raw.nodeStates ?? {})) {
    if (nodeStates[id]) {
      nodeStates[id] = { ...nodeStates[id], ...record }
    }
  }
  return {
    ...fresh,
    ...raw,
    nodeStates,
    waves: raw.waves?.length ? raw.waves : fresh.waves,
    unfinishedNodeIds: raw.unfinishedNodeIds ?? fresh.unfinishedNodeIds,
    blockedNodeIds: raw.blockedNodeIds ?? fresh.blockedNodeIds,
    faultNodeIds: raw.faultNodeIds ?? [],
  }
}

export function markFault(state: RunState, nodeId: string, active: boolean): RunState {
  const next: RunState = {
    ...state,
    faultNodeIds: active
      ? unique([...state.faultNodeIds, nodeId])
      : state.faultNodeIds.filter((id) => id !== nodeId),
    updatedAt: now(),
  }
  return next
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** 当前可启动波次：按顺序找到第一个未成功的波次；更前的波次若失败则形成失败区间。 */
export function currentWaveIndex(state: RunState): number {
  const index = state.waves.findIndex((wave) => wave.status !== 'succeeded')
  return index < 0 ? state.waves.length : index
}

function patchNode(state: RunState, nodeId: string, patch: Partial<StepRecord>): void {
  const prev = state.nodeStates[nodeId]
  state.nodeStates[nodeId] = {
    ...prev,
    ...patch,
    updatedAt: now(),
  }
}

function refreshUnfinished(state: RunState): void {
  state.unfinishedNodeIds = Object.values(state.nodeStates)
    .filter((record) => record.state === 'idle' || record.state === 'running' || record.state === 'failed')
    .map((record) => record.nodeId)
}

function defaultExecutor(node: { code: string; name: string }): Promise<{ ok: boolean; message?: string }> {
  return Promise.resolve({ ok: true, message: `${node.name}（${node.code}）执行成功，输出目录已完整写入` })
}

/**
 * 启动指定波次（默认当前波次）。
 *
 * 幂等/重入语义：
 * - 已成功的波次直接返回，不会重跑；
 * - 波次内 running/succeeded 节点跳过，仅 idle/failed 节点会真正执行，
 *   因此并发重入同波次时每个节点只写一次（writeCount 至多为 1）；
 * - 任一节点失败则该波标记 failed，后续波次保持 pending 等待，
 *   下次调用仅重跑该波内 failed 节点 —— 即“失败后只重做失败区间”。
 */
export async function runWave(
  graph: DependencyGraph,
  state: RunState,
  executor: NodeExecutor = defaultExecutor,
  waveIndex?: number,
): Promise<RunState> {
  const target = waveIndex ?? currentWaveIndex(state)
  const wave = state.waves[target]
  if (!wave) {
    return state
  }
  if (wave.status === 'succeeded') {
    return state
  }

  // 更前的波次未成功时不允许跳波执行，保证下游等待前序目录完整。
  const blockedByEarlier = state.waves
    .slice(0, target)
    .some((item) => item.status !== 'succeeded')
  if (blockedByEarlier) {
    return state
  }

  wave.status = 'running'
  wave.startedAt = wave.startedAt ?? now()
  state.updatedAt = now()

  const failures: string[] = []
  await Promise.all(
    wave.nodeIds.map(async (nodeId) => {
      const record = state.nodeStates[nodeId]
      // 重入保护：运行中或已成功的节点不再执行，杜绝同波重复写入。
      if (!record || record.state === 'running' || record.state === 'succeeded') {
        return
      }
      const node = graph.nodes.find((item) => item.id === nodeId)!
      patchNode(state, nodeId, { state: 'running', error: null })

      const run = state.faultNodeIds.includes(nodeId)
        ? { ok: false, message: `节点 ${node.code} 执行失败（模拟故障），输出目录未完整` }
        : await executor(node)

      if (run.ok) {
        patchNode(state, nodeId, {
          state: 'succeeded',
          attempts: record.attempts + 1,
          writeCount: record.writeCount + 1,
          error: null,
        })
      } else {
        patchNode(state, nodeId, {
          state: 'failed',
          attempts: record.attempts + 1,
          error: run.message ?? '执行失败',
        })
        failures.push(nodeId)
      }
    }),
  )

  wave.failureNodeIds = unique(failures)
  wave.finishedAt = now()
  wave.status = failures.length > 0 ? 'failed' : 'succeeded'
  refreshUnfinished(state)
  state.updatedAt = now()
  return state
}

/**
 * 从头推进到结束：逐波执行；出现失败则停在失败波，返回当前态。
 * 解除故障后再次调用即可从失败区间继续，已成功节点不会重写。
 */
export async function runAll(
  graph: DependencyGraph,
  state: RunState,
  executor?: NodeExecutor,
): Promise<RunState> {
  let guard = 0
  while (currentWaveIndex(state) < state.waves.length && guard <= state.waves.length) {
    const index = currentWaveIndex(state)
    const before = state.waves[index].status
    await runWave(graph, state, executor, index)
    if (state.waves[index].status === 'failed' || state.waves[index].status === before) {
      break
    }
    guard += 1
  }
  return state
}

/** 单节点重跑入口：只允许 failed 节点，且必须位于当前失败波内；成功节点受保护不可重写。 */
export async function retryNode(
  graph: DependencyGraph,
  state: RunState,
  nodeId: string,
  executor?: NodeExecutor,
): Promise<RunState> {
  const record = state.nodeStates[nodeId]
  if (!record || record.state !== 'failed') {
    return state
  }
  const waveIndex = currentWaveIndex(state)
  if (record.wave !== waveIndex) {
    return state
  }
  return runWave(graph, state, executor, waveIndex)
}

/** 汇总未完成步骤，与波次记录分开提供给页面和批次同步。 */
export function unfinishedSteps(state: RunState): StepRecord[] {
  return state.unfinishedNodeIds.map((id) => state.nodeStates[id]).filter(Boolean)
}

export function isFinished(state: RunState): boolean {
  return (
    state.waves.every((wave) => wave.status === 'succeeded') &&
    state.unfinishedNodeIds.length === 0
  )
}

export type { StepState }
