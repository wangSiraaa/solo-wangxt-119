import type { AnalysisResult, MeshData } from './types';

/**
 * 可审计的 UV 修订图谱：版本树 + 命名分支 + 三方合并。
 *
 * 每个 Revision 不可变，记录父版本、操作、网格与分析摘要。普通提交只有一个父；
 * 合并提交有两个父（目标头 + 提案头）并附 MergeCommitInfo。
 */

export type RevisionKind =
  | 'import'
  | 'mirror'
  | 'fixflip'
  | 'xatlas'
  | 'restore'
  | 'proposal'
  | 'merge'
  | 'initial';

export type ResolutionKind = 'proposal' | 'target' | 'manual';

export interface RevisionSummary {
  faceCount: number;
  positionCount: number;
  uvVertexCount: number;
  islandCount: number;
  flipped: number;
  degenerate3d: number;
  degenerateUv: number;
  seamEdgeCount: number;
  nonManifoldEdgeCount: number;
  overlappingFaces: number;
  maxAngleDistortion: number;
  meanAngleDistortion: number;
  maxAreaRatioLog: number;
}

export interface MergeCommitInfo {
  baseId: string;
  proposalId: string;
  targetId: string;
  proposalBranchId: string;
  targetBranchId: string;
  /** 冲突 id -> 决议类型 */
  resolutions: Record<string, ResolutionKind>;
  autoFaceCount: number;
  conflictCount: number;
}

export interface Revision {
  id: string;
  parentId: string | null;
  kind: RevisionKind;
  label: string;
  createdAt: number;
  seq: number;
  mesh: MeshData;
  summary: RevisionSummary;
  /** 所属分支 id（旧图节点缺失时由 ensureBranches 归入 main） */
  branchId?: string;
  /** 合并提交的第二父（提案侧） */
  secondParentId?: string | null;
  mergeInfo?: MergeCommitInfo;
}

export interface Branch {
  id: string;
  name: string;
  headId: string;
  /** 提案分支的切出点（共同祖先候选）；main 为 null */
  forkPointId: string | null;
  createdAt: number;
  sourceBranchId?: string;
  merged?: boolean;
}

export interface ConflictSnap {
  uvIds: [number, number, number];
  coords: Array<[number, number]>;
}

export interface MergeConflict {
  id: string;
  faceIds: number[];
  reason: 'same-face-changed' | 'shared-uv-vertex';
  base: ConflictSnap;
  proposal: ConflictSnap;
  target: ConflictSnap;
  /** 当前决议；null = 未决 */
  resolution: ResolutionKind | null;
  /** manual 决议的角点 UV 坐标（3 个） */
  manual?: Array<[number, number]> | null;
}

export interface MergeDraft {
  id: string;
  createdAt: number;
  updatedAt: number;
  baseId: string;
  proposalId: string;
  targetId: string;
  proposalBranchId: string;
  targetBranchId: string;
  /** 自动合并成功的面 id（三方互不冲突） */
  autoFaces: number[];
  /** 待决议冲突 */
  conflicts: MergeConflict[];
  /** 用于提交的标签 */
  label: string;
}

export interface RevisionGraph {
  revisions: Record<string, Revision>;
  /** 主工作分支当前 head（= branches[currentBranchId].headId） */
  headId: string;
  nextSeq: number;
  branches: Record<string, Branch>;
  currentBranchId: string;
  mainBranchId: string;
  pendingMerge: MergeDraft | null;
  /** 乐观并发标签，每次写入递增 */
  etag: number;
}

export const MAIN_BRANCH = 'main';

export interface RevisionDiff {
  flipped: { before: number; after: number; delta: number };
  islands: { before: number; after: number; delta: number };
  seams: { before: number; after: number; delta: number };
  overlaps: { before: number; after: number; delta: number };
  degenerateUv: { before: number; after: number; delta: number };
  maxAngle: { before: number; after: number; delta: number };
  maxAreaLog: { before: number; after: number; delta: number };
  flippedFaceIds: { added: number[]; removed: number[] };
}

export function makeSummary(mesh: MeshData, analysis: AnalysisResult): RevisionSummary {
  const s = analysis.summary;
  return {
    faceCount: s.faceCount,
    positionCount: mesh.positions.length / 3,
    uvVertexCount: mesh.uvs.length / 2,
    islandCount: s.islandCount,
    flipped: s.flipped,
    degenerate3d: s.degenerate3d,
    degenerateUv: s.degenerateUv,
    seamEdgeCount: s.seamEdgeCount,
    nonManifoldEdgeCount: s.nonManifoldEdgeCount,
    overlappingFaces: s.overlappingFaces,
    maxAngleDistortion: s.maxAngleDistortion,
    meanAngleDistortion: s.meanAngleDistortion,
    maxAreaRatioLog: s.maxAreaRatioLog,
  };
}

function defaultRootFields(root: Revision) {
  return {
    revisions: { [root.id]: root },
    headId: root.id,
    nextSeq: root.seq + 1,
    branches: {
      [MAIN_BRANCH]: {
        id: MAIN_BRANCH,
        name: 'main',
        headId: root.id,
        forkPointId: null,
        createdAt: root.createdAt,
      },
    } as Record<string, Branch>,
    currentBranchId: MAIN_BRANCH,
    mainBranchId: MAIN_BRANCH,
    pendingMerge: null,
    etag: 1,
  };
}

/** 新图（导入根版本）。 */
export function createGraph(root: Revision): RevisionGraph {
  const rooted: Revision = { ...root, branchId: root.branchId ?? MAIN_BRANCH, secondParentId: null };
  return defaultRootFields(rooted) as RevisionGraph;
}

/** 兼容旧图（无 branches）：惰性迁移为单 main 分支，所有节点归 main。 */
export function ensureBranches(graph: RevisionGraph): RevisionGraph {
  if (graph.branches && graph.currentBranchId) return graph;
  const root = Object.values(graph.revisions).find((r) => r.parentId === null) ??
    Object.values(graph.revisions)[0];
  const revisions: Record<string, Revision> = {};
  for (const r of Object.values(graph.revisions)) {
    revisions[r.id] = r.branchId ? r : { ...r, branchId: MAIN_BRANCH };
  }
  return {
    ...graph,
    revisions,
    branches: {
      [MAIN_BRANCH]: {
        id: MAIN_BRANCH,
        name: 'main',
        headId: graph.headId,
        forkPointId: root ? root.id : null,
        createdAt: root?.createdAt ?? Date.now(),
      },
    },
    currentBranchId: MAIN_BRANCH,
    mainBranchId: MAIN_BRANCH,
    pendingMerge: graph.pendingMerge ?? null,
    etag: graph.etag ?? 1,
  };
}

export function uvEquals(a: MeshData, b: MeshData): boolean {
  if (a.uvs.length !== b.uvs.length || a.faces.length !== b.faces.length) return false;
  for (let i = 0; i < a.uvs.length; i++) if (a.uvs[i] !== b.uvs[i]) return false;
  for (let f = 0; f < a.faces.length; f++) {
    const fa = a.faces[f];
    const fb = b.faces[f];
    if (
      fa.uv[0] !== fb.uv[0] || fa.uv[1] !== fb.uv[1] || fa.uv[2] !== fb.uv[2] ||
      fa.v[0] !== fb.v[0] || fa.v[1] !== fb.v[1] || fa.v[2] !== fb.v[2]
    ) return false;
  }
  return true;
}

/**
 * 在指定分支头上提交新版本。
 * - dedupe：与父 UV 等价时不建节点。
 * - 分支指针与 head 原子更新（同一不可变图对象）。
 */
export function commitRevision(
  graphIn: RevisionGraph,
  opts: {
    parentId: string;
    kind: RevisionKind;
    label: string;
    mesh: MeshData;
    summary: RevisionSummary;
    branchId?: string;
    now?: number;
    idFactory?: () => string;
  },
): { graph: RevisionGraph; revision: Revision; created: boolean } {
  const graph = ensureBranches(graphIn);
  const parent = graph.revisions[opts.parentId];
  if (!parent) throw new Error(`commitRevision: 父版本 ${opts.parentId} 不存在`);

  if (uvEquals(parent.mesh, opts.mesh)) {
    return { graph, revision: parent, created: false };
  }

  const branchId = opts.branchId ?? (parent.branchId || MAIN_BRANCH);
  const rev: Revision = {
    id: opts.idFactory ? opts.idFactory() : crypto.randomUUID(),
    parentId: opts.parentId,
    kind: opts.kind,
    label: opts.label,
    createdAt: opts.now ?? Date.now(),
    seq: graph.nextSeq,
    mesh: opts.mesh,
    summary: opts.summary,
    branchId,
    secondParentId: null,
  };
  const branches = { ...graph.branches };
  if (branches[branchId]) {
    branches[branchId] = { ...branches[branchId], headId: rev.id };
  }
  const onCurrent = graph.currentBranchId === branchId;
  const next: RevisionGraph = {
    ...graph,
    revisions: { ...graph.revisions, [rev.id]: rev },
    headId: onCurrent ? rev.id : graph.headId,
    nextSeq: graph.nextSeq + 1,
    branches,
    etag: graph.etag + 1,
  };
  return { graph: next, revision: rev, created: true };
}

/**
 * 从历史节点恢复：即使 UV 与目标相同也建 restore 节点（记录 head 跳转/分支点）。
 */
export function restoreRevision(
  graphIn: RevisionGraph,
  targetId: string,
  mesh: MeshData,
  summary: RevisionSummary,
  label?: string,
  now?: number,
  idFactory?: () => string,
): { graph: RevisionGraph; revision: Revision; created: boolean } {
  const graph = ensureBranches(graphIn);
  const target = graph.revisions[targetId];
  if (!target) throw new Error(`restoreRevision: 版本 ${targetId} 不存在`);
  const branchId = graph.currentBranchId;
  const currentBranch = graph.branches[branchId];
  if (targetId === currentBranch.headId) {
    return { graph, revision: target, created: false };
  }
  // 恢复到祖先意味着在该点分叉：保留原分支指针，并自动创建一个新的命名分支，
  // restore 节点落在新分支上，原 head 仍可达（不被覆盖）。
  const newBranchId = idFactory ? `branch-${idFactory()}` : crypto.randomUUID();
  const newBranch: Branch = {
    id: newBranchId,
    name: `恢复-v${target.seq}`,
    headId: '', // 下面用 restore 节点填充
    forkPointId: targetId,
    createdAt: now ?? Date.now(),
    sourceBranchId: branchId,
  };
  const rev: Revision = {
    id: idFactory ? idFactory() : crypto.randomUUID(),
    parentId: targetId,
    kind: 'restore',
    label: label ?? `恢复到 v${target.seq}（形成分支）`,
    createdAt: now ?? Date.now(),
    seq: graph.nextSeq,
    mesh,
    summary,
    branchId: newBranchId,
    secondParentId: null,
  };
  newBranch.headId = rev.id;
  const branches = { ...graph.branches, [newBranchId]: newBranch };
  const next: RevisionGraph = {
    ...graph,
    revisions: { ...graph.revisions, [rev.id]: rev },
    headId: rev.id,
    currentBranchId: newBranchId,
    nextSeq: graph.nextSeq + 1,
    branches,
    etag: graph.etag + 1,
  };
  return { graph: next, revision: rev, created: true };
}

export function ancestorChain(graphIn: RevisionGraph, id: string): Revision[] {
  const graph = ensureBranches(graphIn);
  const chain: Revision[] = [];
  let cur: Revision | undefined = graph.revisions[id];
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.push(cur);
    // 合并节点沿第一父回溯（目标侧）
    cur = cur.parentId ? graph.revisions[cur.parentId] : undefined;
  }
  return chain.reverse();
}

/** 两个版本的最近共同祖先（沿第一父，考虑合并节点的第二父）。 */
export function mergeBase(graphIn: RevisionGraph, aId: string, bId: string): Revision | null {
  const graph = ensureBranches(graphIn);
  const ancestorsOf = (id: string): Set<string> => {
    const set = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const x = stack.pop()!;
      if (set.has(x)) continue;
      set.add(x);
      const r = graph.revisions[x];
      if (!r) continue;
      if (r.parentId) stack.push(r.parentId);
      if (r.secondParentId) stack.push(r.secondParentId);
    }
    return set;
  };
  const ancA = ancestorsOf(aId);
  const seen = new Set<string>();
  const stack = [bId];
  let best: Revision | null = null;
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    if (ancA.has(x)) {
      const r = graph.revisions[x];
      if (!best || r.seq > best.seq) best = r;
    }
    const r = graph.revisions[x];
    if (!r) continue;
    if (r.parentId) stack.push(r.parentId);
    if (r.secondParentId) stack.push(r.secondParentId);
  }
  return best;
}

export function unreachableNodes(graphIn: RevisionGraph): string[] {
  const graph = ensureBranches(graphIn);
  const reachable = new Set<string>();
  // 所有分支头 + 合并草稿引用都作为种子（草稿引用的版本必须保留）
  const roots = new Set<string>();
  for (const b of Object.values(graph.branches)) roots.add(b.headId);
  if (graph.pendingMerge) {
    roots.add(graph.pendingMerge.baseId);
    roots.add(graph.pendingMerge.proposalId);
    roots.add(graph.pendingMerge.targetId);
  }
  // 子邻接（父 id -> 子节点），用于从祖先向下展开
  const children = new Map<string, string[]>();
  for (const r of Object.values(graph.revisions)) {
    for (const pid of [r.parentId, r.secondParentId].filter((x): x is string => !!x)) {
      const arr = children.get(pid) ?? [];
      arr.push(r.id);
      children.set(pid, arr);
    }
  }
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    // 向祖先（历史）与后代（分支）两个方向展开
    const r = graph.revisions[id];
    if (r?.parentId) stack.push(r.parentId);
    if (r?.secondParentId) stack.push(r.secondParentId);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return Object.keys(graph.revisions).filter((id) => !reachable.has(id));
}

export function deleteUnreachable(graphIn: RevisionGraph, id: string): RevisionGraph {
  const graph = ensureBranches(graphIn);
  if (!unreachableNodes(graph).includes(id)) {
    throw new Error(`deleteUnreachable: 版本 ${id} 仍可达，拒绝删除`);
  }
  const revisions = { ...graph.revisions };
  delete revisions[id];
  return { ...graph, revisions, etag: graph.etag + 1 };
}

export function diffRevisions(
  before: Revision,
  after: Revision,
  beforeFlippedFaceIds?: Set<number>,
  afterFlippedFaceIds?: Set<number>,
): RevisionDiff {
  const d = (x: number, y: number) => y - x;
  const added: number[] = [];
  const removed: number[] = [];
  if (beforeFlippedFaceIds && afterFlippedFaceIds) {
    for (const id of afterFlippedFaceIds) if (!beforeFlippedFaceIds.has(id)) added.push(id);
    for (const id of beforeFlippedFaceIds) if (!afterFlippedFaceIds.has(id)) removed.push(id);
    added.sort((a, b) => a - b);
    removed.sort((a, b) => a - b);
  }
  const A = before.summary;
  const B = after.summary;
  return {
    flipped: { before: A.flipped, after: B.flipped, delta: d(A.flipped, B.flipped) },
    islands: { before: A.islandCount, after: B.islandCount, delta: d(A.islandCount, B.islandCount) },
    seams: { before: A.seamEdgeCount, after: B.seamEdgeCount, delta: d(A.seamEdgeCount, B.seamEdgeCount) },
    overlaps: { before: A.overlappingFaces, after: B.overlappingFaces, delta: d(A.overlappingFaces, B.overlappingFaces) },
    degenerateUv: { before: A.degenerateUv, after: B.degenerateUv, delta: d(A.degenerateUv, B.degenerateUv) },
    maxAngle: { before: A.maxAngleDistortion, after: B.maxAngleDistortion, delta: d(A.maxAngleDistortion, B.maxAngleDistortion) },
    maxAreaLog: { before: A.maxAreaRatioLog, after: B.maxAreaRatioLog, delta: d(A.maxAreaRatioLog, B.maxAreaRatioLog) },
    flippedFaceIds: { added, removed },
  };
}
