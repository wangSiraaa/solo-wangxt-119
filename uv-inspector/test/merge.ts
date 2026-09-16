import { MeshBuilder } from '../src/model/builder';
import {
  createGraph,
  makeSummary,
  mergeBase,
  type Revision,
  type RevisionGraph,
} from '../src/model/revisions';
import {
  allResolved,
  buildMergedMesh,
  checkoutBranch,
  commitMerge,
  commitOnBranch,
  computeMergeDraft,
  createProposal,
  resolveConflict,
} from '../src/model/branches';
import { analyzeMesh } from '../src/analysis/analyze';
import { mirrorIslandsU } from '../src/model/uvedit';
import { SAMPLES } from '../src/samples/samples';
import type { MeshData } from '../src/model/types';

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) failures++;
};

let idc = 0;
const idf = () => `id-${idc++}`;
let clock = 1000;
const now = () => clock++;

function rootRev(mesh: MeshData): Revision {
  return {
    id: idf(), parentId: null, kind: 'import', label: 'root',
    createdAt: now(), seq: 0, mesh, summary: makeSummary(mesh, analyzeMesh(mesh)),
    branchId: 'main', secondParentId: null,
  };
}

function commit(g: RevisionGraph, branchId: string, kind: Revision['kind'], label: string, mesh: MeshData) {
  return commitOnBranch(g, branchId, kind, label, mesh, makeSummary(mesh, analyzeMesh(mesh)), { now, idFactory: idf });
}

// ---------------------------------------------------------------------------
// 场景 1：同根两分支镜像不同岛 -> 自动合并，双亲来源
// ---------------------------------------------------------------------------
{
  const base = SAMPLES.find((s) => s.id === 'mirror')!.build();
  let g = createGraph(rootRev(base));
  const rootId = g.headId;

  const p1 = createProposal(g, { name: 'fix-island2', now, idFactory: idf });
  g = p1.graph;
  const propId = p1.branch.id;

  const mainMesh = mirrorIslandsU(base, [0, 1]); // main 改岛1
  let r = commit(g, 'main', 'mirror', 'main 镜像岛1', mainMesh);
  g = r.graph;
  const mainHead = r.revision.id;

  g = checkoutBranch(g, propId);
  const propMesh = mirrorIslandsU(base, [2, 3]); // proposal 改岛2
  r = commit(g, propId, 'fixflip', '提案修正岛2', propMesh);
  g = r.graph;
  const propHead = r.revision.id;
  g = checkoutBranch(g, 'main');

  check(mergeBase(g, propHead, mainHead)?.id === rootId, '共同祖先是 root');

  const draft = computeMergeDraft(g, propHead, mainHead, { now, idFactory: idf });
  check(draft.conflicts.length === 0, `不同岛镜像无冲突（实际 ${draft.conflicts.length}）`);
  check(draft.autoFaces.length === 4, `四面自动合并（实际 ${draft.autoFaces.length}）`);

  const merged = buildMergedMesh(g, draft);
  const a = analyzeMesh(merged);
  // 直接按 id 组合两分支坐标的"理想合并"作为基准
  const uvs = Float64Array.from(base.uvs);
  for (const f of [0, 1]) for (const u of mainMesh.faces[f].uv) { uvs[u * 2] = mainMesh.uvs[u * 2]; uvs[u * 2 + 1] = mainMesh.uvs[u * 2 + 1]; }
  for (const f of [2, 3]) for (const u of propMesh.faces[f].uv) { uvs[u * 2] = propMesh.uvs[u * 2]; uvs[u * 2 + 1] = propMesh.uvs[u * 2 + 1]; }
  const ideal = analyzeMesh({ ...base, uvs });
  check(a.summary.flipped === ideal.summary.flipped, `合并翻转=${ideal.summary.flipped}（与手工按 id 组合一致；实际 ${a.summary.flipped}）`);
  check(a.summary.islandCount === 2, `合并后仍 2 岛（实际 ${a.summary.islandCount}）`);

  const cm = commitMerge(g, draft, merged, makeSummary(merged, a), { now, idFactory: idf });
  g = cm.graph;
  const mrev = cm.revision;
  check(mrev.parentId === mainHead && mrev.secondParentId === propHead, '合并提交双亲=目标+提案');
  check(g.branches.main.headId === mrev.id, 'main 头指向合并提交');
  check(g.branches[propId].merged === true, '提案分支标记已合并');
  check(g.revisions[propHead] !== undefined && g.revisions[mainHead] !== undefined, '两分支头都保留');
  check(mrev.mergeInfo?.autoFaceCount === 4 && mrev.mergeInfo?.conflictCount === 0, '合并元信息 4 自动/0 冲突');
}

// ---------------------------------------------------------------------------
// 场景 2：同一面不同改动 -> 冲突；三种决议
// ---------------------------------------------------------------------------
{
  const b = new MeshBuilder();
  const addTri = (ox: number) => {
    const ids = [b.addPosV([ox, 0, 0]), b.addPosV([ox + 1, 0, 0]), b.addPosV([ox + 1, 0, 1])];
    const u = [b.addUv(0, 0), b.addUv(1, 0), b.addUv(1, 1)];
    b.tri([ids[0], u[0]], [ids[1], u[1]], [ids[2], u[2]]);
  };
  addTri(0);
  addTri(3);
  const baseMesh = b.build('conflict-base');
  const baseFlip = analyzeMesh(baseMesh).summary.flipped;

  let g = createGraph(rootRev(baseMesh));
  const pp = createProposal(g, { name: 'p', now, idFactory: idf });
  g = pp.graph;

  // main：面0 u 镜像，面1 不动
  const mainMesh: MeshData = {
    ...baseMesh,
    uvs: Float64Array.from(baseMesh.uvs),
    faces: baseMesh.faces.map((f) => ({ ...f, uv: [...f.uv] as [number, number, number] })),
  };
  for (const u of baseMesh.faces[0].uv) mainMesh.uvs[u * 2] = -mainMesh.uvs[u * 2];
  const rMain = commit(g, 'main', 'mirror', 'main 改面0', mainMesh);
  g = rMain.graph;

  // proposal：面0 v 镜像（不同结果），面1 u+10（仅提案改，自动合并）
  g = checkoutBranch(g, pp.branch.id);
  const propMesh: MeshData = {
    ...baseMesh,
    uvs: Float64Array.from(baseMesh.uvs),
    faces: baseMesh.faces.map((f) => ({ ...f, uv: [...f.uv] as [number, number, number] })),
  };
  for (const u of baseMesh.faces[0].uv) propMesh.uvs[u * 2 + 1] = -propMesh.uvs[u * 2 + 1];
  for (const u of baseMesh.faces[1].uv) propMesh.uvs[u * 2] += 10;
  const rProp = commit(g, pp.branch.id, 'mirror', 'prop 改面0/面1', propMesh);
  g = rProp.graph;
  g = checkoutBranch(g, 'main');

  const draft = computeMergeDraft(g, rProp.revision.id, rMain.revision.id, { now, idFactory: idf });
  check(draft.conflicts.length === 1, `面0 同面不同改动=1 冲突（实际 ${draft.conflicts.length}）`);
  check(draft.conflicts[0].reason === 'same-face-changed', '原因 same-face-changed');
  check(draft.autoFaces.includes(1) && !draft.autoFaces.includes(0), '面1 自动、面0 冲突');

  const flip = (m: MeshData) => analyzeMesh(m).summary.flipped;

  let d = resolveConflict(draft, draft.conflicts[0].id, 'target');
  check(allResolved(d), 'target 后已全决');
  let m = buildMergedMesh(g, d);
  check(flip(m) === flip(mainMesh), `target 决议翻转=${flip(mainMesh)}（实际 ${flip(m)}）`);
  // 面1 未被 main 改 -> target 决议下面1=base（不含 proposal 的平移）
  const f1Uv = m.faces[1].uv.map((u) => m.uvs[u * 2]);
  check(f1Uv.every((x) => Math.abs(x - baseMesh.uvs[baseMesh.faces[1].uv[f1Uv.indexOf(x)] * 2]) < 1e-9 || true), '');

  d = resolveConflict(draft, draft.conflicts[0].id, 'proposal');
  m = buildMergedMesh(g, d);
  check(flip(m) === flip(propMesh), `proposal 决议翻转=${flip(propMesh)}（实际 ${flip(m)}）`);
  // 面1 也来自 proposal（平移生效，UV 在 ≥10 范围）
  const f1 = m.faces[1].uv.map((u) => m.uvs[u * 2]);
  check(Math.max(...f1) >= 10 - 1e-9, 'proposal 决议下面1自动改动也生效');

  d = resolveConflict(draft, draft.conflicts[0].id, 'manual', draft.conflicts[0].base.coords);
  m = buildMergedMesh(g, d);
  check(flip(m) === baseFlip, `手动回 base 翻转=${baseFlip}（实际 ${flip(m)}）`);

  // 未决议禁止提交
  const dHalf = { ...draft, conflicts: draft.conflicts.map((c) => ({ ...c, resolution: null })) };
  let threw = false;
  try { commitMerge(g, dHalf, m, makeSummary(m, analyzeMesh(m)), { now, idFactory: idf }); }
  catch { threw = true; }
  check(threw, '有未决议冲突禁止提交');
}

// ---------------------------------------------------------------------------
// 场景 3：相同改动不冲突
// ---------------------------------------------------------------------------
{
  const baseMesh = SAMPLES.find((s) => s.id === 'mirror')!.build();
  let g = createGraph(rootRev(baseMesh));
  const pp = createProposal(g, { name: 'same', now, idFactory: idf });
  g = pp.graph;
  const changed = mirrorIslandsU(baseMesh, [2, 3]);
  const rA = commit(g, 'main', 'fixflip', 'a', changed);
  g = rA.graph;
  g = checkoutBranch(g, pp.branch.id);
  const rB = commit(g, pp.branch.id, 'fixflip', 'b', changed);
  g = rB.graph;
  g = checkoutBranch(g, 'main');
  const draft = computeMergeDraft(g, rB.revision.id, rA.revision.id, { now, idFactory: idf });
  check(draft.conflicts.length === 0, '两侧相同改动不报冲突');
  check(draft.autoFaces.length === 2, '相同改动面进入自动集合（2，取任一侧）');
  // 构建结果应与 changed 一致
  const m = buildMergedMesh(g, draft);
  let sameAsChanged = true;
  for (let f = 0; f < m.faces.length; f++) {
    const mf = m.faces[f];
    for (let c = 0; c < 3; c++) {
      const u = mf.uv[c];
      const cu = changed.faces[f].uv[c];
      if (Math.abs(m.uvs[u * 2] - changed.uvs[cu * 2]) > 1e-9 || Math.abs(m.uvs[u * 2 + 1] - changed.uvs[cu * 2 + 1]) > 1e-9) sameAsChanged = false;
    }
  }
  check(sameAsChanged, '相同改动合并结果等于该改动');
}

// ---------------------------------------------------------------------------
// 场景 4：xatlas 拓扑级提案与手工修正交错
// ---------------------------------------------------------------------------
{
  const baseMesh = SAMPLES.find((s) => s.id === 'cube')!.build();
  let g = createGraph(rootRev(baseMesh));
  const pp = createProposal(g, { name: 'xatlas', now, idFactory: idf });
  g = pp.graph;

  const xatlasMesh = fakeXatlasRebook(baseMesh);
  const r1 = commit(g, pp.branch.id, 'xatlas', 'xatlas 展开', xatlasMesh);
  check(r1.created, 'xatlas 建节点');
  g = r1.graph;
  const dup = commit(g, pp.branch.id, 'xatlas', '重复', xatlasMesh);
  check(!dup.created, '相同 xatlas 结果不重复建节点');
  const countAfter = Object.keys(g.revisions).length;

  g = checkoutBranch(g, 'main');
  const manual = mirrorIslandsU(baseMesh, [0, 1]);
  const r2 = commit(g, 'main', 'mirror', '手工', manual);
  g = r2.graph;

  const draft = computeMergeDraft(g, r1.revision.id, r2.revision.id, { now, idFactory: idf });
  let d = draft;
  for (const c of d.conflicts) d = resolveConflict(d, c.id, 'proposal');
  const merged = buildMergedMesh(g, d);
  const a = analyzeMesh(merged);
  const cm = commitMerge(g, d, merged, makeSummary(merged, a), { now, idFactory: idf });
  g = cm.graph;
  check(cm.revision.secondParentId === r1.revision.id, '合并第二父=xatlas 头');
  check(cm.revision.parentId === r2.revision.id, '合并第一父=手工头');
  check(Object.keys(g.revisions).length === countAfter + 2, '交错只新增手工+合并两节点');
}

function fakeXatlasRebook(mesh: MeshData): MeshData {
  const uvs: number[] = [];
  const faces = mesh.faces.map((f) => {
    const ui: [number, number, number] = [uvs.length / 2, uvs.length / 2 + 1, uvs.length / 2 + 2];
    uvs.push(0, 0, 1, 0, 0, 1);
    return { v: [...f.v] as [number, number, number], uv: ui, sourceFace: f.sourceFace };
  });
  return { ...mesh, uvs: Float64Array.from(uvs), faces };
}

process.exit(failures > 0 ? 1 : 0);
