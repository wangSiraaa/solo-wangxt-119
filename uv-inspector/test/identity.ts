import { parseOBJ, writeOBJ } from '../src/io/obj';
import { analyzeMesh } from '../src/analysis/analyze';
import { ensurePerCornerUVs } from '../src/model/uvfix';

// 同一坐标写了两次 v（id 0 和 id 2 完全相同），两个三角形各用一个身份。
// 按坐标焊接的加载器会把它们合并，本工具不能。
const obj = `
v 0 0 0
v 1 0 0
v 0 0 0
v 1 0 1
vt 0 0
vt 1 0
vt 0 1
vt 0.2 0.2
vt 0.8 0.2
vt 0.2 0.8
f 1/1 2/2 4/3
f 3/4 2/5 4/6
`;

const { mesh, warnings } = parseOBJ(obj, 'dup.obj');
console.log('warnings:', warnings);
console.log('position vertices (expect 4, no spatial merge):', mesh.positions.length / 3);
console.log('uv vertices:', mesh.uvs.length / 2);
console.log('faces:', mesh.faces.length);
console.log('face0 v ids:', mesh.faces[0].v.join(','), '(expect 0,1,3)');
console.log('face1 v ids:', mesh.faces[1].v.join(','), '(expect 2,1,3 - duplicate identity kept)');

const pre = ensurePerCornerUVs(mesh);
const r = analyzeMesh(pre);
// 两个三角形位置顶点身份不同（0 vs 2），所以 0-4 / 2-4 / 0-1 / 2-1 都是边界边
// —— 坐标相同但拓扑不连通，正说明没有按空间位置合并。
// 拓扑：边 1-3 两侧面共享（UV 不同 -> 接缝，2 面非边界）；顶点 0、2 坐标相同但
// 身份不同，所以 0-1/0-3 与 2-1/2-3 是两组独立边界边——共 4 边界 + 1 接缝，
// 这正是"未按空间坐标焊接"的拓扑特征。
const nm = r.edges.filter((e) => e.nonManifold).length;
const boundary = r.edges.filter((e) => e.boundary).length;
console.log('nonManifold edges:', nm, 'boundary edges:', boundary);
console.log(boundary === 4 && r.summary.seamEdgeCount === 1 ? 'PASS - 同坐标不同身份未被空间焊接' : 'CHECK - 边分类');

// 接缝：两个面共享位置边 1-3（id），但 UV 不同 -> 1 接缝
console.log('seams (expect 1):', r.summary.seamEdgeCount);

// roundtrip
const out = writeOBJ(mesh);
const again = parseOBJ(out).mesh;
console.log('roundtrip positions:', again.positions.length / 3, 'faces:', again.faces.length);

// 负索引 OBJ
const neg = `
v 0 0 0
v 1 0 0
v 0 0 1
vt 0 0
vt 1 0
vt 0 1
f -3/-3 -2/-2 -1/-1
`;
const { mesh: nm2 } = parseOBJ(neg);
console.log('negative-index face v ids:', nm2.faces[0].v.join(','), 'uv:', nm2.faces[0].uv.join(','));
