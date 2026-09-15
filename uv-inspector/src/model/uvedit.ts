import type { MeshData } from './types';

/** 收集与给定面集合通过共享 UV 顶点连通的所有 UV 顶点（即所属 UV 岛）。 */
export function islandUvVertices(mesh: MeshData, seedFaces: Iterable<number>): Set<number> {
  const seeds = new Set<number>();
  for (const f of seedFaces) {
    const tri = mesh.faces[f];
    seeds.add(tri.uv[0]);
    seeds.add(tri.uv[1]);
    seeds.add(tri.uv[2]);
  }
  if (seeds.size === 0) return new Set();

  const visited = new Set<number>(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const tri of mesh.faces) {
      const uvs = [tri.uv[0], tri.uv[1], tri.uv[2]];
      if (uvs.some((u) => visited.has(u))) {
        for (const u of uvs) {
          if (!visited.has(u)) {
            visited.add(u);
            changed = true;
          }
        }
      }
    }
  }
  return visited;
}

/**
 * 镜像 UV 岛：沿岛自身包围盒的竖直中线翻转 U（不触碰岛外 UV）。
 * 只改坐标，不改 UV 顶点身份——接缝关系保持不变，翻转后该岛会被分析标为 mirrored。
 */
export function mirrorIslandsU(mesh: MeshData, seedFaces: Iterable<number>): MeshData {
  const verts = islandUvVertices(mesh, seedFaces);
  if (verts.size === 0) return mesh;

  let minU = Infinity;
  let maxU = -Infinity;
  for (const u of verts) {
    minU = Math.min(minU, mesh.uvs[u * 2]);
    maxU = Math.max(maxU, mesh.uvs[u * 2]);
  }
  const mid = (minU + maxU) / 2;
  const uvs = Float64Array.from(mesh.uvs);
  for (const u of verts) {
    uvs[u * 2] = 2 * mid - uvs[u * 2];
  }
  return { ...mesh, uvs };
}

/** 把给定面所属的岛整体平移（用于手动整理重叠）。 */
export function translateIslands(mesh: MeshData, seedFaces: Iterable<number>, du: number, dv: number): MeshData {
  const verts = islandUvVertices(mesh, seedFaces);
  if (verts.size === 0) return mesh;
  const uvs = Float64Array.from(mesh.uvs);
  for (const u of verts) {
    uvs[u * 2] += du;
    uvs[u * 2 + 1] += dv;
  }
  return { ...mesh, uvs };
}

/**
 * 修正选中岛的翻转绕序：沿岛自身竖直中线镜像 U。
 * 仅作用于这些岛，其它 UV 与所有身份不变。
 */
export function fixFlippedIslands(mesh: MeshData, seedFaces: Iterable<number>): MeshData {
  return mirrorIslandsU(mesh, seedFaces);
}
