/**
 * 编排运行态持久化：每张依赖图一条记录，按 graphId 分别存储，互不覆盖。
 * 与业务数据的 localStorage 键分开，重置业务清单不会抹掉执行波次记录。
 */
import type { RunState } from './types'

const STORAGE_KEY = 'scraper-config-studio:orchestration-runs'

type RunMap = Record<string, RunState>

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function readAll(): RunMap {
  if (!canUseStorage()) {
    return {}
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as RunMap
  } catch {
    return {}
  }
}

function writeAll(map: RunMap): void {
  if (!canUseStorage()) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

const memoryFallback: RunMap = {}

export function loadRunState(graphId: string): RunState | null {
  const map = canUseStorage() ? readAll() : memoryFallback
  return map[graphId] ? (JSON.parse(JSON.stringify(map[graphId])) as RunState) : null
}

export function saveRunState(state: RunState): RunState {
  const map = canUseStorage() ? readAll() : memoryFallback
  map[state.graphId] = JSON.parse(JSON.stringify(state)) as RunState
  writeAll(map)
  return state
}

export function listRunStates(): RunState[] {
  const map = canUseStorage() ? readAll() : memoryFallback
  return Object.values(map).map((item) => JSON.parse(JSON.stringify(item)) as RunState)
}

export function removeRunState(graphId: string): void {
  const map = canUseStorage() ? readAll() : memoryFallback
  delete map[graphId]
  writeAll(map)
}

export function runStorageKey(): string {
  return STORAGE_KEY
}
