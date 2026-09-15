import { parseOBJ } from '../src/io/obj';
import { analyzeMesh } from '../src/analysis/analyze';
import { readFileSync } from 'fs';

// 浏览器实际下载的镜像岛样例 OBJ
const text = readFileSync('/tmp/downloads/mirror-island-seam-uv.obj', 'utf8');
const { mesh, warnings } = parseOBJ(text);
const r = analyzeMesh(mesh);
const mirrored = r.islands.map((i) => i.mirrored).join(',');
console.log(
  'flipped(期望2):', r.summary.flipped,
  'islands(期望2):', r.summary.islandCount,
  'seams(期望1):', r.summary.seamEdgeCount,
  'flags(期望 false,true):', mirrored,
);
const ok =
  warnings.length === 0 &&
  r.summary.flipped === 2 &&
  r.summary.islandCount === 2 &&
  r.summary.seamEdgeCount === 1 &&
  mirrored === 'false,true';
console.log(ok ? 'PASS - 浏览器导出的镜像岛 OBJ 往返分类一致' : 'FAIL');
process.exit(ok ? 0 : 1);
