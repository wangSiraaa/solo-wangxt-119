import { validateUnwrapSize } from '../src/xatlas/unwrap';
import type { MeshData } from '../src/model/types';

// 超大网格必须在触碰 WASM 之前被拒绝，且不修改输入（UI 据此保留原模型）。
const faces = [];
for (let i = 0; i < 30000; i++) {
  faces.push({ v: [i * 3, i * 3 + 1, i * 3 + 2], uv: [i * 3, i * 3 + 1, i * 3 + 2], sourceFace: i });
}
const mesh: MeshData = {
  name: 'huge',
  positions: new Float64Array(90000 * 3),
  uvs: new Float64Array(90000 * 2),
  faces,
};
const before = mesh.faces.length;
try {
  validateUnwrapSize(mesh);
  console.log('FAIL - 应当拒绝超大网格');
} catch (e) {
  console.log('PASS - 拒绝:', /65535/.test((e as Error).message), '| 原模型不变:', mesh.faces.length === before);
}
