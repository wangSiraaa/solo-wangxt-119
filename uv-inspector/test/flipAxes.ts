import { MeshBuilder } from '../src/model/builder';
import { analyzeMesh } from '../src/analysis/analyze';
import type { MeshData, Vec3 } from '../src/model/types';

/**
 * 绕序契约：**从面外侧观察**，几何面与 UV 绕序一致即正常，相反即镜像翻转。
 *
 * 对法线沿 ±X / ±Y / ±Z 的单面：
 *  - 3D 三角形绕序朝外（叉积 = sign·e_axis）；
 *  - 投影到垂直法线的"外侧屏幕"平面，其有符号面积符号：主轴为 + 时为正、为 − 时为负；
 *  - 正常 UV 直接取该屏幕投影坐标 -> UV 有符号面积与屏幕同号（负轴面就是**负面积正常**）；
 *  - 镜像 UV 反射 u -> UV 有符号面积取反，与屏幕异号。
 *
 * 旧实现 detUv<0 会把三个负轴面的正常 UV 各计 1 个翻转（本文件先复现它）。
 */

/** 主导轴 -> 屏幕平面的 (水平 p, 竖直 q) 世界轴，要求 e_p × e_q = +e_axis（右手）。 */
const SCREEN_AXES: Record<number, [number, number]> = {
  0: [1, 2], // X: y×z = x
  1: [2, 0], // Y: z×x = y
  2: [0, 1], // Z: x×y = z
};

function buildFace(axis: 0 | 1 | 2, sign: 1 | -1, mirrored: boolean): MeshData {
  const b = new MeshBuilder();
  const [p, q] = SCREEN_AXES[axis];

  // 单个三角形：屏幕 (p,q) 上取逆时针三个点
  const pqBase: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
  ];
  // sign=- 时在 (p,q) 平面镜像，使几何叉积（右手 e_p×e_q=+e_axis）指向 -axis
  const pq = pqBase.map(([sp, sq]) => (sign > 0 ? [sp, sq] : [sq, sp]) as [number, number]);

  const to3 = (sp: number, sq: number): Vec3 => {
    const v: Vec3 = [0, 0, 0];
    v[axis] = sign * 0.5;
    v[p] = sp - 0.5;
    v[q] = sq - 0.5;
    return v;
  };

  const ids = pq.map(([sp, sq]) => b.addPosV(to3(sp, sq)));

  // 正常 UV：u,v 取该面的外侧屏幕 (p,q) 坐标（与屏幕绕序同号）；
  // 镜像：沿 u 反射（绕序取反）。
  const uvIds = pq.map(([sp, sq]) => b.addUv(mirrored ? -sp : sp, sq));

  b.tri([ids[0], uvIds[0]], [ids[1], uvIds[1]], [ids[2], uvIds[2]]);

  const mesh = b.build(`face-${'XYZ'[axis]}${sign > 0 ? '+' : '-'}-${mirrored ? 'mirror' : 'normal'}`);

  // 自检：几何叉积必须指向外侧 sign·e_axis
  const f = mesh.faces[0];
  const P = (vi: number): Vec3 => [mesh.positions[vi * 3], mesh.positions[vi * 3 + 1], mesh.positions[vi * 3 + 2]];
  const A = P(f.v[0]); const B = P(f.v[1]); const C = P(f.v[2]);
  const e1: Vec3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const e2: Vec3 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
  const n: Vec3 = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  if (Math.sign(n[axis]) !== sign) {
    throw new Error(`构造错误：axis=${axis} sign=${sign} 几何叉积未朝外`);
  }
  // 外侧屏幕投影有符号面积：取各顶点的 (p,q) 分量（右手对 e_p×e_q=+e_axis）。
  // 主轴朝 + 时应为正、朝 − 时应为负（这正是"负面积正常绕序"的几何来源）。
  const s = (vi: number, ax: number) => mesh.positions[vi * 3 + ax];
  const cross2 = (i: number, j: number, k: number) =>
    (s(ids[j], p) - s(ids[i], p)) * (s(ids[k], q) - s(ids[i], q)) -
    (s(ids[k], p) - s(ids[i], p)) * (s(ids[j], q) - s(ids[i], q));
  const screenArea = cross2(0, 1, 2);
  if (Math.sign(screenArea) !== sign) {
    throw new Error(
      `构造错误：朝 ${sign > 0 ? '+' : '-'}${'XYZ'[axis]} 的外侧屏幕投影符号应为 ${sign}，实际 ${Math.sign(screenArea)}`,
    );
  }
  return mesh;
}

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) failures++;
};

const axes: Array<[0 | 1 | 2, string]> = [
  [0, 'X'], [1, 'Y'], [2, 'Z'],
];
for (const [axis, label] of axes) {
  for (const sign of [1, -1] as const) {
    const s = sign > 0 ? '+' : '-';

    const normal = analyzeMesh(buildFace(axis, sign, false));
    // 负轴正常面是"负面积正常绕序"：期望 0 翻转。
    check(
      normal.summary.flipped === 0,
      `朝 ${s}${label} 单面 + 正常 UV（屏幕${sign > 0 ? '正' : '负'}面积同号）：0 翻转（实际 ${normal.summary.flipped}）`,
    );
    check(
      normal.islands[0]?.mirrored === false,
      `朝 ${s}${label} 正常面不标 mirrored`,
    );

    const mirror = analyzeMesh(buildFace(axis, sign, true));
    check(
      mirror.summary.flipped === 1,
      `朝 ${s}${label} 单面 + 镜像 UV：1 面检出翻转（实际 ${mirror.summary.flipped}）`,
    );
    check(
      mirror.islands[0]?.mirrored === true,
      `朝 ${s}${label} 镜像面标 mirrored`,
    );
  }
}

process.exit(failures > 0 ? 1 : 0);
