import type { MeshData } from '../model/types';
import { analyzeMesh } from '../analysis/analyze';
import { ensurePerCornerUVs } from '../model/uvfix';
import { createGraph, makeSummary, type Revision, type RevisionGraph } from '../model/revisions';
import type { ProjectRecordV2 } from '../io/storage';

/** v1 记录的最小结构（读取旧工程时使用）。 */
interface V1Record {
  id: string;
  name: string;
  updatedAt: number;
  mesh?: {
    name: string;
    positions: number[];
    uvs: number[];
    faces: MeshData['faces'];
    groups?: MeshData['groups'];
  };
  version?: number;
  graph?: RevisionGraph;
}

/**
 * 防御性 v1 -> v2 迁移（正常在 IndexedDB onupgradeneeded 内完成；
 * 此处在读到一条未带 version=2 的记录时兜底）。
 */
export function migrateV1Record(rec: V1Record): {
  graph: RevisionGraph;
  name: string;
} | null {
  if (rec.version === 2 && rec.graph) {
    return { graph: rec.graph, name: rec.name };
  }
  if (!rec.mesh) return null;
  const mesh: MeshData = {
    name: rec.mesh.name,
    positions: Float64Array.from(rec.mesh.positions),
    uvs: Float64Array.from(rec.mesh.uvs),
    faces: rec.mesh.faces,
    groups: rec.mesh.groups,
  };
  const prepared = ensurePerCornerUVs(mesh);
  const analysis = analyzeMesh(prepared);
  const root: Revision = {
    id: crypto.randomUUID(),
    parentId: null,
    kind: 'import',
    label: `导入 ${prepared.name}（从旧版工程迁移）`,
    createdAt: rec.updatedAt,
    seq: 0,
    mesh: prepared,
    summary: makeSummary(prepared, analysis),
  };
  return { graph: createGraph(root), name: rec.name };
}

export type { ProjectRecordV2 };
