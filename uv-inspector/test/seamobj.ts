import { parseOBJ } from '../src/io/obj';
import { analyzeMesh } from '../src/analysis/analyze';

// 两个三角形共享位置边 1-3，但接缝两侧使用不同 vt（每三角形 3 个独立 UV）。
const text = `
v 0 0 0
v 1 0 0
v 1 0 1
v 0 0 1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vt 0.2 0.2
vt 0.8 0.2
vt 0.8 0.8
vt 0.2 0.8
f 1/1 2/2 3/3
f 1/5 4/8 3/7
`;
const { mesh, warnings } = parseOBJ(text);
console.log('warnings:', warnings);
const r = analyzeMesh(mesh);
console.log('seams:', r.summary.seamEdgeCount, '(expect 1)');
console.log('overlaps:', r.summary.overlappingFaces, '(expect 0)');
console.log('uv vertices:', mesh.uvs.length / 2, '(expect 12)');
const f0 = mesh.faces[0];
const f1 = mesh.faces[1];
const a = [f0.uv[0], f0.uv[2]].sort().join(',');
const b = [f1.uv[0], f1.uv[2]].sort().join(',');
console.log('seam side A uv:', a, 'side B uv:', b, a !== b ? 'PASS - 接缝两侧不同 UV 身份' : 'FAIL');
