import type { MeshData } from './types';

/**
 * 为缺少 UV 的面角补齐 UV：每个缺 UV 的角点都获得一个**独立的新 UV 顶点**
 * （沿用平面投影的坐标），绝不与其它角点共享——保证接缝身份不被隐式焊接。
 * 若所有面角都已有 UV，则原样返回。
 */
export function ensurePerCornerUVs(mesh: MeshData): MeshData {
  const needs = mesh.faces.some((f) => f.uv.some((u) => u < 0));
  if (!needs) return mesh;

  // 包围盒，用于把平面投影归一化到 0..1
  const p = mesh.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
    minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
  }
  const sx = Math.max(EPS_LOCAL, maxX - minX);
  const sy = Math.max(EPS_LOCAL, maxY - minY);
  const sz = Math.max(EPS_LOCAL, maxZ - minZ);

  // 选最"扁平"的方向做投影轴，与分析里的朝向基准则无关（这里只是给个可用初值）
  const axes: Array<[number, number, number]> = [
    [sx, 0, 1], [sy, 1, 2], [sz, 2, 0],
  ];
  axes.sort((a, b) => a[0] - b[0]);
  const [, ai, bi] = axes[0];
  const sa = [sx, sy, sz][ai];
  const sb = [sx, sy, sz][bi];
  const mia = [minX, minY, minZ][ai];
  const mib = [minX, minY, minZ][bi];

  const uv = Array.from(mesh.uvs);
  const faces = mesh.faces.map((f) => {
    const nuv = [...f.uv] as [number, number, number];
    for (let c = 0; c < 3; c++) {
      if (nuv[c] >= 0) continue;
      const vi = f.v[c];
      const ua = (p[vi * 3 + ai] - mia) / sa;
      const ub = (p[vi * 3 + bi] - mib) / sb;
      nuv[c] = uv.length / 2;
      uv.push(ua, ub); // 每个角点独立 UV 顶点
    }
    return { ...f, uv: nuv };
  });

  return { ...mesh, uvs: Float64Array.from(uv), faces };
}

const EPS_LOCAL = 1e-8;
