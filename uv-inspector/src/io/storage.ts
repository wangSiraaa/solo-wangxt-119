import type { MeshData } from '../model/types';

/**
 * 纯本地工程存储（IndexedDB），无后端。
 * 每个工程保存当前网格（positions/uvs 转普通数组以结构化克隆）。
 */

const DB_NAME = 'uv-inspector';
const STORE = 'projects';
const VERSION = 1;

export interface ProjectRecord {
  id: string;
  name: string;
  updatedAt: number;
  mesh: SerializedMesh;
}

export interface SerializedMesh {
  name: string;
  positions: number[];
  uvs: number[];
  faces: MeshData['faces'];
  groups?: MeshData['groups'];
}

export function serializeMesh(mesh: MeshData): SerializedMesh {
  return {
    name: mesh.name,
    positions: Array.from(mesh.positions),
    uvs: Array.from(mesh.uvs),
    faces: mesh.faces,
    groups: mesh.groups,
  };
}

export function deserializeMesh(data: SerializedMesh): MeshData {
  return {
    name: data.name,
    positions: Float64Array.from(data.positions),
    uvs: Float64Array.from(data.uvs),
    faces: data.faces,
    groups: data.groups,
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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
      }),
  );
}

export async function saveProject(id: string, name: string, mesh: MeshData): Promise<void> {
  const record: ProjectRecord = {
    id,
    name,
    updatedAt: Date.now(),
    mesh: serializeMesh(mesh),
  };
  await tx('readwrite', (s) => s.put(record));
}

export async function listProjects(): Promise<Array<{ id: string; name: string; updatedAt: number }>> {
  const all = await tx<ProjectRecord[]>('readonly', (s) => s.getAll());
  return all
    .map((r) => ({ id: r.id, name: r.name, updatedAt: r.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadProject(id: string): Promise<ProjectRecord | undefined> {
  return tx<ProjectRecord | undefined>('readonly', (s) => s.get(id));
}

export async function deleteProject(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}
