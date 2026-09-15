import { SAMPLES } from '../src/samples/samples';
import { analyzeMesh } from '../src/analysis/analyze';
import { ensurePerCornerUVs } from '../src/model/uvfix';

for (const s of SAMPLES) {
  const mesh = ensurePerCornerUVs(s.build());
  const r = analyzeMesh(mesh);
  const sum = r.summary;
  console.log('==', s.id, mesh.faces.length, 'faces,', sum.islandCount, 'islands');
  console.log('  flipped:', sum.flipped, 'degenerate3d:', sum.degenerate3d, 'degenerateUv:', sum.degenerateUv);
  console.log('  seams:', sum.seamEdgeCount, 'nonManifold:', sum.nonManifoldEdgeCount, 'overlapFaces:', sum.overlappingFaces);
  console.log('  island mirrored:', r.islands.map((i) => i.mirrored).join(','));
  console.log('  maxAngle:', sum.maxAngleDistortion.toFixed(2), 'meanAngle:', sum.meanAngleDistortion.toFixed(2), 'maxLog2Ratio:', sum.maxAreaRatioLog.toFixed(2));
  const nonDeg = r.faces.filter((f) => f.areaRatio !== null).length;
  console.log('  nonDeg with ratio:', nonDeg, '/', r.faces.length);
  const nm = r.edges.filter((e) => e.nonManifold).map((e) => `${e.a}-${e.b}x${e.faces.length}`);
  console.log('  NM edges:', nm.join(' '));
}
