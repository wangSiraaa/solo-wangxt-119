/**
 * @vitest-environment node
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  _resetDbForTests,
  listProjects,
  loadProject,
  saveProjectGraph,
} from '../src/io/storage';
import { createGraph, makeSummary } from '../src/model/revisions';
import { analyzeMesh } from '../src/analysis/analyze';
import { SAMPLES } from '../src/samples/samples';
import type { ProjectRecordV2 } from '../src/io/storage';

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) failures++;
};

function rootFromSample(id: string) {
  const mesh = SAMPLES.find((s) => s.id === id)!.build();
  return {
    id: crypto.randomUUID(),
    parentId: null,
    kind: 'import' as const,
    label: `导入 ${mesh.name}`,
    createdAt: 1000,
    seq: 0,
    mesh,
    summary: makeSummary(mesh, analyzeMesh(mesh)),
  };
}

async function freshDb() {
  _resetDbForTests();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
}

// ---------------------------------------------------------------------------
// 1. 原子整图写入 + 读回一致
// ---------------------------------------------------------------------------
await freshDb();
{
  const root = rootFromSample('cube');
  const graph = createGraph(root);
  const pid = 'p1';
  await saveProjectGraph(pid, 'cube-project', graph, 1234);
  const rec = await loadProject(pid);
  check(rec?.version === 2, '写入记录标记为 v2');
  check(rec?.graph.headId === root.id, '读回 headId 一致');
  check(Object.keys(rec!.graph.revisions).length === 1, '读回 1 个根版本');
  const meta = await listProjects();
  check(meta[0].revisionCount === 1 && meta[0].headSeq === 0, '工程列表显示版本数与 head seq');
}

// ---------------------------------------------------------------------------
// 2. 整图重写不丢版本（模拟连续编辑后保存：文档整体替换）
// ---------------------------------------------------------------------------
{
  const root = rootFromSample('mirror');
  let graph = createGraph(root);
  const pid = 'p2';
  await saveProjectGraph(pid, 'm', graph, 1);
  // 追加一个子版本（手工构造，模拟 commit）
  const childMesh = root.mesh; // 内容相同也无所谓，这里只测持久化
  const child = {
    id: crypto.randomUUID(),
    parentId: root.id,
    kind: 'mirror' as const,
    label: '镜像',
    createdAt: 2,
    seq: 1,
    mesh: childMesh,
    summary: root.summary,
  };
  graph = { revisions: { ...graph.revisions, [child.id]: child }, headId: child.id, nextSeq: 2 };
  await saveProjectGraph(pid, 'm', graph, 2);
  const rec = await loadProject(pid);
  check(Object.keys(rec!.graph.revisions).length === 2, '第二次保存后两个版本都在');
  check(rec!.graph.headId === child.id, 'head 指向新版本，根版本仍可达');
}

// ---------------------------------------------------------------------------
// 3. v1 工程迁移：直接往 v1 schema 写一条旧记录，升级到 v2 后应成为根版本
// ---------------------------------------------------------------------------
await freshDb();
{
  const mesh = SAMPLES.find((s) => s.id === 'mirror')!.build();
  // 先以 v1 打开数据库写旧记录
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('uv-inspector', 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('projects', { keyPath: 'id' });
    };
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({
        id: 'legacy',
        name: '旧工程',
        updatedAt: 999,
        mesh: {
          name: mesh.name,
          positions: Array.from(mesh.positions),
          uvs: Array.from(mesh.uvs),
          faces: mesh.faces,
        },
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });

  // 触发 v2 升级
  _resetDbForTests();
  const rec = await loadProject('legacy');
  check(rec?.version === 2, '旧工程升级为 v2');
  check(!!rec?.graph, '迁移生成修订图谱');
  check(Object.keys(rec!.graph.revisions).length === 1, '迁移后为单根版本');
  const root = rec!.graph.revisions[rec!.graph.headId];
  check(root.parentId === null && root.kind === 'import', '根版本无父、类型为 import');
  check(root.summary.flipped === 2, `迁移后镜像岛翻转判定保持（2），实际 ${root.summary.flipped}`);
  check(root.summary.seamEdgeCount === 1, `迁移后接缝数保持（1），实际 ${root.summary.seamEdgeCount}`);

  // 迁移后该项目可继续正常追加保存
  await saveProjectGraph('legacy', '旧工程', rec!.graph, 1000);
  const again = await loadProject('legacy');
  check(Object.keys(again!.graph.revisions).length === 1, '迁移工程再次保存不损坏');
}

// ---------------------------------------------------------------------------
// 4. 写入失败/事务中止不改变已存在版本（半写入防护）
// ---------------------------------------------------------------------------
await freshDb();
{
  const root = rootFromSample('cube');
  const graph = createGraph(root);
  await saveProjectGraph('p4', 'ok', graph, 1);

  // 用显式 abort 模拟真实的写冲突/配额失败（都会让事务中止并整体回滚，
  // fake-indexeddb 不做结构化克隆，故不能用循环引用触发 DataCloneError）。
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('uv-inspector', 2);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  await new Promise<void>((resolve) => {
    const tx = db.transaction('projects', 'readwrite');
    // 先在同一事务里 put 一个"半写入"图，再立即 abort -> 整事务回滚
    tx.objectStore('projects').put({
      id: 'p4',
      name: 'broken',
      updatedAt: 2,
      version: 2,
      graph: { revisions: { wouldBeOrphan: {} }, headId: 'wouldBeOrphan', nextSeq: 1 },
    });
    tx.onabort = () => resolve();
    tx.onerror = () => resolve();
    tx.abort();
  });
  db.close();

  const rec = await loadProject('p4');
  check(rec?.name === 'ok', '失败写入回滚，工程名仍是旧值');
  check(Object.keys(rec!.graph.revisions).length === 1, '失败写入未留下半节点（仍 1 版本）');
}

// ---------------------------------------------------------------------------
// 5. 乱序并发保存：以最新一次为准，不错链/不丢版本（整图语义）
// ---------------------------------------------------------------------------
await freshDb();
{
  const root = rootFromSample('cube');
  let graph = createGraph(root);
  const pid = 'p5';
  await saveProjectGraph(pid, 'g0', graph, 1);
  const g1 = { ...graph, headId: root.id, extra: undefined } as ProjectRecordV2['graph'];
  const child = {
    id: crypto.randomUUID(),
    parentId: root.id,
    kind: 'mirror' as const,
    label: 'c',
    createdAt: 3,
    seq: 1,
    mesh: root.mesh,
    summary: root.summary,
  };
  const g2: ProjectRecordV2['graph'] = {
    revisions: { ...graph.revisions, [child.id]: child },
    headId: child.id,
    nextSeq: 2,
  };
  void g1;
  // 故意乱序发起：后写的更完整。IDB 同 store 事务按提交顺序串行化，最终以最后一次为准。
  await Promise.all([
    saveProjectGraph(pid, 'older', graph, 10),
    saveProjectGraph(pid, 'newer', g2, 20),
    saveProjectGraph(pid, 'newest', g2, 30),
  ]);
  const rec = await loadProject(pid);
  check(Object.keys(rec!.graph.revisions).length === 2, `乱序保存后版本完整（2），实际 ${Object.keys(rec!.graph.revisions).length}`);
  check(rec!.graph.headId === child.id, 'head 为最新子版本，无错链');
}

process.exit(failures > 0 ? 1 : 0);
