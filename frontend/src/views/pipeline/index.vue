<template>
  <section class="page" data-module="pipeline">
    <header class="page-head">
      <div>
        <h2>采集流水线管理</h2>
        <p class="page-desc">依据输入数据源与输出目标排出依赖图：无依赖步骤同波并行，下游等待前序目录完整；执行波次与未完成步骤按图分别记录。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记流水线步骤</button>
        <button class="btn" type="button" @click="exportRows">导出采集流水线清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 节点编排：依赖解析与波次判断全部来自 orchestrator 统一核心 -->
    <div class="orchestration-panel">
      <div class="panel-head">
        <h3>节点编排 · 并行波次</h3>
        <div class="panel-tools">
          <label class="graph-select">
            <span>编排图</span>
            <select v-model="activeGraphId" @change="reloadOrchestration">
              <option v-for="graphId in graphIds" :key="graphId" :value="graphId">{{ graphId }}</option>
            </select>
          </label>
          <button class="btn" type="button" :disabled="!activeGraphId" @click="onRunNextWave">执行当前波</button>
          <button class="btn primary" type="button" :disabled="!activeGraphId" @click="onRunAll">整图执行</button>
          <button class="btn ghost" type="button" :disabled="!activeGraphId" @click="onReset">重置批次</button>
        </div>
      </div>

      <p v-if="orchestrationError" class="error-text">{{ orchestrationError }}</p>

      <template v-if="activeGraph">
        <div class="issue-list">
          <span class="issue-title">依赖图校验（优先级：循环/未知依赖硬阻塞 → 输出冲突同波串行 → 普通依赖分波）</span>
          <p v-if="!activeGraph.issues.length" class="issue-ok">未发现循环依赖、未知依赖或输出目标冲突。</p>
          <ul>
            <li v-for="(issue, index) in activeGraph.issues" :key="index" :class="['issue-item', issue.level]">
              <strong>{{ issue.level === 'error' ? '阻塞' : '告警' }}</strong>
              <span>{{ issue.message }}</span>
            </li>
          </ul>
        </div>

        <div class="wave-board">
          <div v-for="wave in activeState?.waves ?? []" :key="wave.wave" :class="['wave-column', wave.status]">
            <header class="wave-head">
              <span>第 {{ wave.wave + 1 }} 波</span>
              <em>{{ waveStatusLabel(wave.status) }}</em>
            </header>
            <article
              v-for="nodeId in wave.nodeIds"
              :key="nodeId"
              :class="['node-card', nodeState(nodeId)?.state]"
            >
              <div class="node-title">{{ nodeOf(nodeId)?.code }} · {{ nodeOf(nodeId)?.name }}</div>
              <div class="node-meta">
                输入：{{ nodeOf(nodeId)?.inputSources.join('、') || '—' }}<br />
                输出：{{ nodeOf(nodeId)?.outputTarget || '—' }}
              </div>
              <div class="node-state">
                <span :class="['state-badge', nodeState(nodeId)?.state]">{{ stateLabel(nodeState(nodeId)?.state) }}</span>
                <span class="node-attempts">
                  尝试 {{ nodeState(nodeId)?.attempts ?? 0 }} 次 · 写入 {{ nodeState(nodeId)?.writeCount ?? 0 }} 次
                </span>
              </div>
              <p v-if="nodeState(nodeId)?.error" class="node-error">{{ nodeState(nodeId)?.error }}</p>
              <div class="node-actions">
                <button
                  class="link"
                  type="button"
                  @click="onToggleFault(nodeId)"
                >
                  {{ activeState?.faultNodeIds.includes(nodeId) ? '解除故障注入' : '注入故障' }}
                </button>
                <button
                  class="link"
                  type="button"
                  :disabled="nodeState(nodeId)?.state !== 'failed'"
                  @click="onRetry(nodeId)"
                >
                  重做失败节点
                </button>
              </div>
            </article>
          </div>
        </div>

        <div v-if="activeGraph.blocked.length" class="blocked-list">
          <h4>阻塞节点（同步到 RPA 批次清单）</h4>
          <ul>
            <li v-for="item in activeGraph.blocked" :key="item.nodeId">
              <strong>{{ nodeOf(item.nodeId)?.code }}</strong>
              <span>{{ item.reason }}</span>
            </li>
          </ul>
        </div>

        <div class="unfinished-list">
          <h4>未完成步骤（与执行波次分开记录，共 {{ activeState?.unfinishedNodeIds.length ?? 0 }} 个）</h4>
          <p v-if="!(activeState?.unfinishedNodeIds.length)" class="issue-ok">全部步骤已完成，无未完成项。</p>
          <div v-else class="unfinished-tags">
            <span v-for="nodeId in activeState?.unfinishedNodeIds" :key="nodeId" :class="['legend-item', nodeState(nodeId)?.state]">
              {{ nodeOf(nodeId)?.code }} · {{ stateLabel(nodeState(nodeId)?.state) }}
            </span>
          </div>
        </div>

        <p class="batch-meta">
          批次号：{{ activeState?.batchId }} ｜ 创建：{{ activeState?.createdAt }} ｜ 最近更新：{{ activeState?.updatedAt }}
        </p>
      </template>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无采集流水线数据，可先登记流水线步骤</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条采集流水线记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  currentWaveOf,
  ensureRunState,
  executeGraph,
  executeNextWave,
  getAllGraphs,
  resetGraphRun,
  retryFailedNode,
  toggleFault,
} from '@/api/orchestration-service'
import type { DependencyGraph, RunState, StepState } from '@/orchestrator/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pipeline')
const columns = ["步骤编号", "步骤名称", "编排图", "输入数据源", "处理逻辑", "输出目标", "依赖步骤", "并行度", "失败策略"]
const actions = ["提交校验", "启用步骤", "停用步骤"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [{"label": "流水线步骤总数", "value": 0}, {"label": "已启用步骤", "value": 0}, {"label": "待校验步骤", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 编排面板状态：图与运行态都按 graphId 分别读取，不在页面内自行做依赖解析/波次判断。
const graphIds = ref<string[]>([])
const activeGraphId = ref('')
const activeGraph = ref<DependencyGraph | null>(null)
const activeState = ref<RunState | null>(null)
const orchestrationError = ref('')

const STATE_LABELS: Record<StepState, string> = {
  idle: '待执行',
  running: '执行中',
  succeeded: '已成功',
  failed: '已失败',
  blocked: '已阻塞',
}

const WAVE_LABELS = {
  pending: '待启动',
  running: '执行中',
  succeeded: '已完成',
  failed: '有失败',
} as const

function stateLabel(state?: StepState): string {
  return state ? STATE_LABELS[state] : '—'
}

function waveStatusLabel(status: keyof typeof WAVE_LABELS): string {
  return WAVE_LABELS[status]
}

function nodeOf(nodeId: string) {
  return activeGraph.value?.nodes.find((node) => node.id === nodeId)
}

function nodeState(nodeId: string) {
  return activeState.value?.nodeStates[nodeId]
}

function reloadOrchestration() {
  orchestrationError.value = ''
  try {
    const graphs = getAllGraphs()
    graphIds.value = graphs.map((graph) => graph.graphId)
    if (!graphIds.value.includes(activeGraphId.value)) {
      activeGraphId.value = graphIds.value[0] ?? ''
    }
    if (!activeGraphId.value) {
      activeGraph.value = null
      activeState.value = null
      return
    }
    const loaded = ensureRunState(activeGraphId.value)
    activeGraph.value = loaded.graph
    activeState.value = loaded.state
  } catch (error) {
    orchestrationError.value = error instanceof Error ? error.message : '依赖图编排失败'
  }
}

async function onRunNextWave() {
  if (!activeGraphId.value) {
    return
  }
  const { graph, state } = await executeNextWave(activeGraphId.value)
  activeGraph.value = graph
  activeState.value = state
}

async function onRunAll() {
  if (!activeGraphId.value) {
    return
  }
  const { graph, state } = await executeGraph(activeGraphId.value)
  activeGraph.value = graph
  activeState.value = state
  if (state.waves[currentWaveOf(state)]?.status === 'failed') {
    orchestrationError.value = '存在失败步骤，批次停在失败波；解除故障后重做失败节点即可，已成功步骤不会重写。'
  }
}

async function onRetry(nodeId: string) {
  if (!activeGraphId.value) {
    return
  }
  orchestrationError.value = ''
  const { graph, state } = await retryFailedNode(activeGraphId.value, nodeId)
  activeGraph.value = graph
  activeState.value = state
}

function onToggleFault(nodeId: string) {
  if (!activeGraphId.value) {
    return
  }
  activeState.value = toggleFault(activeGraphId.value, nodeId)
}

function onReset() {
  if (!activeGraphId.value) {
    return
  }
  orchestrationError.value = ''
  const { graph, state } = resetGraphRun(activeGraphId.value)
  activeGraph.value = graph
  activeState.value = state
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '流水线步骤登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  reloadOrchestration()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '采集流水线列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadOrchestration()
})
</script>
