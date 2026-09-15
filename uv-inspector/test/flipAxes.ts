import { MeshBuilder } from '../src/model/builder';
import { analyzeMesh } from '../src/analysis/analyze';
import type { MeshData } from '../src/model/types';

/**
 * 朝 -X / -Y / -Z 的面：正常 UV（雅可比 det>0，不应翻转）
 * 与镜像 UV（det<0，必须检出）。
 *
 * 关键：这些面的几何法线指向负轴。旧实现把主轴投影面积与同一法线分量相乘，
 * 得到恒正基准，会把"正常但朝负轴"的面误判；这里回归验证新的轴无关判据。
 */

const EPS_LOCAL = 1e-9;

/** 直接用数值坐标建一个朝指定轴的四边形，返回带正常 UV 的网格。 */
function buildQuad(axis: 0 | 1 | 2, sign: 1 | -1, mirrored: boolean): MeshData {
  const b = new MeshBuilder();
  const tangents: [number, number] =
    axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1];
  const [t1, t2] = tangents;

  const at = (a: number, c: number): [number, number, number] => {
    const v: [number, number, number] = [0, 0, 0];
    v[axis] = sign * 0.5;
    v[t1] = a - 0.5;
    v[t2] = c - 0.5;
    return v;
  };

  // 先按"法线朝 +axis"的几何 CCW 顺序构造角点
  const pts = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
  // 计算 (p0,p1,p2) 的法线分量；若与期望 sign 相反，则把顺序反转
  const n = crossAxis(pts[0], pts[1], pts[2], axis);
  const order = Math.sign(n) === sign ? [0, 1, 2, 3] : [0, 2, 1, 3];
  const ids = order.map((idx) => b.addPosV(pts[idx]));

  // 正常 UV 与角点同向；镜像 UV 把两列 u 对调（det<0）
  const uvNormal: Array<[number, number]> = [
    [0, 0], [1, 0], [1, 1], [0, 1],
  ];
  const uvMirror: Array<[number, number]> = [
    [1, 0], [0, 0], [0, 1], [1, 1],
  ];
  const uv = mirrored ? uvMirror : uvNormal;
  const u = uv.map((q) => b.addUvV(q));

  b.tri([ids[0], u[0]], [ids[1], u[1]], [ids[2], u[2]]);
  b.tri([ids[0], u[0]], [ids[2], u[2]], [ids[3], u[3]]);

  const mesh = b.build(`axis-${axis}-${sign}-${mirrored ? 'mirror' : 'normal'}`);

  // 自检：法线分量方向
  const nn = crossAxis2(mesh, 0, axis);
  if (Math.abs(Math.sign(nn) - sign) > EPS_LOCAL) {
    throw new Error(`构造法线错误 axis=${axis} sign=${sign} got=${nn}`);
  }
  return mesh;
}

function crossAxis(a: number[], b: number[], c: number[], axis: number): number {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  return n[axis];
}
function crossAxis2(m: MeshData, fid: number, axis: number): number {
  const f = m.faces[fid];
  const P = (vi: number) => [m.positions[vi * 3], m.positions[vi * 3 + 1], m.positions[vi * 3 + 2]];
  return crossAxis(P(f.v[0]), P(f.v[1]), P(f.v[2]), axis);
}

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) failures++;
};

// 六个负轴/正轴朝向 × 正常/镜像
const axes: Array<[0 | 1 | 2, string]> = [
  [0, 'X'], [1, 'Y'], [2, 'Z'],
];
for (const [axis, label] of axes) {
  for (const sign of [1, -1] as const) {
    const sLabel = sign > 0 ? '+' : '-';
    const normal = analyzeMesh(buildQuad(axis, sign, false));
    check(
      normal.summary.flipped === 0,
      `朝 ${sLabel}${label} 的面 + 正常 UV：0 翻转（实际 ${normal.summary.flipped}）`,
    );
    const mirror = analyzeMesh(buildQuad(axis, sign, true));
    check(
      mirror.summary.flipped === 2,
      `朝 ${sLabel}${label} 的面 + 镜像 UV：2 面全部检出翻转（实际 ${mirror.summary.flipped}）`,
    );
    check(
      mirror.islands[0]?.mirrored === true,
      `朝 ${sLabel}${label} 的镜像 UV 岛被标为 mirrored`,
    );
  }
}

// 混合：一个网格里同时放 -Z 正常面与 -Z 镜像面（两个独立 UV 岛）
{
  const a = buildQuad(2, -1, false);
  const bMesh = buildQuad(2, -1, true);
  // 手工合并成一个 MeshData（偏移 id）
  const positions = new Float64Array(a.positions.length + bMesh.positions.length);
  positions.set(a.positions, 0);
  positions.set(bMesh.positions, a.positions.length);
  const uvs = new Float64Array(a.uvs.length + bMesh.uvs.length);
  uvs.set(a.uvs, 0);
  uvs.set(bMesh.uvs, a.uvs.length);
  const vOff = a.positions.length / 3;
  const uvOff = a.uvs.length / 2;
  const faces = [
    ...a.faces,
    ...bMesh.faces.map((f) => ({
      ...f,
      v: [f.v[0] + vOff, f.v[1] + vOff, f.v[2] + vOff] as [number, number, number],
      uv: [f.uv[0] + uvOff, f.uv[1] + uvOff, f.uv[2] + uvOff] as [number, number, number],
    })),
  ];
  const mixed: MeshData = { name: 'mixed', positions, uvs, faces };
  const r = analyzeMesh(mixed);
  check(r.summary.flipped === 2, `混合网格：仅镜像岛 2 面翻转（实际 ${r.summary.flipped}）`);
  check(r.islands.length === 2, `混合网格：2 个独立 UV 岛（实际 ${r.islands.length}）`);
  const mirroredCount = r.islands.filter((i) => i.mirrored).length;
  check(mirroredCount === 1, `混合网格：恰 1 个镜像岛（实际 ${mirroredCount}）`);
}

process.exit(failures > 0 ? 1 : 0);
