import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildDependencyGraph,
  planWaves,
  splitRefs,
  waveOf,
} from '../dependency-graph'
import {
  createRunState,
  currentWaveIndex,
  isFinished,
  markFault,
  retryNode,
  runAll,
  runWave,
  unfinishedSteps,
} from '../engine'
import type { GraphNodeInput } from '../types'

function node(partial: Partial<GraphNodeInput> & Pick<GraphNodeInput, 'id' | 'code'>): GraphNodeInput {
  return {
    name: partial.code,
    inputSources: [],
    outputTarget: '',
    dependencyCodes: [],
    ...partial,
  }
}

/** 题目示例一：A清洗、B映射、C落盘、D分发；A 与 C 无依赖并行，B 等 A，D 等 B 和 C。 */
function abcdNodes(): GraphNodeInput[] {
  return [
    node({ id: 'A', code: 'A', name: 'A清洗', inputSources: ['raw://in'], outputTarget: 'dir://cleaned' }),
    node({
      id: 'B',
      code: 'B',
      name: 'B映射',
      inputSources: ['dir://cleaned'],
      outputTarget: 'dir://mapped',
      dependencyCodes: ['A'],
    }),
    node({ id: 'C', code: 'C', name: 'C落盘', inputSources: ['raw://in'], outputTarget: 'dir://landing' }),
    node({
      id: 'D',
      code: 'D',
      name: 'D分发',
      inputSources: ['dir://mapped', 'dir://landing'],
      outputTarget: 'dir://dispatch',
      dependencyCodes: ['B', 'C'],
    }),
  ]
}

/** 题目示例二：N1→N3→N5、N2→N5；N1/N2 同批，N5 等两者均完成。 */
function forkNodes(): GraphNodeInput[] {
  return [
    node({ id: 'N1', code: 'N1', inputSources: ['raw://t'], outputTarget: 'dir://n1' }),
    node({ id: 'N2', code: 'N2', inputSources: ['raw://t'], outputTarget: 'dir://n2' }),
    node({ id: 'N3', code: 'N3', inputSources: ['dir://n1'], outputTarget: 'dir://n3', dependencyCodes: ['N1'] }),
    node({
      id: 'N5',
      code: 'N5',
      inputSources: ['dir://n3', 'dir://n2'],
      outputTarget: 'dir://n5',
      dependencyCodes: ['N3', 'N2'],
    }),
  ]
}

describe('splitRefs 多值字段解析', () => {
  it('兼容逗号、分号、顿号与空白分隔', () => {
    expect(splitRefs('PIPE-B, PIPE-C；PIPE-D、PIPE-E\nPIPE-F')).toEqual([
      'PIPE-B',
      'PIPE-C',
      'PIPE-D',
      'PIPE-E',
      'PIPE-F',
    ])
    expect(splitRefs('   ')).toEqual([])
  })
})

describe('buildDependencyGraph · ABCD 四步图', () => {
  const graph = buildDependencyGraph('ABCD-CLEAN', abcdNodes())

  it('A 与 C 落在第 0 波并行，B 在第 1 波，D 在第 2 波', () => {
    expect(graph.waves).toEqual([['A', 'C'], ['B'], ['D']])
    expect(waveOf(graph, 'A')).toBe(0)
    expect(waveOf(graph, 'C')).toBe(0)
    expect(waveOf(graph, 'B')).toBe(1)
    expect(waveOf(graph, 'D')).toBe(2)
  })

  it('同时排出显式依赖边与输入/输出数据依赖边', () => {
    const kinds = new Map(graph.edges.map((edge) => [`${edge.from}->${edge.to}:${edge.kind}`, true]))
    expect(kinds.has('A->B:explicit')).toBe(true)
    expect(kinds.has('A->B:data')).toBe(true)
    expect(kinds.has('B->D:explicit')).toBe(true)
    expect(kinds.has('C->D:data')).toBe(true)
  })

  it('无校验问题、无阻塞节点', () => {
    expect(graph.issues).toEqual([])
    expect(graph.blocked).toEqual([])
  })
})

describe('buildDependencyGraph · N1/N2 分叉汇聚图', () => {
  const graph = buildDependencyGraph('N-FORK', forkNodes())

  it('N1 与 N2 同批运行，N3 第二波，N5 必须等两者均完成（第三波）', () => {
    expect(graph.waves).toEqual([
      expect.arrayContaining(['N1', 'N2']),
      ['N3'],
      ['N5'],
    ])
    expect(graph.waves[0]).toHaveLength(2)
  })
})

describe('仅靠输入数据源/输出目标也能自动成边', () => {
  it('没有显式依赖时，输出目标被下游引用即形成数据依赖并分波', () => {
    const nodes = [
      node({ id: '1', code: 'P', outputTarget: 'dir://x' }),
      node({ id: '2', code: 'Q', inputSources: ['dir://x'], outputTarget: 'dir://y' }),
    ]
    const graph = buildDependencyGraph('DATA-ONLY', nodes)
    expect(graph.edges).toContainEqual({ from: '1', to: '2', kind: 'data' })
    expect(graph.waves).toEqual([['1'], ['2']])
  })
})

describe('输出目标冲突仲裁', () => {
  it('同波只允许一个写者，其余写者顺延串行，并登记 warning', () => {
    const nodes = [
      node({ id: '1', code: 'P', outputTarget: 'dir://same' }),
      node({ id: '2', code: 'Q', outputTarget: 'dir://same' }),
    ]
    const graph = buildDependencyGraph('CONFLICT', nodes)
    expect(graph.waves).toEqual([['1'], ['2']])
    const conflict = graph.issues.find((issue) => issue.type === 'output-conflict')
    expect(conflict?.level).toBe('warning')
    expect(conflict?.nodeIds).toEqual(['1', '2'])
    // 冲突不阻塞：两个节点都能被调度。
    expect(graph.blocked).toEqual([])
  })
})

describe('循环依赖与不可达仲裁', () => {
  it('互相依赖的节点全部硬阻塞，下游节点标记不可达，不进入任何波次', () => {
    const nodes = [
      node({ id: 'X1', code: 'X1', outputTarget: 'dir://s', dependencyCodes: ['X2'] }),
      node({ id: 'X2', code: 'X2', outputTarget: 'dir://s', dependencyCodes: ['X1'] }),
      node({ id: 'X3', code: 'X3', inputSources: ['dir://s'], dependencyCodes: ['X1'] }),
    ]
    const graph = buildDependencyGraph('CYCLE', nodes)
    expect(graph.waves).toEqual([])
    const blockedIds = graph.blocked.map((item) => item.nodeId).sort()
    expect(blockedIds).toEqual(['X1', 'X2', 'X3'])
    expect(graph.issues.some((issue) => issue.type === 'cycle' && issue.level === 'error')).toBe(true)
    expect(graph.issues.some((issue) => issue.type === 'unreachable' && issue.nodeIds.includes('X3'))).toBe(true)
  })

  it('未知依赖阻塞引用方', () => {
    const nodes = [node({ id: 'L', code: 'L', dependencyCodes: ['GHOST'] })]
    const graph = buildDependencyGraph('UNKNOWN', nodes)
    expect(graph.blocked[0]?.reason).toContain('GHOST')
    expect(graph.issues.some((issue) => issue.type === 'unknown-dependency')).toBe(true)
    expect(graph.waves).toEqual([])
  })
})

describe('planWaves 作为唯一波次判断入口的稳定性', () => {
  it('重复规划结果一致（纯函数）', () => {
    const graph = buildDependencyGraph('N-FORK', forkNodes())
    expect(planWaves(graph)).toEqual(graph.waves)
  })
})

describe('执行引擎 · 整图并行推进', () => {
  it('ABCD 三波全部成功，阻塞节点不参与调度', () => {
    const graph = buildDependencyGraph('ABCD-CLEAN', abcdNodes())
    const state = createRunState(graph)
    return runAll(graph, state).then((finished) => {
      expect(finished.waves.map((wave) => wave.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
      expect(Object.values(finished.nodeStates).every((record) => record.state === 'succeeded')).toBe(true)
      expect(isFinished(finished)).toBe(true)
      expect(unfinishedSteps(finished)).toEqual([])
    })
  })
})

describe('执行引擎 · 并发重入同一波次只写一次', () => {
  it('两个并发 runWave 调用下每个节点 writeCount 至多为 1', async () => {
    const graph = buildDependencyGraph('N-FORK', forkNodes())
    const state = createRunState(graph)
    await Promise.all([runWave(graph, state), runWave(graph, state)])
    expect(state.waves[0].status).toBe('succeeded')
    for (const nodeId of graph.waves[0]) {
      expect(state.nodeStates[nodeId].writeCount).toBe(1)
    }
    // 已成功波次再次调用直接返回，不产生新写入。
    await runWave(graph, state, undefined, 0)
    for (const nodeId of graph.waves[0]) {
      expect(state.nodeStates[nodeId].writeCount).toBe(1)
    }
  })
})

describe('执行引擎 · 失败后只重做失败区间', () => {
  it('故障节点令波次失败并阻断下游，解除后仅 failed 节点重跑，成功节点不重写', async () => {
    const graph = buildDependencyGraph('ABCD-CLEAN', abcdNodes())
    let state = createRunState(graph)
    state = markFault(state, 'A', true)

    await runAll(graph, state)
    // 第 0 波：C 成功、A 失败；后续波次保持等待。
    expect(state.waves[0].status).toBe('failed')
    expect(state.nodeStates.A.state).toBe('failed')
    expect(state.nodeStates.C.state).toBe('succeeded')
    expect(state.waves[1].status).toBe('pending')
    expect(currentWaveIndex(state)).toBe(0)
    // 未完成步骤与波次记录分开维护。
    expect(state.unfinishedNodeIds.sort()).toEqual(['A', 'B', 'D'])
    expect(state.waves).toHaveLength(3)

    // 解除故障后重做失败节点：A 重跑成功，C 的写入次数保持 1。
    state = markFault(state, 'A', false)
    await retryNode(graph, state, 'A')
    expect(state.nodeStates.A.state).toBe('succeeded')
    expect(state.nodeStates.A.writeCount).toBe(1)
    expect(state.nodeStates.C.writeCount).toBe(1)
    expect(state.waves[0].status).toBe('succeeded')

    // 继续推进到整图完成。
    await runAll(graph, state)
    expect(isFinished(state)).toBe(true)
    expect(state.nodeStates.B.writeCount).toBe(1)
    expect(state.nodeStates.D.writeCount).toBe(1)
  })

  it('阻塞节点永远不会被执行', async () => {
    const nodes = [
      node({ id: 'X1', code: 'X1', dependencyCodes: ['X2'] }),
      node({ id: 'X2', code: 'X2', dependencyCodes: ['X1'] }),
    ]
    const graph = buildDependencyGraph('CYCLE', nodes)
    const state = createRunState(graph)
    await runAll(graph, state)
    expect(state.waves).toEqual([])
    expect(Object.values(state.nodeStates).every((record) => record.state === 'blocked')).toBe(true)
  })
})

describe('执行引擎 · 自定义执行器与逐波推进', () => {
  beforeEach(() => {
    // 占位：保证后续用例间状态对象互不影响（每个用例自行 createRunState）。
  })

  it('执行器失败信息写入步骤记录', async () => {
    const graph = buildDependencyGraph('N-FORK', forkNodes())
    const state = createRunState(graph)
    await runWave(graph, state, async (target) => ({
      ok: target.id !== 'N1',
      message: target.id === 'N1' ? '目录写入超时' : undefined,
    }))
    expect(state.nodeStates.N1.state).toBe('failed')
    expect(state.nodeStates.N1.error).toBe('目录写入超时')
    expect(state.nodeStates.N2.state).toBe('succeeded')
    expect(state.waves[0].failureNodeIds).toEqual(['N1'])
  })
})
