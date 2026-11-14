/**
 * 依赖解析与波次判断的统一实现（纯函数、无副作用）。
 *
 * 流水线页面与 RPA 批次同步共用这一边界，任何模块都不允许再自己解析依赖或判断波次：
 * 1. buildDependencyGraph —— 依据输入数据源/输出目标与显式依赖排出依赖图；
 * 2. 循环依赖与输出目标冲突在这里统一仲裁，优先级见 planWaves 注释；
 * 3. planWaves —— 唯一的波次判断入口，无依赖节点同波并行，下游等待前序目录完整。
 */
import type {
  BlockedNode,
  DependencyEdge,
  DependencyGraph,
  GraphIssue,
  GraphNodeInput,
} from './types'

/** 拆分多值字段：依赖步骤、输入数据源都允许用逗号/分号/顿号/换行/空白分隔多个值。 */
export function splitRefs(raw: string): string[] {
  return raw
    .split(/[,，;；、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function emptyAdjacency(nodeIds: string[]): Record<string, string[]> {
  return Object.fromEntries(nodeIds.map((id) => [id, []]))
}

/** Tarjan 强连通分量：size > 1（或自环）的分量即循环依赖，循环内节点全部阻塞。 */
function findCyclicNodeIds(
  nodeIds: string[],
  outgoing: Record<string, string[]>,
): string[][] {
  let index = 0
  const stack: string[] = []
  const onStack = new Set<string>()
  const indices = new Map<string, number>()
  const lowlinks = new Map<string, number>()
  const components: string[][] = []

  const visit = (nodeId: string): void => {
    indices.set(nodeId, index)
    lowlinks.set(nodeId, index)
    index += 1
    stack.push(nodeId)
    onStack.add(nodeId)

    for (const next of outgoing[nodeId] ?? []) {
      if (!indices.has(next)) {
        visit(next)
        lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId)!, lowlinks.get(next)!))
      } else if (onStack.has(next)) {
        lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId)!, indices.get(next)!))
      }
    }

    if (lowlinks.get(nodeId) === indices.get(nodeId)) {
      const component: string[] = []
      let current: string
      do {
        current = stack.pop()!
        onStack.delete(current)
        component.push(current)
      } while (current !== nodeId)
      const selfLoop = (outgoing[nodeId] ?? []).includes(nodeId)
      if (component.length > 1 || selfLoop) {
        components.push(component)
      }
    }
  }

  for (const nodeId of nodeIds) {
    if (!indices.has(nodeId)) {
      visit(nodeId)
    }
  }
  return components
}

/**
 * 构建依赖图。
 *
 * 边来源（都会去重，重复声明不产生重复边）：
 * - explicit：节点「依赖步骤」里列出的步骤编号；
 * - data：节点 A 的输出目标 == 节点 B 的输入数据源，且 A !== B，
 *   表达“下游等待前序目录完整”的数据依赖。
 *
 * 校验问题：
 * - 循环依赖（error）：Tarjan 检出，循环内节点直接阻塞；
 * - 未知依赖（error）：依赖了图中不存在的步骤编号，引用方阻塞；
 * - 输出目标冲突（warning）：多个节点写同一输出目标，按波次规划仲裁（见 planWaves）；
 * - 不可达（error）：前序被阻塞导致永远等不到输入的下游节点。
 */
export function buildDependencyGraph(graphId: string, nodes: GraphNodeInput[]): DependencyGraph {
  const nodeIds = nodes.map((node) => node.id)
  const idSet = new Set(nodeIds)
  const codeToId = new Map<string, string>()
  for (const node of nodes) {
    codeToId.set(node.code, node.id)
  }

  const outgoing = emptyAdjacency(nodeIds)
  const incoming = emptyAdjacency(nodeIds)
  const edges: DependencyEdge[] = []
  const issues: GraphIssue[] = []
  const blocked: BlockedNode[] = []
  const blockReason = new Map<string, string>()

  const addEdge = (from: string, to: string, kind: DependencyEdge['kind']): void => {
    if (from === to) {
      // 自环交给循环检测统一报错，这里不建边。
      return
    }
    const existed = edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind)
    if (existed) {
      return
    }
    edges.push({ from, to, kind })
    outgoing[from].push(to)
    incoming[to].push(from)
  }

  // 1) 显式依赖边 + 未知依赖检测。
  for (const node of nodes) {
    for (const depCode of unique(node.dependencyCodes)) {
      const depId = codeToId.get(depCode)
      if (!depId || !idSet.has(depId)) {
        issues.push({
          level: 'error',
          type: 'unknown-dependency',
          message: `节点 ${node.code} 依赖的步骤「${depCode}」不在当前编排图中`,
          nodeIds: [node.id],
        })
        if (!blockReason.has(node.id)) {
          blockReason.set(node.id, `依赖未知步骤 ${depCode}`)
        }
        continue
      }
      addEdge(depId, node.id, 'explicit')
    }
  }

  // 2) 数据依赖边：输出目标 → 以其为输入数据源的节点。
  const targetToProducers = new Map<string, string[]>()
  for (const node of nodes) {
    if (!node.outputTarget) {
      continue
    }
    const producers = targetToProducers.get(node.outputTarget) ?? []
    producers.push(node.id)
    targetToProducers.set(node.outputTarget, producers)
  }
  for (const node of nodes) {
    for (const source of unique(node.inputSources)) {
      for (const producerId of targetToProducers.get(source) ?? []) {
        addEdge(producerId, node.id, 'data')
      }
    }
  }

  // 3) 循环依赖检测。
  const cyclicComponents = findCyclicNodeIds(nodeIds, outgoing)
  const cyclicNodeIds = new Set<string>()
  for (const component of cyclicComponents) {
    for (const id of component) {
      cyclicNodeIds.add(id)
      if (!blockReason.has(id)) {
        blockReason.set(id, '处于循环依赖中')
      }
    }
    issues.push({
      level: 'error',
      type: 'cycle',
      message: `检测到循环依赖：${component
        .map((id) => nodes.find((node) => node.id === id)?.code ?? id)
        .join(' → ')}（回到自身），循环内节点全部阻塞`,
      nodeIds: [...component],
    })
  }

  // 4) 不可达节点：沿依赖边可达任一循环节点，或依赖了未知步骤的节点的下游。
  const hardBlockedSeeds = new Set<string>(cyclicNodeIds)
  for (const [nodeId, reason] of blockReason) {
    if (reason.startsWith('依赖未知步骤')) {
      hardBlockedSeeds.add(nodeId)
    }
  }
  const reachBlocked = new Set<string>()
  const walkDown = (start: string): void => {
    for (const next of outgoing[start] ?? []) {
      if (reachBlocked.has(next) || hardBlockedSeeds.has(next)) {
        continue
      }
      reachBlocked.add(next)
      walkDown(next)
    }
  }
  for (const seed of hardBlockedSeeds) {
    walkDown(seed)
  }
  for (const id of reachBlocked) {
    if (!blockReason.has(id)) {
      blockReason.set(id, '前序节点被阻塞，输入目录永远无法完整')
    }
    issues.push({
      level: 'error',
      type: 'unreachable',
      message: `节点 ${nodes.find((node) => node.id === id)?.code ?? id} 的前序节点被阻塞，无法到达可执行波次`,
      nodeIds: [id],
    })
  }

  // 5) 输出目标冲突（多写者）：先登记 warning，串行化仲裁在 planWaves 内完成。
  for (const [target, producerIds] of targetToProducers) {
    if (producerIds.length > 1) {
      issues.push({
        level: 'warning',
        type: 'output-conflict',
        message: `输出目标「${target}」被 ${producerIds.length} 个节点同时写入：${producerIds
          .map((id) => nodes.find((node) => node.id === id)?.code ?? id)
          .join('、')}；同波冲突按步骤编号顺序串行，只允许一个节点写入`,
        nodeIds: [...producerIds],
      })
    }
  }

  const graph: DependencyGraph = {
    graphId,
    nodes,
    nodeIds,
    edges,
    outgoing,
    incoming,
    issues,
    blocked: [],
    waves: [],
  }
  graph.waves = planWaves(graph, blockReason)
  graph.blocked = unique([...blockReason.keys()]).map((id) => ({
    nodeId: id,
    reason: blockReason.get(id)!,
  }))
  return graph
}

/**
 * 唯一的波次判断入口（Kahn 分层 + 冲突仲裁）。
 *
 * 调度优先级（由高到低）：
 * 1. 循环依赖 / 未知依赖 / 不可达节点：硬阻塞，不进入任何波次；
 * 2. 输出目标冲突：同波只允许一个写者，其余写者顺延到下一波（串行化，不阻塞），
 *    仲裁顺序取节点在输入列表中的次序（业务侧已按步骤编号排序）；
 * 3. 普通依赖：全部前序节点成功（输出目录完整）后，才允许进入下一波；
 *    无依赖的就绪节点始终落在第 0 波，同波并行。
 */
export function planWaves(
  graph: DependencyGraph,
  blockReason?: Map<string, string>,
): string[][] {
  const blockedSet = new Set((blockReason ? [...blockReason.keys()] : graph.blocked.map((b) => b.nodeId)))
  const level = new Map<string, number>()
  const waves: string[][] = []

  const pushWave = (members: string[]): void => {
    if (members.length === 0) {
      return
    }
    const waveIndex = waves.length
    waves.push(members)
    for (const id of members) {
      level.set(id, waveIndex)
    }
  }

  const remaining = new Set(graph.nodeIds.filter((id) => !blockedSet.has(id)))

  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => {
      const predecessors = graph.incoming[id] ?? []
      // 前序节点要么已完成（不在 remaining），要么被硬阻塞；后者由不可达检测兜底，正常不会出现。
      return predecessors.every((preId) => !remaining.has(preId) || blockedSet.has(preId))
    })

    if (ready.length === 0) {
      // 理论上不可达节点已在构建期清出 remaining；兜底防止死循环。
      break
    }

    const currentWave: string[] = []
    // 仅在“当前波”内去重输出目标：同波冲突的其余写者保留在 remaining，顺延到下一波串行写入。
    const waveTargets = new Set<string>()
    for (const id of ready) {
      const node = graph.nodes.find((item) => item.id === id)!
      if (node.outputTarget && waveTargets.has(node.outputTarget)) {
        continue
      }
      currentWave.push(id)
      remaining.delete(id)
      if (node.outputTarget) {
        waveTargets.add(node.outputTarget)
      }
    }
    pushWave(currentWave)
  }

  return waves
}

/** 节点所在波次；被阻塞或不在图中返回 -1。 */
export function waveOf(graph: DependencyGraph, nodeId: string): number {
  for (let i = 0; i < graph.waves.length; i += 1) {
    if (graph.waves[i].includes(nodeId)) {
      return i
    }
  }
  return -1
}

/** 阻塞原因查询，未阻塞返回 null。 */
export function blockReasonOf(graph: DependencyGraph, nodeId: string): string | null {
  return graph.blocked.find((item) => item.nodeId === nodeId)?.reason ?? null
}
