import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  ConcurrentWriteError,
  _resetDbForTests,
  mergeGraphs,
  saveProjectGraph,
  saveProjectGraphIfEtag,
  loadProject,
} from '../src/io/storage';
import { createGraph, ensureBranches, makeSummary, type Revision, type RevisionGraph } from '../src/model/revisions';
import { analyzeMesh } from '../src/analysis/analyze';
import { SAMPLES } from '../src/samples/samples';

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) failures++;
};

let idc = 0;
const idf = () => `id-${idc++}`;
function rev(parentId: string | null, branchId: string, mesh = SAMPLES.find((s) => s.id === 'cube')!.build()): Revision {
  return {
    id: idf(), parentId, kind: 'mirror', label: 'r' + idc,
    createdAt: idc, seq: idc, mesh, summary: makeSummary(mesh, analyzeMesh(mesh)),
    branchId,
  };
}

await (async () => {
  _resetDbForTests();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

  const base = SAMPLES.find((s) => s.id === 'cube')!.build();
  const root: Revision = {
    id: idf(), parentId: null, kind: 'import', label: 'root',
    createdAt: 0, seq: 0, mesh: base, summary: makeSummary(base, analyzeMesh(base)), branchId: 'main',
  };
  let g = createGraph(root);
  const pid = 'p';
  await saveProjectGraph(pid, 'proj', g, 1);

  // 标签页 A 与 B 都基于 etag=1 编辑
  const childA = rev(root.id, 'main');
  const gA: RevisionGraph = {
    ...g,
    revisions: { ...g.revisions, [childA.id]: childA },
    headId: childA.id,
    branches: { ...g.branches, main: { ...g.branches.main, headId: childA.id } },
    etag: 2,
  };

  // A 先保存成功
  await saveProjectGraphIfEtag(pid, 'proj', gA, 1, 2);
  const recA = await loadProject(pid);
  check(recA!.graph.revisions[childA.id] !== undefined, '标签页 A 的提交已持久化');

  // B 基于过期 etag=1 保存 -> 冲突，不覆盖 A
  const propBranchId = 'propB';
  const childB = rev(root.id, propBranchId);
  const gB: RevisionGraph = {
    ...ensureBranches(g),
    revisions: { ...g.revisions, [childB.id]: childB },
    branches: {
      ...g.branches,
      [propBranchId]: {
        id: propBranchId, name: 'prop', headId: childB.id, forkPointId: root.id, createdAt: 1,
      },
    },
    currentBranchId: 'main',
    etag: 2,
  };
  let conflict: ConcurrentWriteError | null = null;
  try {
    await saveProjectGraphIfEtag(pid, 'proj', gB, 1, 3);
  } catch (e) {
    conflict = e as ConcurrentWriteError;
  }
  check(conflict instanceof ConcurrentWriteError, '过期 etag 保存抛 ConcurrentWriteError');
  check(conflict!.remote.graph.revisions[childA.id] !== undefined, '冲突回传的远端包含 A 的提交');

  // 合并后重试：A 的 main 提交与 B 的提案提交都在
  const merged = mergeGraphs(gB, conflict!.remote.graph);
  check(merged.revisions[childA.id] !== undefined, '合并保留 A 的节点');
  check(merged.revisions[childB.id] !== undefined, '合并保留 B 的节点');
  check(merged.branches[propBranchId] !== undefined && merged.branches.main.headId === childA.id, '合并后两条分支指针都正确');
  await saveProjectGraphIfEtag(pid, 'proj', merged, conflict!.remote.graph.etag, 4);
  const recFinal = await loadProject(pid);
  check(recFinal!.graph.revisions[childA.id] !== undefined, '最终远端保留 A');
  check(recFinal!.graph.revisions[childB.id] !== undefined, '最终远端保留 B');
  check(Object.keys(recFinal!.graph.branches).length === 2, '最终远端两条分支');
})();

process.exit(failures > 0 ? 1 : 0);
