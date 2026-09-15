import {
  ancestorChain,
  commitRevision,
  createGraph,
  deleteUnreachable,
  makeSummary,
  restoreRevision,
  unreachableNodes,
  uvEquals,
  type Revision,
  type RevisionGraph,
} from '../src/model/revisions';
import { analyzeMesh } from '../src/analysis/analyze';
import { SAMPLES } from '../src/samples/samples';
import { mirrorIslandsU } from '../src/model/uvedit';
import type { MeshData } from '../src/model/types';

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) failures++;
};

let idCounter = 0;
const idf = () => `id-${idCounter++}`;
let clock = 1000;
const now = () => clock++;

function rootOf(mesh: MeshData, label = 'root'): Revision {
  return {
    id: idf(),
    parentId: null,
    kind: 'import',
    label,
    createdAt: now(),
    seq: 0,
    mesh,
    summary: makeSummary(mesh, analyzeMesh(mesh)),
  };
}

const commit = (
  g: RevisionGraph,
  kind: Revision['kind'],
  label: string,
  mesh: MeshData,
  parentId?: string,
) =>
  commitRevision(g, {
    parentId: parentId ?? g.headId,
    kind,
    label,
    mesh,
    summary: makeSummary(mesh, analyzeMesh(mesh)),
    now: now(),
    idFactory: idf,
  });

// ---------------------------------------------------------------------------
// 1. 连续编辑 + 从祖先恢复形成两条分支，且原分支不被覆盖
// ---------------------------------------------------------------------------
{
  const base = SAMPLES.find((s) => s.id === 'mirror')!.build();
  let g = createGraph(rootOf(base));

  // v1：镜像镜像岛的两个面 -> 翻转 2 -> 0
  const m1 = mirrorIslandsU(base, [2, 3]);
  const r1 = commit(g, 'mirror', 'mirror1', m1);
  check(r1.created, 'v1 镜像产生新版本');
  g = r1.graph;
  check(g.revisions[g.headId].summary.flipped === 0, 'v1 镜像后翻转归零');

  // v2：再次镜像同一岛 -> 翻转 0 -> 2（两次反射翻转数还原；位置因包围盒变化而不同）
  const m2 = mirrorIslandsU(m1, [2, 3]);
  const r2 = commit(g, 'fixflip', 'mirror2', m2);
  check(r2.created, 'v2 再次镜像产生新版本');
  g = r2.graph;
  check(g.revisions[g.headId].summary.flipped === 2, 'v2 翻转数回到 2（独立节点）');

  // 从 v1（祖先，非 head）恢复 -> 以 v1 为父建立 restore 节点（分支）。
  // 即使新节点 mesh 与 v1 相同，也必须建节点记录 head 跳转。
  const v1Id = r1.revision.id;
  const restored = restoreRevision(
    g,
    v1Id,
    g.revisions[v1Id].mesh,
    g.revisions[v1Id].summary,
    undefined,
    now(),
    idf,
  );
  check(restored.created, '从祖先 v1 恢复产生新节点（即使 UV 与 v1 相同）');
  g = restored.graph;

  // 两条分支都保留：v2 仍可达（从根），新 restore 节点也在
  const allIds = Object.keys(g.revisions);
  check(allIds.length === 4, `共 4 个节点（root,v1,v2,restore），实际 ${allIds.length}`);
  check(g.revisions[g.headId].parentId === v1Id, '恢复节点的父是 v1（新分支挂在 v1 下）');
  check(g.revisions[r2.revision.id] !== undefined, '原分支的 v2 仍存在、未被覆盖');

  // head 的祖先链是 root->v1->restore，不含 v2
  const chain = ancestorChain(g, g.headId).map((r) => r.id);
  check(chain.length === 3 && chain[1] === v1Id && !chain.includes(r2.revision.id), 'head 祖先链为 root-v1-restore（与 v2 分支分离）');

  // v2 仍从根可达（在另一分支上）
  check(unreachableNodes(g).length === 0, '正常分支树没有不可达节点');
}

// ---------------------------------------------------------------------------
// 2. 重复修正（无 UV 变化）不产生等价节点
// ---------------------------------------------------------------------------
{
  const base = SAMPLES.find((s) => s.id === 'mirror')!.build();
  let g = createGraph(rootOf(base));
  const count = () => Object.keys(g.revisions).length;

  // 直接提交与父 UV 完全等价的网格 -> created=false
  const same = commit(g, 'fixflip', 'no-op', base);
  check(!same.created && count() === 1, '相同 UV 的重复提交不产生节点');

  // 真正修正翻转岛
  const flippedIslands = analyzeMesh(base).islands.filter((i) => i.mirrored);
  let fixedMesh = base;
  for (const isl of flippedIslands) fixedMesh = mirrorIslandsU(fixedMesh, isl.faces);
  const r = commit(g, 'fixflip', 'fix', fixedMesh);
  check(r.created, '真实修正产生节点');
  g = r.graph;
  check(count() === 2, '修正后 2 个节点');

  // 在已修正的 head 上再次"修正"（已无翻转岛，mirrorIslandsU 输入为空 -> 原样）
  const again = mirrorIslandsU(g.revisions[g.headId].mesh, []);
  const r2 = commit(g, 'fixflip', 'fix-again', again);
  check(!r2.created && count() === 2, '对已修正版本重复修正不产生重复节点');
}

// ---------------------------------------------------------------------------
// 3. uvEquals 去重的严格性
// ---------------------------------------------------------------------------
{
  const base = SAMPLES.find((s) => s.id === 'cube')!.build();
  const g = createGraph(rootOf(base));
  // 拷贝但数值完全一致
  const clone: MeshData = {
    ...base,
    uvs: Float64Array.from(base.uvs),
    faces: base.faces.map((f) => ({ ...f, v: [...f.v] as [number, number, number], uv: [...f.uv] as [number, number, number] })),
  };
  check(uvEquals(base, clone), '数值一致的网格判为 UV 等价');
  const changed = mirrorIslandsU(base, [0, 1]);
  check(!uvEquals(base, changed), '镜像后判为不等价');
  void g;
}

// ---------------------------------------------------------------------------
// 4. 不可达（孤儿草稿）节点可删除，可达节点拒绝删除
// ---------------------------------------------------------------------------
{
  const base = SAMPLES.find((s) => s.id === 'cube')!.build();
  const g0 = createGraph(rootOf(base));
  const r1 = commit(g0, 'mirror', 'm', mirrorIslandsU(base, [0, 1]));
  const g = r1.graph;

  // 人工构造一个半写入孤儿：父指向不存在的节点
  const orphan: Revision = {
    id: 'orphan',
    parentId: 'does-not-exist',
    kind: 'mirror',
    label: 'half-written',
    createdAt: now(),
    seq: 99,
    mesh: base,
    summary: makeSummary(base, analyzeMesh(base)),
  };
  const gOrphan: RevisionGraph = { ...g, revisions: { ...g.revisions, orphan } };
  check(unreachableNodes(gOrphan).includes('orphan'), '半写入孤儿被识别为不可达');
  const gClean = deleteUnreachable(gOrphan, 'orphan');
  check(gClean.revisions['orphan'] === undefined, '孤儿被删除');
  check(Object.keys(gClean.revisions).length === 2, '删除孤儿后其余版本完好');

  // 拒绝删除可达节点
  let threw = false;
  try {
    deleteUnreachable(g, r1.revision.id);
  } catch {
    threw = true;
  }
  check(threw, '拒绝删除仍可达的版本');
}

// ---------------------------------------------------------------------------
// 5. 错链防护：向不存在的父提交必须抛错，不得静默挂载
// ---------------------------------------------------------------------------
{
  const base = SAMPLES.find((s) => s.id === 'cube')!.build();
  const g = createGraph(rootOf(base));
  let threw = false;
  try {
    commitRevision(g, {
      parentId: 'missing',
      kind: 'mirror',
      label: 'bad',
      mesh: base,
      summary: makeSummary(base, analyzeMesh(base)),
    });
  } catch {
    threw = true;
  }
  check(threw, '父版本不存在时提交抛错（杜绝错链）');
  check(Object.keys(g.revisions).length === 1, '抛错后图谱不变');
}

process.exit(failures > 0 ? 1 : 0);
