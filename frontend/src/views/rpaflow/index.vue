<template>
  <section class="page" data-module="rpaflow">
    <header class="page-head">
      <div>
        <h2>RPA流程管理</h2>
        <p class="page-desc">采集批次清单同步流水线编排：按执行批次展示阻塞节点与分波次步骤运行结果，口径与采集流水线页面完全一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记自动化流程</button>
        <button class="btn" type="button" @click="exportRows">导出RPA流程清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 采集批次清单：同步流水线阻塞节点与步骤运行结果 -->
    <div class="orchestration-panel">
      <div class="panel-head">
        <h3>采集批次清单 · 编排同步</h3>
        <div class="panel-tools">
          <label class="graph-select">
            <span>执行批次</span>
            <select v-model="activeBatchId">
              <option v-for="batchId in batchIds" :key="batchId" :value="batchId">{{ batchId }}</option>
            </select>
          </label>
          <button class="btn primary" type="button" :disabled="!activeBatchId" @click="onSync">同步阻塞节点与步骤结果</button>
        </div>
      </div>

      <p v-if="syncMessage" class="issue-ok">{{ syncMessage }}</p>

      <template v-if="activeSync">
        <div :class="['batch-summary', activeSync.finished ? 'finished' : 'running']">
          批次 {{ activeSync.batchId }}：{{ activeSync.finished ? '全部波次已完成' : '仍有未完成步骤' }}
          ｜ 阻塞节点 {{ activeSync.blocked.length }} 个 ｜ 未完成步骤 {{ activeSync.unfinished.length }} 个
        </div>

        <div v-if="activeSync.blocked.length" class="blocked-list">
          <h4>阻塞节点</h4>
          <ul>
            <li v-for="item in activeSync.blocked" :key="item.nodeId">
              <strong>{{ item.code }} · {{ item.name }}</strong>
              <span>{{ item.reason }}</span>
            </li>
          </ul>
        </div>
        <p v-else class="issue-ok">本批次没有阻塞节点。</p>

        <div class="wave-board">
          <div v-for="wave in activeSync.waves" :key="wave.wave" :class="['wave-column', wave.status]">
            <header class="wave-head">
              <span>第 {{ wave.wave + 1 }} 波</span>
              <em>{{ waveStatusLabel(wave.status) }}</em>
            </header>
            <article v-for="step in wave.steps" :key="step.nodeId" :class="['node-card', step.state]">
              <div class="node-title">{{ step.code }} · {{ step.name }}</div>
              <div class="node-state">
                <span :class="['state-badge', step.state]">{{ stateLabel(step.state) }}</span>
                <span class="node-attempts">尝试 {{ step.attempts }} 次 · 写入 {{ step.writeCount }} 次</span>
              </div>
              <p v-if="step.error" class="node-error">{{ step.error }}</p>
            </article>
          </div>
        </div>

        <div class="unfinished-list">
          <h4>未完成步骤（共 {{ activeSync.unfinished.length }} 个）</h4>
          <p v-if="!activeSync.unfinished.length" class="issue-ok">无未完成步骤。</p>
          <div v-else class="unfinished-tags">
            <span v-for="item in activeSync.unfinished" :key="item.nodeId" :class="['legend-item', item.state]">
              {{ item.code }} · {{ stateLabel(item.state) }}
            </span>
          </div>
        </div>
      </template>
      <p v-else-if="activeBatchId" class="error-text">批次 {{ activeBatchId }} 未匹配到编排图。</p>
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
          <th>阻塞节点</th>
          <th>步骤运行结果</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row['阻塞节点'] ?? '未同步' }}</td>
          <td class="sync-result">{{ row['步骤运行结果'] ?? '未同步' }}</td>
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
          <td :colspan="columns.length + 4" class="empty-state">暂无RPA流程数据，可先登记自动化流程</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条RPA流程记录</span>
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
  applyBatchSyncToRows,
  listRpaBatches,
  syncBatch,
} from '@/api/orchestration-service'
import type { BatchSync } from '@/api/orchestration-service'
import type { StepState } from '@/orchestrator/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('rpaflow')
const columns = ["流程编号", "目标页面", "操作序列", "等待条件", "超时秒数", "结果提取", "异常回滚", "执行批次"]
const actions = ["提交执行", "启动流程", "终止流程", "归档结果"]
const statuses = ["草稿", "待校验", "执行中", "已完成", "已失败"]
const stats = [{"label": "自动化流程总数", "value": 0}, {"label": "执行中流程", "value": 0}, {"label": "已完成流程", "value": 0}]

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

const batchIds = ref<string[]>([])
const activeBatchId = ref('')
const activeSync = ref<BatchSync | null>(null)
const syncMessage = ref('')

function stateLabel(state: StepState): string {
  return STATE_LABELS[state]
}

function waveStatusLabel(status: keyof typeof WAVE_LABELS): string {
  return WAVE_LABELS[status]
}

function reloadBatches() {
  batchIds.value = listRpaBatches()
  if (!batchIds.value.includes(activeBatchId.value)) {
    activeBatchId.value = batchIds.value[0] ?? ''
  }
  if (activeBatchId.value) {
    activeSync.value = syncBatch(activeBatchId.value)
  }
}

function onSync() {
  if (!activeBatchId.value) {
    return
  }
  applyBatchSyncToRows()
  activeSync.value = syncBatch(activeBatchId.value)
  syncMessage.value = `批次 ${activeBatchId.value} 已同步：阻塞节点与步骤运行结果已写入清单。`
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '自动化流程登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'RPA流程列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadBatches()
})
</script>
