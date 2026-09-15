import * as THREE from 'three';

export const COLORS = {
  faceBase: 0x9fb4c8,
  selected: 0xffc83d,
  wire: 0x2a3440,
  uvFill: 0x5d7ea6,
  uvSelected: 0xffc83d,
  seam: 0xff6b4a,
  nonManifold: 0xd034ff,
  boundary: 0x8a94a0,
  overlap: 0xff3b6b,
  islandNormal: 0x4fc3f7,
  islandMirrored: 0xff7676,
  checker1: 0xffffff,
  checker2: 0x262a30,
};

/** 生成 N×N 棋盘纹理（默认 8 格），用于直观发现拉伸/翻转。 */
export function makeCheckerTexture(repeats = 8, size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const cells = repeats;
  const cell = size / cells;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ix = Math.floor(x / cell);
      const iy = Math.floor(y / cell);
      const dark = (ix + iy) % 2 === 0;
      const i = (y * size + x) * 4;
      // 亮格中性白，暗格深蓝灰——在网格上也能看出数字方向
      data[i] = dark ? 38 : 245;
      data[i + 1] = dark ? 42 : 245;
      data[i + 2] = dark ? 48 : 240;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 面积/角度畸变热力色：0（无畸变，绿）→ 1（严重，红）。
 */
export function heatColor(t: number, target: THREE.Color): THREE.Color {
  const x = Math.min(1, Math.max(0, t));
  // green #2ecc71 -> yellow #f1c40f -> red #e74c3c
  if (x < 0.5) {
    target.setRGB(0.18 + (x / 0.5) * (0.95 - 0.18), 0.8, 0.26);
  } else {
    target.setRGB(0.95, 0.8 - ((x - 0.5) / 0.5) * (0.8 - 0.3), 0.19 - ((x - 0.5) / 0.5) * 0.04);
  }
  return target;
}

export function flipColor(flipped: boolean, target: THREE.Color): THREE.Color {
  return target.setHex(flipped ? 0xff5a4a : 0x62a9ff);
}
