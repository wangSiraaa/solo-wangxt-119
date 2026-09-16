import type { MeshData } from './types';
import {
  MAIN_BRANCH,
  ancestorChain,
  commitRevision,
  ensureBranches,
  mergeBase,
  type Branch,
  type MergeConflict,
  type MergeDraft,
  type ResolutionKind,
  type Revision,
  type RevisionGraph,
  type RevisionKind,
  type RevisionSummary,
} from './revisions';

/**
 * 三方合并（base = 共同祖先 / 提案 fork 点；proposal / target）。
 *
 * 两层身份：
 *  - 坐标级编辑（镜像岛、修正翻转）：UV 数组长度与角点 UV id 不变，只改坐标。
 *  - 拓扑级编辑（xatlas）：重建 UV 数组与角点引用。
 * 合并按 face id 与角点 UV 身份区分自动合并 / 冲突。
 */

export interface CreateProposalOptions {
  name: string;
  forkRevisionId?: string; // 默认当前 head
  now?: number;
  idFactory?: () => string;
}

/** 从任意历史版本创建提案分支（不改当前 checkout，只新增分支指针与一个 fork 节点）。 */
export function createProposal(
  graphIn: RevisionGraph,
  opts: CreateProposalOptions,
): { graph: RevisionGraph; branch: Branch } {
  const graph = ensureBranches(graphIn);
  const forkId = opts.forkRevisionId ?? graph.headId;
  const fork = graph.revisions[forkId];
  if (!fork) throw new Error('createProposal: fork 版本不存在');

  const branchId = opts.idFactory ? opts.idFactory() : crypto.randomUUID();
  // fork 节点本身不复制；分支头直接指向 fork（后续编辑在其上提交）。
  const branch: Branch = {
    id: branchId,
    name: opts.name,
    headId: forkId,
    forkPointId: forkId,
    createdAt: opts.now ?? Date.now(),
    sourceBranchId: graph.currentBranchId,
  };
  const next: RevisionGraph = {
    ...graph,
    branches: { ...graph.branches, [branchId]: branch },
    etag: graph.etag + 1,
  };
  return { graph: next, branch };
}

/** checkout 某分支（视图/head 切到它；不产生节点）。 */
export function checkoutBranch(graphIn: RevisionGraph, branchId: string): RevisionGraph {
  const graph = ensureBranches(graphIn);
  if (!graph.branches[branchId]) throw new Error(`checkoutBranch: 分支 ${branchId} 不存在`);
  const b = graph.branches[branchId];
  return { ...graph, currentBranchId: branchId, headId: b.headId };
}

// ---------------------------------------------------------------------------
// 面快照与变化判定
// ---------------------------------------------------------------------------

interface FaceSnap {
  uvIds: [number, number, number];
  coords: Array<[number, number]>;
}

function faceSnap(mesh: MeshData, f: number): FaceSnap {
  const face = mesh.faces[f];
  const uvIds: [number, number, number] = [face.uv[0], face.uv[1], face.uv[2]];
  const coords = uvIds.map((u) => [mesh.uvs[u * 2], mesh.uvs[u * 2 + 1]] as [number, number]);
  return { uvIds, coords };
}

const COORD_EPS = 1e-9;
const sameSnap = (a: FaceSnap, b: FaceSnap): boolean => {
  if (a.uvIds[0] !== b.uvIds[0] || a.uvIds[1] !== b.uvIds[1] || a.uvIds[2] !== b.uvIds[2]) return false;
  for (let c = 0; c < 3; c++) {
    if (Math.abs(a.coords[c][0] - b.coords[c][0]) > COORD_EPS) return false;
    if (Math.abs(a.coords[c][1] - b.coords[c][1]) > COORD_EPS) return false;
  }
  return true;
};

/** 提案是否只改了 UV 坐标、保留了全部 UV id 布局（坐标级编辑）。 */
function isCoordinateLevel(base: Revision, side: Revision): boolean {
  if (base.mesh.uvs.length !== side.mesh.uvs.length) return false;
  if (base.mesh.faces.length !== side.mesh.faces.length) return false;
  for (let f = 0; f < base.mesh.faces.length; f++) {
    const a = base.mesh.faces[f].uv;
    const b = side.mesh.faces[f].uv;
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 计算合并草稿
// ---------------------------------------------------------------------------

export interface ComputeMergeOptions {
  baseId?: string; // 默认 mergeBase(proposal,target)
  now?: number;
  idFactory?: () => string;
}

export function computeMergeDraft(
  graphIn: RevisionGraph,
  proposalId: string,
  targetId: string,
  opts: ComputeMergeOptions = {},
): MergeDraft {
  const graph = ensureBranches(graphIn);
  const proposal = graph.revisions[proposalId];
  const target = graph.revisions[targetId];
  if (!proposal || !target) throw new Error('computeMergeDraft: 版本不存在');

  const baseRev = opts.baseId
    ? graph.revisions[opts.baseId]
    : mergeBase(graph, proposalId, targetId);
  if (!baseRev) throw new Error('computeMergeDraft: 找不到共同祖先');

  const proposalBranch = Object.values(graph.branches).find((b) => b.headId === proposalId) ??
    Object.values(graph.branches).find((b) => ancestorChain(graph, proposalId).some((r) => r.branchId === b.id));
  const targetBranch = Object.values(graph.branches).find((b) => b.headId === targetId) ??
    graph.branches[graph.currentBranchId];

  const n = Math.min(baseRev.mesh.faces.length, proposal.mesh.faces.length, target.mesh.faces.length);
  const changedByProposal = new Set<number>();
  const changedByTarget = new Set<number>();
  const pSnap = new Map<number, FaceSnap>();
  const tSnap = new Map<number, FaceSnap>();
  const bSnap = new Map<number, FaceSnap>();

  for (let f = 0; f < n; f++) {
    const bs = faceSnap(baseRev.mesh, f);
    const ps = faceSnap(proposal.mesh, f);
    const ts = faceSnap(target.mesh, f);
    bSnap.set(f, bs); pSnap.set(f, ps); tSnap.set(f, ts);
    if (!sameSnap(bs, ps)) changedByProposal.add(f);
    if (!sameSnap(bs, ts)) changedByTarget.add(f);
  }

  // 自动合并：仅一方相对 base 改动；两侧都改但结果完全一致也自动（取任一）
  const autoFaces: number[] = [];
  const conflictFaces = new Set<number>();
  for (let f = 0; f < n; f++) {
    const inP = changedByProposal.has(f);
    const inT = changedByTarget.has(f);
    if (inP && inT) {
      const ps = pSnap.get(f)!;
      const ts = tSnap.get(f)!;
      if (sameSnap(ps, ts)) autoFaces.push(f); // 相同改动：无冲突
      else conflictFaces.add(f); // 同面不同结果：冲突
    } else if (inP || inT) {
      autoFaces.push(f);
    }
  }

  // 第二层冲突：自动合并的提案改动面与**另一侧不同面**的目标改动面共享角点 UV 顶点，
  // 且该共享 UV 在两侧坐标都被改动（坐标级编辑）。两侧"同一面相同结果"已在上面归为自动。
  const propCoordLevel = isCoordinateLevel(baseRev, proposal);
  const tgtCoordLevel = isCoordinateLevel(baseRev, target);
  const related = new Map<number, Set<number>>();
  if (propCoordLevel && tgtCoordLevel) {
    // 仅一侧改动的面才参与跨面耦合；两侧相同结果的面不参与
    const onlyP = autoFaces.filter((f) => changedByProposal.has(f) && !changedByTarget.has(f));
    const onlyT = autoFaces.filter((f) => changedByTarget.has(f) && !changedByProposal.has(f));
    const uvToTargetFaces = new Map<number, number[]>();
    for (const f of onlyT) {
      for (const u of tSnap.get(f)!.uvIds) {
        const arr = uvToTargetFaces.get(u) ?? [];
        arr.push(f);
        uvToTargetFaces.set(u, arr);
      }
    }
    for (const f of onlyP) {
      const hit = new Set<number>();
      for (const u of pSnap.get(f)!.uvIds) {
        for (const tf of uvToTargetFaces.get(u) ?? []) {
          if (tf === f) continue;
          const baseUv = baseRev.mesh.uvs;
          const movedInP =
            Math.abs(proposal.mesh.uvs[u * 2] - baseUv[u * 2]) > COORD_EPS ||
            Math.abs(proposal.mesh.uvs[u * 2 + 1] - baseUv[u * 2 + 1]) > COORD_EPS;
          const movedInT =
            Math.abs(target.mesh.uvs[u * 2] - baseUv[u * 2]) > COORD_EPS ||
            Math.abs(target.mesh.uvs[u * 2 + 1] - baseUv[u * 2 + 1]) > COORD_EPS;
          if (movedInP && movedInT) hit.add(tf);
        }
      }
      if (hit.size) {
        conflictFaces.add(f);
        related.set(f, hit);
        autoFaces.splice(autoFaces.indexOf(f), 1);
        for (const tf of hit) {
          conflictFaces.add(tf);
          const idx = autoFaces.indexOf(tf);
          if (idx >= 0) autoFaces.splice(idx, 1);
        }
      }
    }
  }

  // 构造冲突对象（同面冲突把 related 合并）
  const conflicts: MergeConflict[] = [];
  const grouped = new Map<number, number[]>();
  for (const f of conflictFaces) {
    const group = new Set<number>([f, ...(related.get(f) ?? [])]);
    // 合并相互引用
    let merged = true;
    while (merged) {
      merged = false;
      for (const g of [...group]) {
        for (const h of related.get(g) ?? []) {
          if (!group.has(h)) { group.add(h); merged = true; }
        }
      }
    }
    const key = [...group].sort((a, b) => a - b)[0];
    const arr = grouped.get(key) ?? [];
    for (const g of group) if (!arr.includes(g)) arr.push(g);
    grouped.set(key, arr);
  }
  for (const [key, faceIds] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    const f0 = faceIds[0];
    const reason: MergeConflict['reason'] =
      changedByProposal.has(f0) && changedByTarget.has(f0) ? 'same-face-changed' : 'shared-uv-vertex';
    conflicts.push({
      id: `c${key}`,
      faceIds: faceIds.sort((a, b) => a - b),
      reason,
      base: snapToConflict(bSnap.get(f0)!),
      proposal: snapToConflict(pSnap.get(f0)!),
      target: snapToConflict(tSnap.get(f0)!),
      resolution: null,
      manual: null,
    });
  }

  return {
    id: opts.idFactory ? opts.idFactory() : crypto.randomUUID(),
    createdAt: opts.now ?? Date.now(),
    updatedAt: opts.now ?? Date.now(),
    baseId: baseRev.id,
    proposalId,
    targetId,
    proposalBranchId: proposalBranch?.id ?? '',
    targetBranchId: targetBranch?.id ?? MAIN_BRANCH,
    autoFaces: autoFaces.sort((a, b) => a - b),
    conflicts,
    label: `合并提案到 ${targetBranch?.name ?? '目标'}`,
  };
}

function snapToConflict(s: FaceSnap): { uvIds: [number, number, number]; coords: Array<[number, number]> } {
  return { uvIds: [...s.uvIds] as [number, number, number], coords: s.coords.map((c) => [...c] as [number, number]) };
}

// ---------------------------------------------------------------------------
// 决议与构建合并网格
// ---------------------------------------------------------------------------

export function resolveConflict(draft: MergeDraft, conflictId: string, resolution: ResolutionKind, manual?: Array<[number, number]>): MergeDraft {
  const conflicts = draft.conflicts.map((c) =>
    c.id === conflictId
      ? { ...c, resolution, manual: resolution === 'manual' ? manual ?? c.manual : null }
      : c,
  );
  return { ...draft, conflicts, updatedAt: Date.now() };
}

export function allResolved(draft: MergeDraft): boolean {
  return draft.conflicts.every((c) => c.resolution !== null);
}

/** 依据草稿构建合并后的网格。target 为结构基底；按来源拼装 UV。 */
export function buildMergedMesh(graphIn: RevisionGraph, draft: MergeDraft): MeshData {
  const graph = ensureBranches(graphIn);
  const base = graph.revisions[draft.baseId];
  const proposal = graph.revisions[draft.proposalId];
  const target = graph.revisions[draft.targetId];

  // 从 target 开始（深拷贝面与 UV）
  const uvs: number[] = Array.from(target.mesh.uvs);
  const faces = target.mesh.faces.map((f) => ({
    v: [...f.v] as [number, number, number],
    uv: [...f.uv] as [number, number, number],
    sourceFace: f.sourceFace,
  }));

  const changedP = new Set<number>();
  for (let f = 0; f < base.mesh.faces.length; f++) {
    if (!sameSnap(faceSnap(base.mesh, f), faceSnap(proposal.mesh, f))) changedP.add(f);
  }
  const changedT = new Set<number>();
  for (let f = 0; f < base.mesh.faces.length; f++) {
    if (!sameSnap(faceSnap(base.mesh, f), faceSnap(target.mesh, f))) changedT.add(f);
  }

  // 提案是否保持 UV id 布局（坐标级）。坐标级时直接把提案坐标写入相同 id
  // （这些 id 只会被提案改动面引用——冲突已在上游隔离）；拓扑级时追加新 UV。
  const coordLevel = isCoordinateLevel(base, proposal);
  const remap = new Map<number, number>();
  const mapProposalUv = (oldUv: number): number => {
    if (coordLevel) {
      if (oldUv * 2 + 1 < uvs.length) {
        uvs[oldUv * 2] = proposal.mesh.uvs[oldUv * 2];
        uvs[oldUv * 2 + 1] = proposal.mesh.uvs[oldUv * 2 + 1];
      }
      return oldUv;
    }
    if (remap.has(oldUv)) return remap.get(oldUv)!;
    const newId = uvs.length / 2;
    uvs.push(proposal.mesh.uvs[oldUv * 2], proposal.mesh.uvs[oldUv * 2 + 1]);
    remap.set(oldUv, newId);
    return newId;
  };

  // 无冲突且两侧都改但结果一致的面（相同改动），直接采用 target（与提案相同）。
  const conflictByFace = new Map<number, MergeConflict>();
  for (const c of draft.conflicts) for (const f of c.faceIds) conflictByFace.set(f, c);

  for (let f = 0; f < faces.length; f++) {
    const conflict = conflictByFace.get(f);
    if (conflict) {
      if (conflict.resolution === 'target' || conflict.resolution === null) continue;

      if (conflict.resolution === 'manual') {
        if (conflict.manual && f === conflict.faceIds[0]) {
          const ids = conflict.manual.map(([u, v]) => {
            const id = uvs.length / 2;
            uvs.push(u, v);
            return id;
          });
          faces[f].uv = [ids[0], ids[1], ids[2]];
        } else {
          const ps = faceSnap(proposal.mesh, f);
          faces[f].uv = ps.uvIds.map(mapProposalUv) as [number, number, number];
        }
        continue;
      }

      // proposal：冲突组每个面取自己在提案侧的 UV
      const ps = faceSnap(proposal.mesh, f);
      faces[f].uv = ps.uvIds.map(mapProposalUv) as [number, number, number];
      continue;
    }
    // 自动合并：仅提案改动 -> 写入提案坐标
    if (changedP.has(f) && !changedT.has(f)) {
      const ps = faceSnap(proposal.mesh, f);
      faces[f].uv = ps.uvIds.map(mapProposalUv) as [number, number, number];
    }
    // 仅 target 改动 / 两侧相同结果 -> 已在基底中
  }

  return {
    name: target.mesh.name,
    positions: target.mesh.positions,
    uvs: Float64Array.from(uvs),
    faces,
    groups: target.mesh.groups,
  };
}

// ---------------------------------------------------------------------------
// 写入草稿 / 提交合并
// ---------------------------------------------------------------------------

export function setPendingMerge(graphIn: RevisionGraph, draft: MergeDraft | null): RevisionGraph {
  const graph = ensureBranches(graphIn);
  return { ...graph, pendingMerge: draft, etag: graph.etag + 1 };
}

export interface CommitMergeOptions {
  now?: number;
  idFactory?: () => string;
  /** 合并提交落在哪个分支（默认 draft.targetBranchId） */
  destinationBranchId?: string;
  /** 是否同时把提案分支标记为已合并 */
  markProposalMerged?: boolean;
}

/** 原子地产生双亲合并提交，更新目标分支指针并清除草稿。 */
export function commitMerge(
  graphIn: RevisionGraph,
  draft: MergeDraft,
  mergedMesh: MeshData,
  summary: RevisionSummary,
  opts: CommitMergeOptions = {},
): { graph: RevisionGraph; revision: Revision } {
  const graph = ensureBranches(graphIn);
  if (!allResolved(draft)) throw new Error('commitMerge: 仍有未决议冲突');
  const targetBranchId = opts.destinationBranchId ?? draft.targetBranchId;
  const targetBranch = graph.branches[targetBranchId];
  if (!targetBranch) throw new Error('commitMerge: 目标分支不存在');

  const rev: Revision = {
    id: opts.idFactory ? opts.idFactory() : crypto.randomUUID(),
    parentId: draft.targetId, // 第一父：目标
    secondParentId: draft.proposalId, // 第二父：提案
    kind: 'merge',
    label: draft.label,
    createdAt: opts.now ?? Date.now(),
    seq: graph.nextSeq,
    mesh: mergedMesh,
    summary,
    branchId: targetBranchId,
    mergeInfo: {
      baseId: draft.baseId,
      proposalId: draft.proposalId,
      targetId: draft.targetId,
      proposalBranchId: draft.proposalBranchId,
      targetBranchId,
      resolutions: Object.fromEntries(
        draft.conflicts.map((c) => [c.id, c.resolution as ResolutionKind]),
      ),
      autoFaceCount: draft.autoFaces.length,
      conflictCount: draft.conflicts.length,
    },
  };

  const branches: Record<string, Branch> = {
    ...graph.branches,
    [targetBranchId]: { ...targetBranch, headId: rev.id },
  };
  if (opts.markProposalMerged !== false && branches[draft.proposalBranchId]) {
    branches[draft.proposalBranchId] = { ...branches[draft.proposalBranchId], merged: true };
  }

  const onCurrent = graph.currentBranchId === targetBranchId;
  const next: RevisionGraph = {
    ...graph,
    revisions: { ...graph.revisions, [rev.id]: rev },
    headId: onCurrent ? rev.id : graph.headId,
    currentBranchId: onCurrent ? graph.currentBranchId : graph.currentBranchId,
    nextSeq: graph.nextSeq + 1,
    branches,
    pendingMerge: null,
    etag: graph.etag + 1,
  };
  return { graph: next, revision: rev };
}

/** 在某提案分支上提交一次编辑（镜像/修正/xatlas）。 */
export function commitOnBranch(
  graphIn: RevisionGraph,
  branchId: string,
  kind: RevisionKind,
  label: string,
  mesh: MeshData,
  summary: RevisionSummary,
  opts: { now?: number; idFactory?: () => string } = {},
): { graph: RevisionGraph; revision: Revision; created: boolean } {
  const graph = ensureBranches(graphIn);
  const branch = graph.branches[branchId];
  if (!branch) throw new Error(`commitOnBranch: 分支 ${branchId} 不存在`);
  const res = commitRevision(graph, {
    parentId: branch.headId,
    kind,
    label,
    mesh,
    summary,
    branchId,
    now: opts.now,
    idFactory: opts.idFactory,
  });
  return res;
}
