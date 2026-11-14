import { beforeEach, describe, expect, it } from 'vitest'

import { listRows, resetRows } from '@/data/local-store'
import {
  applyBatchSyncToRows,
  batchIdToGraphId,
  ensureRunState,
  executeGraph,
  getPipelineGraph,
  listGraphIds,
  listRpaBatches,
  retryFailedNode,
  syncBatch,
  toGraphNode,
  toggleFault,
} from '@/api/orchestration-service'
import { removeRunState } from '@/orchestrator/run-store'

function resetAll(): void {
  resetRows('pipeline')
  resetRows('rpaflow')
  for (const graphId of listGraphIds()) {
    removeRunState(graphId)
  }
}

describe('编排服务层 · 流水线业务行解析为依赖图', () => {
  beforeEach(resetAll)

  it('按「编排图」字段分出三张图', () => {
    expect(listGraphIds()).toEqual(['ABCD-CLEAN', 'N-FORK', 'FAULT-DEMO'])
    expect(listRpaBatches()).toEqual([
      'BATCH-ABCD-CLEAN',
      'BATCH-N-FORK',
      'BATCH-FAULT-DEMO',
    ])
  })

  it('ABCD 图：A/C 同波、B 次波、D 末波（行 id 作为节点 id）', () => {
    const graph = getPipelineGraph('ABCD-CLEAN')
    expect(graph.waves).toEqual([['1', '3'], ['2'], ['4']])
    expect(graph.issues).toEqual([])
  })

  it('N-FORK 图：N1/N2 同批，N3 第二波，N5 第三波等齐两个分支', () => {
    const graph = getPipelineGraph('N-FORK')
    expect(graph.waves[0].sort()).toEqual(['5', '6'])
    expect(graph.waves[1]).toEqual(['7'])
    expect(graph.waves[2]).toEqual(['8'])
  })

  it('FAULT-DEMO 图：循环节点与不可达下游全部阻塞，输出冲突登记告警', () => {
    const graph = getPipelineGraph('FAULT-DEMO')
    expect(graph.waves).toEqual([])
    expect(graph.blocked.map((item) => item.nodeId).sort()).toEqual(['10', '11', '9'])
    expect(graph.issues.some((issue) => issue.type === 'cycle')).toBe(true)
    expect(graph.issues.some((issue) => issue.type === 'unreachable')).toBe(true)
    const conflict = graph.issues.find((issue) => issue.type === 'output-conflict')
    expect(conflict?.level).toBe('warning')
  })

  it('toGraphNode 收拢多值输入数据源与依赖步骤解析', () => {
    const rowD = listRows('pipeline').find((row) => row['步骤编号'] === 'PIPE-D')!
    const nodeD = toGraphNode(rowD)
    expect(nodeD.inputSources).toEqual(['dir://mapped', 'dir://landing'])
    expect(nodeD.dependencyCodes).toEqual(['PIPE-B', 'PIPE-C'])
    expect(nodeD.outputTarget).toBe('dir://dispatch')
  })
})

describe('编排服务层 · 执行与 RPA 批次清单同步', () => {
  beforeEach(resetAll)

  it('整图执行完成后，批次同步拿到全量成功结果', async () => {
    const { state } = await executeGraph('N-FORK')
    expect(state.waves.every((wave) => wave.status === 'succeeded')).toBe(true)

    const sync = syncBatch('BATCH-N-FORK')!
    expect(sync.finished).toBe(true)
    expect(sync.blocked).toEqual([])
    expect(sync.unfinished).toEqual([])
    expect(sync.waves).toHaveLength(3)
    const n5 = sync.waves[2].steps.find((step) => step.code === 'N5')!
    expect(n5.state).toBe('succeeded')
    expect(n5.writeCount).toBe(1)
    expect(batchIdToGraphId('BATCH-N-FORK')).toBe('N-FORK')
  })

  it('故障批次把阻塞节点与失败步骤结果同步到清单，解除后只重做失败区间', async () => {
    // 行 id 1 = PIPE-A：注入故障后整图执行应停在第 1 波。
    toggleFault('ABCD-CLEAN', '1')
    const failed = await executeGraph('ABCD-CLEAN')
    expect(failed.state.waves[0].status).toBe('failed')

    const syncWhenFailed = syncBatch('BATCH-ABCD-CLEAN')!
    expect(syncWhenFailed.finished).toBe(false)
    const stepA = syncWhenFailed.waves[0].steps.find((step) => step.code === 'PIPE-A')!
    expect(stepA.state).toBe('failed')
    expect(syncWhenFailed.unfinished.map((item) => item.code).sort()).toEqual(['PIPE-A', 'PIPE-B', 'PIPE-D'])

    // 同步回写到 rpaflow 清单行。
    applyBatchSyncToRows()
    const rpaRows = listRows('rpaflow')
    const failedBatchRow = rpaRows.find((row) => row['执行批次'] === 'BATCH-ABCD-CLEAN')!
    expect(String(failedBatchRow['步骤运行结果'])).toContain('PIPE-A=failed')
    expect(String(failedBatchRow['阻塞节点'])).toBe('无')

    // 故障批次（循环图）的清单行应带阻塞原因。
    const faultBatchRow = rpaRows.find((row) => row['执行批次'] === 'BATCH-FAULT-DEMO')!
    expect(String(faultBatchRow['阻塞节点'])).toContain('循环依赖')

    // 解除故障，只重做失败节点，随后整图完成；已成功的 C 写入次数保持 1。
    toggleFault('ABCD-CLEAN', '1')
    await retryFailedNode('ABCD-CLEAN', '1')
    const recovered = await executeGraph('ABCD-CLEAN')
    expect(recovered.state.nodeStates['3'].writeCount).toBe(1)
    expect(recovered.state.nodeStates['1'].writeCount).toBe(1)
    expect(syncBatch('BATCH-ABCD-CLEAN')!.finished).toBe(true)
  })

  it('未匹配批次返回 null，ensureRunState 对阻塞图也能初始化', () => {
    expect(syncBatch('BATCH-NOT-EXIST')).toBeNull()
    const { graph, state } = ensureRunState('FAULT-DEMO')
    expect(graph.blocked.length).toBe(3)
    expect(state.blockedNodeIds.sort()).toEqual(['10', '11', '9'])
    expect(state.waves).toEqual([])
  })
})
