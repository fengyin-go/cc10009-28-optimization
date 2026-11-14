/**
 * 编排服务层：流水线页面与 RPA 批次清单共用的唯一编排入口。
 *
 * 页面不直接拼依赖图，统一在这里把 pipeline 业务行解析成 GraphNodeInput，
 * 再交给 orchestrator 统一核心做依赖解析、波次判断与执行，保证两处口径一致。
 */
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { buildDependencyGraph, splitRefs } from '@/orchestrator/dependency-graph'
import {
  createRunState,
  currentWaveIndex,
  hydrateRunState,
  isFinished,
  markFault,
  retryNode,
  runAll,
  runWave,
  unfinishedSteps,
} from '@/orchestrator/engine'
import { loadRunState, removeRunState, saveRunState } from '@/orchestrator/run-store'
import type {
  DependencyGraph,
  GraphNodeInput,
  RunState,
  StepRecord,
  WaveRecord,
} from '@/orchestrator/types'

const PIPELINE_KEY = 'pipeline'
const RPAFLOW_KEY = 'rpaflow'

/** 同步给 RPA 批次清单的结构：阻塞节点 + 分波次步骤运行结果，一次取齐。 */
export type BatchSync = {
  graphId: string
  batchId: string
  blocked: { nodeId: string; code: string; name: string; reason: string }[]
  waves: {
    wave: number
    status: WaveRecord['status']
    steps: {
      nodeId: string
      code: string
      name: string
      state: StepRecord['state']
      attempts: number
      writeCount: number
      error: string | null
    }[]
  }[]
  unfinished: { nodeId: string; code: string; name: string; state: StepRecord['state'] }[]
  finished: boolean
}

function text(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

/** 单条流水线步骤行 → 编排图节点输入；依赖解析规则只此一份。 */
export function toGraphNode(row: EntryRow): GraphNodeInput {
  return {
    id: String(row.id),
    code: text(row, '步骤编号'),
    name: text(row, '步骤名称'),
    inputSources: splitRefs(text(row, '输入数据源')),
    outputTarget: text(row, '输出目标'),
    dependencyCodes: splitRefs(text(row, '依赖步骤')),
  }
}

/** 按「编排图」字段把流水线步骤分组，保证各图依赖与波次独立计算。 */
export function listGraphIds(): string[] {
  const ids = listRows(PIPELINE_KEY)
    .map((row) => text(row, '编排图'))
    .filter((value) => value.length > 0)
  return [...new Set(ids)]
}

export function getPipelineGraph(graphId: string): DependencyGraph {
  const rows = listRows(PIPELINE_KEY).filter((row) => text(row, '编排图') === graphId)
  const nodes = rows.map(toGraphNode)
  return buildDependencyGraph(graphId, nodes)
}

export function getAllGraphs(): DependencyGraph[] {
  return listGraphIds().map((graphId) => getPipelineGraph(graphId))
}

/** 取运行态：没有记录时按依赖图初始化；有记录时与最新图结构做水合对齐。 */
export function ensureRunState(graphId: string): { graph: DependencyGraph; state: RunState } {
  const graph = getPipelineGraph(graphId)
  const persisted = loadRunState(graphId)
  const state = persisted ? hydrateRunState(persisted, graph) : createRunState(graph)
  saveRunState(state)
  return { graph, state }
}

export function getRunState(graphId: string): RunState | null {
  return loadRunState(graphId)
}

function persist(state: RunState): RunState {
  return saveRunState(state)
}

/** 执行整张图：逐波并行推进，遇失败停在失败波，已成功步骤不重写。 */
export async function executeGraph(graphId: string): Promise<{ graph: DependencyGraph; state: RunState }> {
  const { graph, state } = ensureRunState(graphId)
  await runAll(graph, state)
  return { graph, state: persist(state) }
}

/** 只推进当前波（用于逐波观察并行波次与阻塞点）。 */
export async function executeNextWave(graphId: string): Promise<{ graph: DependencyGraph; state: RunState }> {
  const { graph, state } = ensureRunState(graphId)
  await runWave(graph, state)
  return { graph, state: persist(state) }
}

/** 失败区间重做：仅重跑当前失败波里的 failed 节点。 */
export async function retryFailedNode(
  graphId: string,
  nodeId: string,
): Promise<{ graph: DependencyGraph; state: RunState }> {
  const { graph, state } = ensureRunState(graphId)
  await retryNode(graph, state, nodeId)
  return { graph, state: persist(state) }
}

/** 故障注入/解除：演示“失败后只重做失败区间”，不改动步骤主数据。 */
export function toggleFault(graphId: string, nodeId: string): RunState {
  const { state } = ensureRunState(graphId)
  const active = !state.faultNodeIds.includes(nodeId)
  return persist(markFault(state, nodeId, active))
}

export function resetGraphRun(graphId: string): { graph: DependencyGraph; state: RunState } {
  removeRunState(graphId)
  return ensureRunState(graphId)
}

export function currentWaveOf(state: RunState): number {
  return currentWaveIndex(state)
}

export function unfinishedOf(state: RunState): StepRecord[] {
  return unfinishedSteps(state)
}

/**
 * RPA 批次清单同步：按 rpaflow 行的「执行批次」匹配流水线 graphId（BATCH-<graphId>），
 * 输出阻塞节点与步骤运行结果。没有运行记录时返回初始态，阻塞信息仍然可见。
 */
export function syncBatch(batchId: string): BatchSync | null {
  const graphId = batchIdToGraphId(batchId)
  if (!graphId || !listGraphIds().includes(graphId)) {
    return null
  }
  const { graph, state } = ensureRunState(graphId)
  const describeNode = (nodeId: string) => {
    const node = graph.nodes.find((item) => item.id === nodeId)
    return {
      nodeId,
      code: node?.code ?? nodeId,
      name: node?.name ?? '—',
    }
  }

  return {
    graphId,
    batchId: state.batchId,
    blocked: graph.blocked.map((item) => ({ ...describeNode(item.nodeId), reason: item.reason })),
    waves: state.waves.map((wave) => ({
      wave: wave.wave,
      status: wave.status,
      steps: wave.nodeIds.map((nodeId) => {
        const record = state.nodeStates[nodeId]
        return {
          ...describeNode(nodeId),
          state: record.state,
          attempts: record.attempts,
          writeCount: record.writeCount,
          error: record.error,
        }
      }),
    })),
    unfinished: unfinishedSteps(state).map((record) => ({
      ...describeNode(record.nodeId),
      state: record.state,
    })),
    finished: isFinished(state),
  }
}

export function batchIdToGraphId(batchId: string): string | null {
  const prefix = 'BATCH-'
  return batchId.startsWith(prefix) ? batchId.slice(prefix.length) : null
}

/** RPA 清单中出现过的全部执行批次（去重，保持录入顺序）。 */
export function listRpaBatches(): string[] {
  return [
    ...new Set(
      listRows(RPAFLOW_KEY)
        .map((row) => text(row, '执行批次'))
        .filter((value) => value.length > 0),
    ),
  ]
}

/**
 * 把同步结果回写到 rpaflow 行：同批次的每行都带上阻塞节点与步骤运行结果摘要，
 * 字段沿用行结构，页面表格无需另建数据源即可展示。
 */
export function applyBatchSyncToRows(): EntryRow[] {
  const rows = listRows(RPAFLOW_KEY)
  const next = rows.map((row) => {
    const batchId = text(row, '执行批次')
    if (!batchId) {
      return row
    }
    const sync = syncBatch(batchId)
    if (!sync) {
      return { ...row, 阻塞节点: '未匹配到编排图', 步骤运行结果: '—' }
    }
    const blockedText = sync.blocked.length
      ? sync.blocked.map((item) => `${item.code}:${item.reason}`).join('；')
      : '无'
    const resultText = sync.waves
      .map((wave) => {
        const steps = wave.steps.map((step) => `${step.code}=${step.state}`).join('，')
        return `第${wave.wave + 1}波[${wave.status}] ${steps}`
      })
      .join(' ｜ ')
    return { ...row, 阻塞节点: blockedText, 步骤运行结果: resultText }
  })
  saveRows(RPAFLOW_KEY, next)
  return next
}
