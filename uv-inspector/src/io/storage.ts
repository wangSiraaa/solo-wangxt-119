import type { MeshData } from '../model/types';
import { analyzeMesh } from '../analysis/analyze';
import { ensurePerCornerUVs } from '../model/uvfix';
import {
  createGraph,
  makeSummary,
  type Revision,
  type RevisionGraph,
} from '../model/revisions';

/**
 * 本地工程存储（IndexedDB），无后端。
 *
 * Schema v2：
 *   projects: ProjectRecordV2 = { id, name, updatedAt, version: 2, graph }
 *   每个工程把整棵修订图谱作为**单个文档**写入；一次 readwrite 事务只做一次 put，
 *   因此要么整图写入成功，要么完全失败——不会出现"半个新节点 + 旧图"的半写入状态，
 *   刷新中断 / 事务 abort / 写入冲突后重开，读到的始终是上一次完整提交的一致图谱。
 *
 * v1（仅保存当前 mesh）在 onupgradeneeded 中自动迁移为根版本。
 */

const DB_NAME = 'uv-inspector';
const STORE = 'projects';
const VERSION = 2;

export interface ProjectRecordV2 {
  id: string;
  name: string;
  updatedAt: number;
  version: 2;
  graph: RevisionGraph;
}

/** v1 记录（迁移来源）。 */
interface ProjectRecordV1 {
  id: string;
  name: string;
  updatedAt: number;
  mesh: SerializedMeshV1;
}
interface SerializedMeshV1 {
  name: string;
  positions: number[];
  uvs: number[];
  faces: MeshData['faces'];
  groups?: MeshData['groups'];
}

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  headSeq: number;
  revisionCount: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        const tx = req.transaction;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
          return; // 全新数据库，无需迁移
        }
        // v1 -> v2：读出旧记录，迁移成根版本图谱后写回（同一升级事务）
        if (tx && ev.oldVersion < 2) {
          const store = tx.objectStore(STORE);
          const getAll = store.getAll();
          getAll.onsuccess = () => {
            const rows = getAll.result as ProjectRecordV1[];
            for (const row of rows) {
              const mesh: MeshData = {
                name: row.mesh.name,
                positions: Float64Array.from(row.mesh.positions),
                uvs: Float64Array.from(row.mesh.uvs),
                faces: row.mesh.faces,
                groups: row.mesh.groups,
              };
              const prepared = ensurePerCornerUVs(mesh);
              const analysis = analyzeMesh(prepared);
              const root: Revision = {
                id: crypto.randomUUID(),
                parentId: null,
                kind: 'import',
                label: `导入 ${prepared.name}（从旧版工程迁移）`,
                createdAt: row.updatedAt,
                seq: 0,
                mesh: prepared,
                summary: makeSummary(prepared, analysis),
              };
              const record: ProjectRecordV2 = {
                id: row.id,
                name: row.name,
                updatedAt: row.updatedAt,
                version: 2,
                graph: createGraph(root),
              };
              store.put(record);
            }
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB 升级被其它标签页阻塞'));
    });
  }
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('IndexedDB 事务中止'));
      }),
  );
}

/** 整图原子写入。整份文档一次 put；失败时 IDB 中仍是上一完整版本。 */
export async function saveProjectGraph(
  id: string,
  name: string,
  graph: RevisionGraph,
  updatedAt = Date.now(),
): Promise<void> {
  const record: ProjectRecordV2 = { id, name, updatedAt, version: 2, graph };
  await tx('readwrite', (s) => s.put(record));
}

export class ConcurrentWriteError extends Error {
  constructor(
    public remote: ProjectRecordV2,
    public local: ProjectRecordV2,
  ) {
    super('IndexedDB 中的工程已被其它标签页更新（etag 冲突）');
    this.name = 'ConcurrentWriteError';
  }
}

/**
 * 乐观并发写入：仅当远端 etag === expectedEtag 时覆盖。
 * 若远端已被另一标签页推进，抛 ConcurrentWriteError 并回传远端文档，
 * 由调用方做不可变节点合并后重试——绝不静默覆盖对方的可达分支。
 */
export async function saveProjectGraphIfEtag(
  id: string,
  name: string,
  graph: RevisionGraph,
  expectedEtag: number,
  updatedAt = Date.now(),
): Promise<ProjectRecordV2> {
  const db = await openDb();
  return new Promise<ProjectRecordV2>((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const remote = getReq.result as ProjectRecordV2 | undefined;
      const remoteEtag = remote?.graph?.etag ?? 0;
      if (remote && remoteEtag !== expectedEtag) {
        t.abort();
        reject(new ConcurrentWriteError(remote, { id, name, updatedAt, version: 2, graph }));
        return;
      }
      const record: ProjectRecordV2 = { id, name, updatedAt, version: 2, graph };
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
    t.onerror = () => reject(t.error);
    t.onabort = () => {
      // abort 由上面显式触发时 onerror 已先 reject；这里兜底
      if (!(t.error && (t.error as Error & { code?: number }).code === 20)) {
        // noop，避免 unhandled
      }
    };
  });
}

/** 合并两个不可变图（本地优先）：远端新增的版本/分支并入，取较大 etag。 */
export function mergeGraphs(local: RevisionGraph, remote: RevisionGraph): RevisionGraph {
  const revisions = { ...remote.revisions, ...local.revisions };
  // 分支逐 id 合并：同一分支取 head 版本 seq 更大的指针，避免本地过期指针回退远端推进
  const branches: RevisionGraph['branches'] = { ...(remote.branches ?? {}) };
  for (const [id, lb] of Object.entries(local.branches ?? {})) {
    const rb = branches[id];
    if (!rb) {
      branches[id] = lb;
      continue;
    }
    const lSeq = revisions[lb.headId]?.seq ?? -1;
    const rSeq = revisions[rb.headId]?.seq ?? -1;
    branches[id] = lSeq >= rSeq ? lb : rb;
  }
  // 草稿：取更新的一条
  const pendingMerge =
    local.pendingMerge && remote.pendingMerge
      ? local.pendingMerge.updatedAt >= remote.pendingMerge.updatedAt
        ? local.pendingMerge
        : remote.pendingMerge
      : local.pendingMerge ?? remote.pendingMerge ?? null;
  return {
    revisions,
    branches,
    headId: local.headId,
    currentBranchId: local.currentBranchId,
    mainBranchId: local.mainBranchId || remote.mainBranchId || 'main',
    nextSeq: Math.max(local.nextSeq, remote.nextSeq),
    pendingMerge,
    etag: Math.max(local.etag ?? 0, remote.etag ?? 0) + 1,
  };
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = await tx<ProjectRecordV2[]>('readonly', (s) => s.getAll());
  return all
    .map((r) => ({
      id: r.id,
      name: r.name,
      updatedAt: r.updatedAt,
      headSeq: r.graph?.revisions[r.graph.headId]?.seq ?? 0,
      revisionCount: r.graph ? Object.keys(r.graph.revisions).length : 1,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadProject(id: string): Promise<ProjectRecordV2 | undefined> {
  return tx<ProjectRecordV2 | undefined>('readonly', (s) => s.get(id));
}

export async function deleteProject(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

/** 仅供测试：重置数据库连接。 */
export function _resetDbForTests(): void {
  dbPromise = null;
}

const LAST_KEY = 'uv-inspector:lastProjectId';

/** 记住最近打开/保存的工程（localStorage，与 IndexedDB 独立，刷新后用于自动恢复）。 */
export function rememberLastProjectId(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* 隐私模式等：忽略，自动恢复退化为样例 */
  }
}

export function getLastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function clearLastProjectId(): void {
  try {
    localStorage.removeItem(LAST_KEY);
  } catch {
    /* ignore */
  }
}
