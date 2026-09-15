import { useSyncExternalStore } from 'react';
import type { AnalysisResult, MeshData, Selection } from '../model/types';
import { analyzeMesh } from '../analysis/analyze';
import { ensurePerCornerUVs } from '../model/uvfix';
import { mirrorIslandsU } from '../model/uvedit';
import type { HeatMode } from '../three/ThreeView3D';

export interface AppState {
  mesh: MeshData | null;
  analysis: AnalysisResult | null;
  selection: Selection;
  heat: HeatMode;
  checker: boolean;
  projectId: string;
  projectName: string;
  dirty: boolean;
  busy: string | null;
  notice: { kind: 'info' | 'error'; text: string } | null;
}

type Listener = () => void;

let state: AppState = {
  mesh: null,
  analysis: null,
  selection: new Set(),
  heat: 'none',
  checker: true,
  projectId: crypto.randomUUID(),
  projectName: 'untitled',
  dirty: false,
  busy: null,
  notice: null,
};

const listeners = new Set<Listener>();

function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot(): AppState {
  return state;
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------- actions

export function loadMesh(mesh: MeshData, name?: string): void {
  const prepared = ensurePerCornerUVs(mesh);
  const analysis = analyzeMesh(prepared);
  setState({
    mesh: prepared,
    analysis,
    selection: new Set(),
    projectName: name ?? prepared.name,
    dirty: true,
    notice: null,
  });
}

/** 仅替换网格（UV 编辑、xatlas 展开后），重新分析并保留可对应的选择。 */
export function replaceMesh(next: MeshData, noticeText?: string, noticeKind: 'info' | 'error' = 'info'): void {
  const prepared = ensurePerCornerUVs(next);
  const analysis = analyzeMesh(prepared);
  // 面身份按索引对应；裁剪超出范围的选择
  const prevSel = state.selection;
  const selection = new Set<number>();
  for (const id of prevSel) if (id < prepared.faces.length) selection.add(id);
  setState({
    mesh: prepared,
    analysis,
    selection,
    dirty: true,
    notice: noticeText ? { kind: noticeKind, text: noticeText } : state.notice,
  });
}

export function pick(faceIds: number[], additive: boolean): void {
  if (faceIds.length === 0) {
    if (!additive && state.selection.size > 0) setState({ selection: new Set() });
    return;
  }
  if (!additive) {
    setState({ selection: new Set(faceIds) });
    return;
  }
  const next = new Set(state.selection);
  for (const id of faceIds) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
  }
  setState({ selection: next });
}

export function selectFaces(ids: Iterable<number>, additive = false): void {
  const next = additive ? new Set(state.selection) : new Set<number>();
  for (const id of ids) next.add(id);
  setState({ selection: next });
}

export function clearSelection(): void {
  setState({ selection: new Set() });
}

export function setHeat(heat: HeatMode): void {
  setState({ heat });
}

export function setChecker(on: boolean): void {
  setState({ checker: on });
}

export function setBusy(busy: string | null): void {
  setState({ busy });
}

export function notify(kind: 'info' | 'error', text: string): void {
  setState({ notice: { kind, text } });
}

export function clearNotice(): void {
  if (state.notice) setState({ notice: null });
}

export function markSaved(projectId: string, projectName: string): void {
  setState({ projectId, projectName, dirty: false });
}

export function setProjectName(name: string): void {
  setState({ projectName: name, dirty: true });
}

/** 调试用：按 id 选择岛包含的面。 */
export function selectIslandFaces(faces: number[]): void {
  setState({ selection: new Set(faces) });
}

/**
 * 自动修正所有"主流绕序相反"的 UV 岛：对每个 mirrored 岛沿其自身 U 中线镜像。
 * 返回修正的岛数。身份（位置/UV/面 id）全部保留。
 */
export function fixAllFlippedIslands(): number {
  if (!state.mesh || !state.analysis) return 0;
  const flippedIslands = state.analysis.islands.filter((isl) => isl.mirrored);
  if (flippedIslands.length === 0) return 0;
  // 累积变换：对每个翻转岛，以其全部面为种子做一次镜像
  let next = state.mesh;
  for (const isl of flippedIslands) {
    next = mirrorIslandsU(next, isl.faces);
  }
  const prepared = ensurePerCornerUVs(next);
  const analysis = analyzeMesh(prepared);
  setState({
    mesh: prepared,
    analysis,
    dirty: true,
    notice: { kind: 'info', text: `已镜像修正 ${flippedIslands.length} 个翻转岛` },
  });
  return flippedIslands.length;
}
