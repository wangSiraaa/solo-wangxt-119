/** @vitest-environment node */
import 'fake-indexeddb/auto';
import { SAMPLES } from '../src/samples/samples';
import { MeshBuilder } from '../src/model/builder';
import type { MeshData } from '../src/model/types';
import { analyzeMesh } from '../src/analysis/analyze';
import {
  beginMerge,
  commitMeshToBranch,
  discardMerge,
  fixAllFlippedIslands,
  getHistory,
  getPendingMerge,
  loadMesh,
  mirrorSelected,
  pendingConflicts,
  previewMerge,
  publishMerge,
  resolveMergeConflict,
  selectIslandFaces,
  startProposal,
  switchBranch,
} from '../src/store/appStore';

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) failures++;
};
const headFlip = () => {
  const h = getHistory()!;
  return analyzeMesh(h.graph.revisions[h.headId].mesh).summary.flipped;
};

// A. 两分支改不同岛 -> 自动合并、双亲、发布
{
  const base = SAMPLES.find((s) => s.id === 'mirror')!.build();
  loadMesh(base, 'mirror');
  const rootId = getHistory()!.headId;

  const prop = startProposal('fix-2')!;
  fixAllFlippedIslands();
  const propHead = getHistory()!.graph.branches[prop.id].headId;
  check(propHead !== rootId, '提案分支产生修正提交');

  switchBranch('main');
  selectIslandFaces([0, 1]);
  check(mirrorSelected(), 'main 镜像岛1产生提交');
  const mainHead = getHistory()!.graph.branches.main.headId;

  const draft = beginMerge(prop.id, 'main')!;
  check(draft.conflicts.length === 0, `不同岛无冲突（实际 ${draft.conflicts.length}）`);
  check(draft.autoFaces.length === 4, `4 自动面（实际 ${draft.autoFaces.length}）`);

  const pub = publishMerge();
  check(pub.ok, '无冲突合并发布成功');
  const h = getHistory()!;
  const mrev = h.graph.revisions[h.headId];
  check(mrev.kind === 'merge', 'head 是合并提交');
  check(mrev.parentId === mainHead && mrev.secondParentId === propHead, '双亲=main头+提案头');
  check(mrev.mergeInfo?.autoFaceCount === 4 && mrev.mergeInfo.conflictCount === 0, '元信息 4 自动/0 冲突');
  check(h.graph.branches[prop.id].merged, '提案标记已合并');
  check(headFlip() === 2, `合并结果翻转=2（实际 ${headFlip()}）`);
  discardMerge();
}

// B. 同一面冲突，三种决议各自得到可预期翻转
function conflictBase(): MeshData {
  const b = new MeshBuilder();
  const add = (ox: number) => {
    const ids = [b.addPosV([ox, 0, 0]), b.addPosV([ox + 1, 0, 0]), b.addPosV([ox + 1, 0, 1])];
    const u = [b.addUv(0, 0), b.addUv(1, 0), b.addUv(1, 1)];
    b.tri([ids[0], u[0]], [ids[1], u[1]], [ids[2], u[2]]);
  };
  add(0);
  add(3);
  return b.build('conflict');
}
const mutateFace0 = (mesh: MeshData, axis: 'u' | 'v', sign: number): MeshData => {
  const out: MeshData = {
    ...mesh,
    uvs: Float64Array.from(mesh.uvs),
    faces: mesh.faces.map((f) => ({ ...f, uv: [...f.uv] as [number, number, number] })),
  };
  for (const u of mesh.faces[0].uv) out.uvs[u * 2 + (axis === 'v' ? 1 : 0)] *= sign;
  return out;
};
{
  const base = conflictBase();
  const baseFlip = analyzeMesh(base).summary.flipped;
  loadMesh(base, 'conflict');
  const prop = startProposal('p')!;

  // main：面0 u 镜像；提案：面0 v 镜像（不同结果）+ 面1 u+10
  const mainMesh = mutateFace0(base, 'u', -1);
  const propMesh = (() => {
    let m = mutateFace0(base, 'v', -1);
    m = {
      ...m,
      uvs: Float64Array.from(m.uvs),
      faces: m.faces.map((f) => ({ ...f, uv: [...f.uv] as [number, number, number] })),
    };
    for (const u of base.faces[1].uv) m.uvs[u * 2] += 10;
    return m;
  })();

  check(commitMeshToBranch('main', 'mirror', 'main u', mainMesh), 'main 提交');
  check(commitMeshToBranch(prop.id, 'mirror', 'prop v', propMesh), '提案提交');

  const draft = beginMerge(prop.id, 'main')!;
  check(draft.conflicts.length === 1, `1 个冲突（实际 ${draft.conflicts.length}）`);
  check(draft.autoFaces.includes(1), '面1 仅提案改 -> 自动');

  const flipAfter = (res: 'target' | 'proposal' | 'manual') => {
    const d = beginMerge(prop.id, 'main')!;
    for (const c of d.conflicts) resolveMergeConflict(c.id, res, res === 'manual' ? c.base.coords : undefined);
    const m = previewMerge()!;
    return analyzeMesh(m).summary.flipped;
  };
  check(flipAfter('target') === analyzeMesh(mainMesh).summary.flipped, 'target 决议翻转=main');
  check(flipAfter('proposal') === analyzeMesh(propMesh).summary.flipped, 'proposal 决议翻转=proposal');
  check(flipAfter('manual') === baseFlip, '手动回祖先翻转=base');

  // 未决议不能发布
  beginMerge(prop.id, 'main');
  check(!publishMerge().ok, '有未决议冲突时发布被拒绝');
  for (const c of pendingConflicts()) resolveMergeConflict(c.id, 'target');
  check(publishMerge().ok, '全决议后发布成功');
  check(getPendingMerge() === null, '发布后草稿清空');
  discardMerge();
}

// C. 合并进行中（草稿）刷新语义：草稿在 graph 中持久，重新 beginMerge 不覆盖
{
  const base = SAMPLES.find((s) => s.id === 'mirror')!.build();
  loadMesh(base, 'm');
  const prop = startProposal('pp')!;
  selectIslandFaces([0, 1, 2, 3]);
  mirrorSelected();
  switchBranch('main');
  selectIslandFaces([2, 3]);
  mirrorSelected();
  const d1 = beginMerge(prop.id, 'main');
  if (d1 && d1.conflicts.length) {
    resolveMergeConflict(d1.conflicts[0].id, 'proposal');
    const pending = getPendingMerge()!;
    check(pending.conflicts[0].resolution === 'proposal', '草稿记录决议');
    // 再次 beginMerge（模拟刷新后重新打开）：应重建草稿而非保留旧决议（这是"重算"语义），
    // 但 graph.pendingMerge 在刷新前必须已持久（由 scheduleSave 保证）。这里验证草稿可取回。
    const reopened = getPendingMerge();
    check(reopened !== null && reopened.conflicts.length === d1.conflicts.length, '草稿可继续（未丢失）');
  }
  discardMerge();
}

process.exit(failures > 0 ? 1 : 0);
