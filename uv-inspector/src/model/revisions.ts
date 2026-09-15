import type { AnalysisResult, MeshData } from './types';

/**
 * 可审计的 UV 修订图谱（版本树）。
 *
 * 每个 Revision 是一个**不可变**版本节点：记录父版本、产生它的操作摘要、
 * 该版本的完整网格以及分析摘要。从任意历史节点恢复会创建一个以该节点为父的
 * 新节点（形成分支），绝不覆盖原分支。
 */

export type RevisionKind = 'import' | 'mirror' | 'fixflip' | 'xatlas' | 'restore' | 'initial';

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

export interface Revision {
  id: string;
  parentId: string | null;
  kind: RevisionKind;
  /** 人类可读的操作摘要，如 "镜像所选 UV 岛" */
  label: string;
  /** 创建时间（毫秒） */
  createdAt: number;
  /** 递增版本号（仅用于显示，不代表线性先后） */
  seq: number;
  /** 该版本的完整网格（不可变快照） */
  mesh: MeshData;
  /** 该版本的分析摘要（分析结果本身可由 mesh 重算，这里存摘要用于对比） */
  summary: RevisionSummary;
}

export interface RevisionGraph {
  /** id -> 节点 */
  revisions: Record<string, Revision>;
  /** 当前选定版本 id */
  headId: string;
  /** 已分配的最大 seq */
  nextSeq: number;
}

export type DiffStatus = 'added' | 'removed' | 'same' | 'changed';

/** 两个版本之间的翻转/岛/接缝差异。 */
export interface RevisionDiff {
  flipped: { before: number; after: number; delta: number };
  islands: { before: number; after: number; delta: number };
  seams: { before: number; after: number; delta: number };
  overlaps: { before: number; after: number; delta: number };
  degenerateUv: { before: number; after: number; delta: number };
  maxAngle: { before: number; after: number; delta: number };
  maxAreaLog: { before: number; after: number; delta: number };
  /** 翻转面 id 的集合变化 */
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

export function createGraph(root: Revision): RevisionGraph {
  return { revisions: { [root.id]: root }, headId: root.id, nextSeq: root.seq + 1 };
}

/**
 * 提交一个新版本。
 *
 * @param opts.dedupe 当为 true 且新网格与父版本 UV 完全等价（无实际 UV 变化）时，
 *   不创建节点，返回父节点。镜像/修正在"没有任何翻转/没有选中岛"等空操作时使用。
 * @returns 新图谱与被提交（或复用）的版本；若被去重则 created=false。
 */
export function commitRevision(
  graph: RevisionGraph,
  opts: {
    parentId: string;
    kind: RevisionKind;
    label: string;
    mesh: MeshData;
    summary: RevisionSummary;
    now?: number;
    idFactory?: () => string;
  },
): { graph: RevisionGraph; revision: Revision; created: boolean } {
  const parent = graph.revisions[opts.parentId];
  if (!parent) throw new Error(`commitRevision: 父版本 ${opts.parentId} 不存在`);

  // 去重：UV 数组逐元素相同且面引用不变 => 没有实际 UV 变化
  if (uvEquals(parent.mesh, opts.mesh)) {
    return { graph, revision: parent, created: false };
  }

  const rev: Revision = {
    id: opts.idFactory ? opts.idFactory() : crypto.randomUUID(),
    parentId: opts.parentId,
    kind: opts.kind,
    label: opts.label,
    createdAt: opts.now ?? Date.now(),
    seq: graph.nextSeq,
    mesh: opts.mesh,
    summary: opts.summary,
  };
  const next: RevisionGraph = {
    revisions: { ...graph.revisions, [rev.id]: rev },
    headId: rev.id,
    nextSeq: graph.nextSeq + 1,
  };
  return { graph: next, revision: rev, created: true };
}

/** 两个网格的 UV 状态是否逐位等价（位置/面相同前提下比较 UV 与面的 uv 引用）。 */
export function uvEquals(a: MeshData, b: MeshData): boolean {
  if (a.uvs.length !== b.uvs.length || a.faces.length !== b.faces.length) return false;
  for (let i = 0; i < a.uvs.length; i++) {
    if (a.uvs[i] !== b.uvs[i]) return false;
  }
  for (let f = 0; f < a.faces.length; f++) {
    const fa = a.faces[f];
    const fb = b.faces[f];
    if (
      fa.uv[0] !== fb.uv[0] || fa.uv[1] !== fb.uv[1] || fa.uv[2] !== fb.uv[2] ||
      fa.v[0] !== fb.v[0] || fa.v[1] !== fb.v[1] || fa.v[2] !== fb.v[2]
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 从历史节点恢复：以该节点为父创建一个 restore 节点（分支）。
 *
 * 注意：恢复节点的 mesh 与目标节点相同（语义就是"回到那个状态"），因此**不能**
 * 走 commitRevision 的 UV 去重——即使内容相同，也要建节点来记录 head 跳转并
 * 在图上形成可追溯的分支点。原分支与所有祖先保持不变、仍可达。
 * 若目标就是当前 head，则无需节点。
 */
export function restoreRevision(
  graph: RevisionGraph,
  targetId: string,
  mesh: MeshData,
  summary: RevisionSummary,
  label?: string,
  now?: number,
  idFactory?: () => string,
): { graph: RevisionGraph; revision: Revision; created: boolean } {
  const target = graph.revisions[targetId];
  if (!target) throw new Error(`restoreRevision: 版本 ${targetId} 不存在`);
  if (targetId === graph.headId) {
    return { graph, revision: target, created: false };
  }
  const rev: Revision = {
    id: idFactory ? idFactory() : crypto.randomUUID(),
    parentId: targetId,
    kind: 'restore',
    label: label ?? `恢复到 v${target.seq}（形成分支）`,
    createdAt: now ?? Date.now(),
    seq: graph.nextSeq,
    mesh,
    summary,
  };
  const next: RevisionGraph = {
    revisions: { ...graph.revisions, [rev.id]: rev },
    headId: rev.id,
    nextSeq: graph.nextSeq + 1,
  };
  return { graph: next, revision: rev, created: true };
}

/** 从某节点回溯到根的祖先链（含自身），seq 升序。 */
export function ancestorChain(graph: RevisionGraph, id: string): Revision[] {
  const chain: Revision[] = [];
  let cur: Revision | undefined = graph.revisions[id];
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? graph.revisions[cur.parentId] : undefined;
  }
  return chain.reverse();
}

/** 从 head 不可达的节点（草稿/被放弃的分支），用于 GC。 */
export function unreachableNodes(graph: RevisionGraph): string[] {
  const reachable = new Set<string>();
  // 所有"叶子"其实都应保留为可恢复点；这里"不可达"特指连任何 head/根链都不在、
  // 且没有子节点引用的孤儿。实际图谱中每个节点都从根可达（只追加），所以正常为空；
  // 半写入失败可能留下无父引用且非根的节点，这才是清理对象。
  // 根 = parentId 为 null 的节点集合；从所有根做可达性遍历。
  const roots = Object.values(graph.revisions).filter((r) => r.parentId === null);
  const stack = roots.map((r) => r.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const r of Object.values(graph.revisions)) {
      if (r.parentId === id) stack.push(r.id);
    }
  }
  return Object.keys(graph.revisions).filter((id) => !reachable.has(id));
}

/**
 * 删除一个不可达（孤儿草稿）节点。只允许删除 unreachableNodes 集合中的节点；
 * 拒绝删除任何仍可达的版本，避免破坏历史。
 */
export function deleteUnreachable(graph: RevisionGraph, id: string): RevisionGraph {
  if (!unreachableNodes(graph).includes(id)) {
    throw new Error(`deleteUnreachable: 版本 ${id} 仍可达，拒绝删除`);
  }
  const revisions = { ...graph.revisions };
  delete revisions[id];
  return { ...graph, revisions };
}

/** 计算两个版本的差异。 */
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
