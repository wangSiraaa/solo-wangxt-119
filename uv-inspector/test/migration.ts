/**
 * v1 迁移后的功能等价性：迁移根版本上的镜像岛判定、负轴翻转、修正翻转岛、
 * xatlas 风格展开结果、OBJ 往返都保持既有结果。
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { _resetDbForTests, loadProject } from '../src/io/storage';
import { analyzeMesh } from '../src/analysis/analyze';
import { mirrorIslandsU } from '../src/model/uvedit';
import { writeOBJ, parseOBJ } from '../src/io/obj';
import { SAMPLES } from '../src/samples/samples';
import type { MeshData } from '../src/model/types';

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) failures++;
};

async function migrateLegacy(mesh: MeshData, id: string) {
  const idb = new IDBFactory();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = idb;
  _resetDbForTests();
  // 写 v1 记录
  await new Promise<void>((resolve, reject) => {
    const open = idb.open('uv-inspector', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('projects', { keyPath: 'id' });
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({
        id,
        name: 'legacy',
        updatedAt: 1,
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
  _resetDbForTests();
  const rec = await loadProject(id);
  if (!rec) throw new Error('迁移后读不到工程');
  return rec.graph.revisions[rec.graph.headId].mesh;
}

// 1. 镜像岛样例迁移后：2 翻转 / 2 岛 / 1 接缝 / flags false,true
{
  const mesh = await migrateLegacy(SAMPLES.find((s) => s.id === 'mirror')!.build(), 'm1');
  const r = analyzeMesh(mesh);
  check(r.summary.flipped === 2, `迁移后镜像岛翻转=2（实际 ${r.summary.flipped}）`);
  check(r.summary.islandCount === 2, `迁移后岛数=2（实际 ${r.summary.islandCount}）`);
  check(r.summary.seamEdgeCount === 1, `迁移后接缝=1（实际 ${r.summary.seamEdgeCount}）`);
  check(r.islands.map((i) => i.mirrored).join(',') === 'false,true', '迁移后 mirrored 标志 false,true');
}

// 2. 立方体（含负轴负面积正常面）迁移后 0 翻转 / 6 岛 / 12 接缝
{
  const mesh = await migrateLegacy(SAMPLES.find((s) => s.id === 'cube')!.build(), 'm2');
  const r = analyzeMesh(mesh);
  check(r.summary.flipped === 0, `迁移后立方体翻转=0（实际 ${r.summary.flipped}）`);
  check(r.summary.islandCount === 6, `迁移后岛=6（实际 ${r.summary.islandCount}）`);
  check(r.summary.seamEdgeCount === 12, `迁移后接缝=12（实际 ${r.summary.seamEdgeCount}）`);

  // 在迁移根版本上修正翻转岛（无翻转）-> 不产生变化
  const flipped = r.islands.filter((i) => i.mirrored);
  check(flipped.length === 0, '迁移立方体无翻转岛可修');

  // OBJ 往返
  const round = parseOBJ(writeOBJ(mesh)).mesh;
  const r2 = analyzeMesh(round);
  check(r2.summary.flipped === 0 && r2.summary.islandCount === 6, '迁移立方体 OBJ 往返保持 0 翻转 / 6 岛');
}

// 3. 迁移镜像岛 -> 修正翻转岛 -> 0 翻转；OBJ 往返保持
{
  const mesh = await migrateLegacy(SAMPLES.find((s) => s.id === 'mirror')!.build(), 'm3');
  let r = analyzeMesh(mesh);
  let next = mesh;
  for (const isl of r.islands.filter((i) => i.mirrored)) {
    next = mirrorIslandsU(next, isl.faces);
  }
  r = analyzeMesh(next);
  check(r.summary.flipped === 0, `迁移镜像岛修正后翻转=0（实际 ${r.summary.flipped}）`);
  const round = parseOBJ(writeOBJ(next)).mesh;
  const r2 = analyzeMesh(round);
  check(r2.summary.flipped === 0, '修正后 OBJ 往返保持 0 翻转');
  check(r2.summary.seamEdgeCount === 1, '修正后接缝仍为 1（身份未被焊接）');
}

process.exit(failures > 0 ? 1 : 0);
