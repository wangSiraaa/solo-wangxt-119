import { analyzeMesh } from '../src/analysis/analyze';
import { mirrorIslandsU } from '../src/model/uvedit';
import type { MeshData, Vec3 } from '../src/model/types';
import { MeshBuilder } from '../src/model/builder';

/**
 * 负轴负面积岛的翻转修正：镜像 U 必须让异号变同号，
 * 而不是把正常负面积岛误"修"成翻转。验证 fixAllFlippedIslands 依赖的性质。
 */
function face(axis: 0 | 1 | 2, sign: 1 | -1, mirrored: boolean): MeshData {
  const b = new MeshBuilder();
  const [ip, iq] = axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1];
  // sign=- 时交换后两个角，使几何叉积指向 -axis（从负轴外侧 CCW）
  const pq: Array<[number, number]> = sign > 0
    ? [[0, 0], [1, 0], [0, 1]]
    : [[0, 0], [0, 1], [1, 0]];
  const to3 = (sp: number, sq: number): Vec3 => {
    const v: Vec3 = [0, 0, 0];
    v[axis] = sign * 0.5;
    v[ip] = sp - 0.5;
    v[iq] = sq - 0.5;
    return v;
  };
  const ids = pq.map(([sp, sq]) => b.addPosV(to3(sp, sq)));
  const uvIds = pq.map(([sp, sq]) => b.addUv(mirrored ? 1 - sp : sp, sq));
  b.tri([ids[0], uvIds[0]], [ids[1], uvIds[1]], [ids[2], uvIds[2]]);
  return b.build('face');
}

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) failures++;
};

for (const axis of [0, 1, 2] as const) {
  const label = 'XYZ'[axis];

  // 正常负轴岛：0 翻转；镜像 U 一次变翻转；再镜像回 0（修正可逆）
  const normal = face(axis, -1, false);
  check(analyzeMesh(normal).summary.flipped === 0, `朝 -${label} 正常岛：0 翻转`);
  const once = mirrorIslandsU(normal, [0]);
  check(analyzeMesh(once).summary.flipped === 1, `朝 -${label} 正常岛镜像一次：变翻转`);
  const twice = mirrorIslandsU(once, [0]);
  check(analyzeMesh(twice).summary.flipped === 0, `朝 -${label} 再镜像：恢复正常`);

  // 镜像负轴岛：1 翻转；镜像 U 修正后归 0（fixAllFlippedIslands 依赖此性质）
  const bad = face(axis, -1, true);
  check(analyzeMesh(bad).summary.flipped === 1, `朝 -${label} 镜像岛：1 翻转`);
  check(analyzeMesh(mirrorIslandsU(bad, [0])).summary.flipped === 0, `朝 -${label} 镜像岛镜像修正：归 0`);
}

process.exit(failures > 0 ? 1 : 0);
