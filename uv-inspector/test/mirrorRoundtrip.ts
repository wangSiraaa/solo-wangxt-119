import { parseOBJ, writeOBJ } from '../src/io/obj';
import { analyzeMesh } from '../src/analysis/analyze';
import { SAMPLES } from '../src/samples/samples';

// 镜像岛样例：导出 OBJ -> 重新解析，分类必须保持一致
const mirror = SAMPLES.find((s) => s.id === 'mirror')!.build();
const r1 = analyzeMesh(mirror);
const text = writeOBJ(mirror);
const { mesh, warnings } = parseOBJ(text);
const r2 = analyzeMesh(mesh);
const m2 = r2.islands.map((i) => i.mirrored).join(',');

console.log('warnings:', JSON.stringify(warnings));
console.log('before:', r1.summary.flipped, 'flips', r1.islands.length, 'islands', r1.summary.seamEdgeCount, 'seams');
console.log('after: ', r2.summary.flipped, 'flips', r2.islands.length, 'islands', r2.summary.seamEdgeCount, 'seams', m2);
const ok =
  warnings.length === 0 &&
  r2.summary.flipped === 2 &&
  r2.summary.islandCount === 2 &&
  r2.summary.seamEdgeCount === 1 &&
  m2 === 'false,true';
console.log(ok ? 'PASS - 镜像岛样例 OBJ 导出往返分类一致' : 'FAIL');
process.exit(ok ? 0 : 1);
