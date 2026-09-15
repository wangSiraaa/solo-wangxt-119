import { useSyncExternalStore } from 'react';
import type { AnalysisResult, MeshData, Selection } from '../model/types';
import { analyzeMesh } from '../analysis/analyze';
import { ensurePerCornerUVs } from '../model/uvfix';
import type { HeatMode } from '../three/ThreeView3D';
import {
  ancestorChain,
  commitRevision,
  createGraph,
  deleteUnreachable,
  diffRevisions,
  makeSummary,
  restoreRevision,
  unreachableNodes,
  uvEquals,
  type Revision,
  type RevisionDiff,
  type RevisionGraph,
  type RevisionKind,
  type RevisionSummary,
} from '../model/revisions';
import * as storage from '../io/storage';
import { mirrorIslandsU } from '../model/uvedit';

export interface AppState {
  graph: RevisionGraph | null;
  headId: string | null;
  /** 预览版本（不移动 head）；null 表示查看当前 head */
  previewId: string | null;
  mesh: MeshData | null;
  analysis: AnalysisResult | null;
  selection: Selection;
  heat: HeatMode;
  checker: boolean;
  projectId: string;
  projectName: string;
  /** 自上次成功持久化后是否有未保存修订 */
  dirty: boolean;
  saveState: 'idle' | 'saving' | 'error';
  lastSavedAt: number | null;
  busy: string | null;
  notice: { kind: 'info' | 'error'; text: string } | null;
}

type Listener = () => void;

function freshProjectId(): string {
  return crypto.randomUUID();
}

function rootRevision(mesh: MeshData, analysis: AnalysisResult, label: string, now = Date.now()): Revision {
  return {
    id: crypto.randomUUID(),
    parentId: null,
    kind: 'import',
    label,
    createdAt: now,
    seq: 0,
    mesh,
    summary: makeSummary(mesh, analysis),
  };
}

let state: AppState = {
  graph: null,
  headId: null,
  previewId: null,
  mesh: null,
  analysis: null,
  selection: new Set(),
  heat: 'none',
  checker: true,
  projectId: freshProjectId(),
  projectName: 'untitled',
  dirty: false,
  saveState: 'idle',
  lastSavedAt: null,
  busy: null,
  notice: null,
};

const listeners = new Set<Listener>();

function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: Listener): () => boolean {
  listeners.add(l);
  return () => listeners.delete(l);
}

const getSnapshot = (): AppState => state;

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// 分析结果缓存：按 revision.id 惰性重算（修订不可变，缓存可安全复用）
const analysisCache = new Map<string, AnalysisResult>();
export function analysisFor(rev: Revision): AnalysisResult {
  let a = analysisCache.get(rev.id);
  if (!a) {
    a = analyzeMesh(rev.mesh);
    analysisCache.set(rev.id, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// 持久化（异步、整图原子写；失败只标记、绝不回滚内存图谱）
// ---------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveSeq = 0;

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persistNow();
  }, 400);
}

/** 立即持久化当前图谱。返回是否成功。乱序调用以最新一次为准。 */
export async function persistNow(): Promise<boolean> {
  if (!state.graph || !state.headId) return true;
  const mySeq = ++saveSeq;
  setState({ saveState: 'saving' });
  const graph = state.graph;
  const projectId = state.projectId;
  const name = state.projectName;
  try {
    await storage.saveProjectGraph(projectId, name, graph);
    storage.rememberLastProjectId(projectId);
    // 乱序完成的旧保存不覆盖更新的状态
    if (mySeq !== saveSeq) return true;
    setState({ dirty: false, saveState: 'idle', lastSavedAt: Date.now() });
    return true;
  } catch (e) {
    if (mySeq === saveSeq) {
      // 已提交的版本全部保留在内存中；下次保存整图重放，不丢失任何版本
      setState({ saveState: 'error' });
      notify('error', `自动保存失败（修订已保留在本会话，稍后可重试）：${(e as Error).message}`);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// 载入 / 提交
// ---------------------------------------------------------------------------

function adoptGraph(
  graph: RevisionGraph,
  projectId: string,
  projectName: string,
  opts: { dirty: boolean; savedAt: number | null },
): void {
  const head = graph.revisions[graph.headId];
  const analysis = analysisFor(head);
  analysisCache.clear();
  analysisCache.set(head.id, analysis);
  setState({
    graph,
    headId: graph.headId,
    previewId: null,
    mesh: head.mesh,
    analysis,
    selection: new Set(),
    projectId,
    projectName,
    dirty: opts.dirty,
    saveState: opts.dirty ? 'idle' : 'idle',
    lastSavedAt: opts.savedAt,
  });
}

/** 载入 OBJ：开启一条新的修订谱系（新工程根）。 */
export function loadMesh(mesh: MeshData, name?: string): void {
  const prepared = ensurePerCornerUVs(mesh);
  const analysis = analyzeMesh(prepared);
  const root = rootRevision(prepared, analysis, `导入 ${prepared.name}`);
  const graph = createGraph(root);
  analysisCache.clear();
  analysisCache.set(root.id, analysis);
  setState({
    graph,
    headId: root.id,
    previewId: null,
    mesh: prepared,
    analysis,
    selection: new Set(),
    projectId: freshProjectId(),
    projectName: name ?? prepared.name,
    dirty: true,
    saveState: 'idle',
    lastSavedAt: null,
  });
}

/**
 * 原子地在当前 head 上提交一次 UV 编辑。
 * - edit 返回 null，或结果与父版本 UV 等价（去重）时，不产生节点、状态不变。
 * - 节点创建是同步的：连续/重复点击只按"实际变化"追加，不会出现重复或错链。
 * - 图、head、mesh、analysis、selection、dirty 在一次 setState 中原子切换。
 */
function commitEdit(
  kind: RevisionKind,
  label: string,
  edit: (mesh: MeshData) => MeshData | null,
): Revision | null {
  if (!state.graph || !state.headId || state.previewId) return null;
  const graph = state.graph;
  const parent = graph.revisions[state.headId];
  const nextRaw = edit(parent.mesh);
  if (!nextRaw) return null;
  const next = ensurePerCornerUVs(nextRaw);
  if (uvEquals(parent.mesh, next)) return null; // 无实际 UV 变化 -> 等价节点去重

  const analysis = analyzeMesh(next);
  const summary = makeSummary(next, analysis);
  const { graph: g2, revision, created } = commitRevision(graph, {
    parentId: parent.id,
    kind,
    label,
    mesh: next,
    summary,
  });
  if (!created) return null;
  analysisCache.set(revision.id, analysis);

  const prevSel = state.selection;
  const selection = new Set<number>();
  for (const id of prevSel) if (id < next.faces.length) selection.add(id);

  setState({
    graph: g2,
    headId: g2.headId,
    previewId: null,
    mesh: next,
    analysis,
    selection,
    dirty: true,
  });
  scheduleSave();
  return revision;
}

/** 外部（xatlas）已算好新网格时提交；同样走去重与原子切换。 */
export function commitExternalMesh(kind: RevisionKind, label: string, next: MeshData): Revision | null {
  return commitEdit(kind, label, () => next);
}

/** 镜像所选 UV 岛。无选择或无变化时不产生版本。 */
export function mirrorSelected(): boolean {
  if (!state.graph || !state.headId || state.previewId) return false;
  if (state.selection.size === 0) return false;
  const head = state.graph.revisions[state.headId];
  const next = mirrorIslandsU(head.mesh, state.selection);
  return commitEdit('mirror', '镜像所选 UV 岛', () => next) !== null;
}

/** 修正所有翻转岛。没有翻转或镜像后无实际变化（去重）则不产生版本；返回修正岛数。 */
export function fixAllFlippedIslands(): number {
  if (!state.graph || !state.headId || state.previewId) return 0;
  const head = state.graph.revisions[state.headId];
  const analysis = analysisFor(head);
  const flippedIslands = analysis.islands.filter((isl) => isl.mirrored);
  if (flippedIslands.length === 0) return 0;
  let next = head.mesh;
  for (const isl of flippedIslands) next = mirrorIslandsU(next, isl.faces);
  const rev = commitEdit('fixflip', `修正 ${flippedIslands.length} 个翻转 UV 岛`, () => next);
  return rev ? flippedIslands.length : 0;
}

// ---------------------------------------------------------------------------
// 历史：预览 / 比较 / 恢复 / GC
// ---------------------------------------------------------------------------

export function previewRevision(id: string | null): void {
  if (!state.graph) return;
  if (id === null) {
    const head = state.graph.revisions[state.headId!];
    setState({ previewId: null, mesh: head.mesh, analysis: analysisFor(head) });
    return;
  }
  const rev = state.graph.revisions[id];
  if (!rev) return;
  setState({ previewId: id, mesh: rev.mesh, analysis: analysisFor(rev), selection: new Set() });
}

export function diffTwoRevisions(aId: string, bId: string): RevisionDiff | null {
  if (!state.graph) return null;
  const a = state.graph.revisions[aId];
  const b = state.graph.revisions[bId];
  if (!a || !b) return null;
  const fa = new Set(analysisFor(a).faces.filter((f) => f.flipped).map((f) => f.faceId));
  const fb = new Set(analysisFor(b).faces.filter((f) => f.flipped).map((f) => f.faceId));
  return diffRevisions(a, b, fa, fb);
}

/**
 * 从任意历史节点恢复：以该节点为父创建一个 restore 子节点（形成分支），
 * 原分支与所有祖先保持不变、仍可达。目标即 head 时不产生节点。
 */
export function restoreToRevision(targetId: string): boolean {
  if (!state.graph || !state.headId) return false;
  const graph = state.graph;
  const target = graph.revisions[targetId];
  if (!target) return false;
  if (targetId === graph.headId) {
    previewRevision(null);
    return false;
  }
  const analysis = analysisFor(target);
  const { graph: g2, revision, created } = restoreRevision(
    graph,
    targetId,
    target.mesh,
    target.summary,
  );
  if (!created) return false;
  analysisCache.set(revision.id, analysis);
  setState({
    graph: g2,
    headId: g2.headId,
    previewId: null,
    mesh: revision.mesh,
    analysis,
    selection: new Set(),
    dirty: true,
  });
  scheduleSave();
  return true;
}

/** 删除不可达草稿节点（仅作用于图，并持久化）。可达版本一律拒绝删除。 */
export async function garbageCollectUnreachable(): Promise<string[]> {
  if (!state.graph) return [];
  let g = state.graph;
  const orphans = unreachableNodes(g);
  for (const id of orphans) g = deleteUnreachable(g, id);
  if (orphans.length) {
    setState({ graph: g });
    await persistNow();
  }
  return orphans;
}

export function getHistory(): {
  graph: RevisionGraph;
  headId: string;
  ancestors: Revision[];
  unreachable: string[];
} | null {
  if (!state.graph || !state.headId) return null;
  return {
    graph: state.graph,
    headId: state.headId,
    ancestors: ancestorChain(state.graph, state.graph.headId),
    unreachable: unreachableNodes(state.graph),
  };
}

// ---------------------------------------------------------------------------
// 工程：打开（含 v1 迁移）/ 删除
// ---------------------------------------------------------------------------

export async function openProject(id: string): Promise<boolean> {
  const rec = await storage.loadProject(id);
  if (!rec) return false;
  if (rec.version !== 2 || !rec.graph) {
    // 防御性 v1 迁移（正常在 onupgradeneeded 已完成）
    const migrated = await import('./migrate').then((m) => m.migrateV1Record(rec));
    if (!migrated) return false;
    adoptGraph(migrated.graph, id, migrated.name, { dirty: false, savedAt: rec.updatedAt });
    storage.rememberLastProjectId(id);
    return true;
  }
  adoptGraph(rec.graph, id, rec.name, { dirty: false, savedAt: rec.updatedAt });
  storage.rememberLastProjectId(id);
  return true;
}

/**
 * 刷新/重开后恢复最后一致状态：读取最近保存的工程。
 * 成功（即便图谱只有根版本）返回 true；无记录或读取失败返回 false（调用方回退到样例）。
 */
export async function restoreLastProject(): Promise<boolean> {
  const id = storage.getLastProjectId();
  if (!id) return false;
  try {
    return await openProject(id);
  } catch {
    return false;
  }
}

export async function listProjects() {
  return storage.listProjects();
}

export async function deleteProject(id: string): Promise<void> {
  await storage.deleteProject(id);
  if (storage.getLastProjectId() === id) storage.clearLastProjectId();
}

// ---------------------------------------------------------------------------
// 选择 / 视图
// ---------------------------------------------------------------------------

export function pick(faceIds: number[], additive: boolean): void {
  if (state.previewId) return; // 预览历史时不编辑选择
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

export function selectFaces(ids: Iterable<number>): void {
  if (state.previewId) return;
  setState({ selection: new Set(ids) });
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
export function setProjectName(name: string): void {
  setState({ projectName: name, dirty: true });
}
export function selectIslandFaces(faces: number[]): void {
  if (state.previewId) return;
  setState({ selection: new Set(faces) });
}

// 导出修订相关类型供 UI 使用
export type { Revision, RevisionSummary, RevisionKind };
