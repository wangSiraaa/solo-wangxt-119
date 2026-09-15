import * as THREE from 'three';
import type { AnalysisResult, EdgeInfo, MeshData, Selection } from '../model/types';
import { COLORS } from './visuals';
import type { HeatMode } from './ThreeView3D';

interface View2DOptions {
  onPick: (faceIds: number[], additive: boolean) => void;
}

/**
 * 二维 UV 视图：正交相机，平面世界坐标即 (u, v)。
 * - 0..1 纹理方块用棋盘背景显示，超出部分画浅格；
 * - 接缝（橙）/非流形边（紫）/翻转/重叠用边线或颜色叠加；
 * - 射线拾取同样按 faceId*3 映射稳定面身份；
 * - 左键点击选择，中键/右键或 Shift+左键平移，滚轮缩放（以光标为中心）。
 */
export class UVView2D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private mesh: THREE.Mesh | null = null;
  private seamLines: THREE.LineSegments | null = null;
  private nmLines: THREE.LineSegments | null = null;
  private overlapLines: THREE.LineSegments | null = null;
  private currentMesh: MeshData | null = null;
  private currentAnalysis: AnalysisResult | null = null;
  private selection: Selection = new Set();
  private heat: HeatMode = 'none';
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  private frame = 0;
  private ro?: ResizeObserver;

  // 视图变换：view 中心（uv 坐标）与半高
  private center = new THREE.Vector2(0.5, 0.5);
  private halfHeight = 1.1;

  private panning: false | { x: number; y: number; cx: number; cy: number } = false;

  constructor(private container: HTMLElement, private opts: View2DOptions) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x14171c, 1);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -50, 50);
    this.camera.position.z = 5;

    this.buildGrid();
    this.bindEvents();
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.animate();
  }

  // ------------------------------------------------------------------ grid
  private buildGrid(): void {
    const group = new THREE.Group();
    const mkLines = (step: number, extent: number, color: number, opacity: number) => {
      const pts: number[] = [];
      for (let v = -extent; v <= extent + 1e-6; v += step) {
        pts.push(v, -extent, 0, v, extent, 0);
        pts.push(-extent, v, 0, extent, v, 0);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
      );
      group.add(l);
    };
    mkLines(0.1, 8, 0x262b33, 0.5);
    mkLines(1, 8, 0x3a4150, 0.9);

    // 0..1 方块高亮边框
    const border = new THREE.BufferGeometry();
    border.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3),
    );
    group.add(
      new THREE.LineLoop(
        border,
        new THREE.LineBasicMaterial({ color: 0x7c8aa0 }),
      ),
    );

    // 0..1 内棋盘块（半透明）
    const cells = 8;
    const cellVerts: number[] = [];
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        if ((x + y) % 2 === 0) {
          const u0 = x / cells;
          const v0 = y / cells;
          const u1 = (x + 1) / cells;
          const v1 = (y + 1) / cells;
          cellVerts.push(u0, v0, -0.1, u1, v0, -0.1, u1, v1, -0.1);
          cellVerts.push(u0, v0, -0.1, u1, v1, -0.1, u0, v1, -0.1);
        }
      }
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cellVerts, 3));
    const cm = new THREE.MeshBasicMaterial({
      color: COLORS.checker2,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
    });
    const checker = new THREE.Mesh(cg, cm);
    checker.renderOrder = -10;
    group.add(checker);

    this.scene.add(group);
  }

  // -------------------------------------------------------------- interaction
  private bindEvents(): void {
    const el = this.renderer.domElement;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button === 1 || ev.button === 2 || (ev.button === 0 && (ev.shiftKey || ev.ctrlKey))) {
        ev.preventDefault();
        this.panning = { x: ev.clientX, y: ev.clientY, cx: this.center.x, cy: this.center.y };
        el.setPointerCapture(ev.pointerId);
      }
    });
    el.addEventListener('pointermove', (ev) => {
      if (!this.panning) return;
      const s = this.worldPerPixel();
      this.center.set(
        this.panning.cx - (ev.clientX - this.panning.x) * s,
        this.panning.cy + (ev.clientY - this.panning.y) * s,
      );
      this.updateCamera();
    });
    const endPan = () => {
      this.panning = false;
    };
    el.addEventListener('pointerup', (ev) => {
      if (this.panning) {
        endPan();
        return;
      }
      if (ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
      const rect = el.getBoundingClientRect();
      this.pointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      this.pick(ev.shiftKey || ev.ctrlKey || ev.metaKey);
    });
    el.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const before = this.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top, rect);
      const factor = ev.deltaY > 0 ? 1.12 : 1 / 1.12;
      this.halfHeight = Math.min(20, Math.max(0.02, this.halfHeight * factor));
      this.updateCamera();
      const after = this.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top, rect);
      this.center.x += before.x - after.x;
      this.center.y += before.y - after.y;
      this.updateCamera();
    }, { passive: false });
  }

  private worldPerPixel(): number {
    return (this.halfHeight * 2) / (this.container.clientHeight || 1);
  }

  private screenToWorld(x: number, y: number, rect: DOMRect): THREE.Vector2 {
    const nx = (x / rect.width) * 2 - 1;
    const ny = -((y / rect.height) * 2 - 1);
    return new THREE.Vector2(
      this.center.x + nx * this.halfHeight * (rect.width / rect.height),
      this.center.y + ny * this.halfHeight,
    );
  }

  private pick(additive: boolean): void {
    if (!this.mesh) return;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObject(this.mesh, false);
    if (hits.length === 0) {
      if (!additive) this.opts.onPick([], false);
      return;
    }
    const faceId = Math.floor(hits[0].face!.a / 3);
    this.opts.onPick([faceId], additive);
  }

  // -------------------------------------------------------------------- data
  setData(mesh: MeshData, analysis: AnalysisResult): void {
    this.currentMesh = mesh;
    this.currentAnalysis = analysis;
    this.selection = new Set();
    this.rebuild();
    this.frameContent();
  }

  setSelection(sel: Selection): void {
    this.selection = sel;
    this.updateColors();
  }

  setHeat(mode: HeatMode): void {
    this.heat = mode;
    this.updateColors();
  }

  private rebuild(): void {
    if (!this.currentMesh || !this.currentAnalysis) return;
    const mesh = this.currentMesh;
    const n = mesh.faces.length;
    const positions = new Float32Array(n * 9);
    const colors = new Float32Array(n * 9);
    mesh.faces.forEach((f, fid) => {
      for (let c = 0; c < 3; c++) {
        const ui = f.uv[c];
        positions[fid * 9 + c * 3] = mesh.uvs[ui * 2];
        positions[fid * 9 + c * 3 + 1] = mesh.uvs[ui * 2 + 1];
        positions[fid * 9 + c * 3 + 2] = 0;
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    );
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);

    this.rebuildEdgeOverlays();
    this.updateColors();
  }

  private addEdgeLayer(key: 'seamLines' | 'nmLines' | 'overlapLines', edges: EdgeInfo[] | Array<[number, number]>, color: number, opacity: number): void {
    if (this[key]) {
      this.scene.remove(this[key]!);
      this[key]!.geometry.dispose();
      this[key] = null;
    }
    if (edges.length === 0) return;
    const mesh = this.currentMesh!;
    const pts: number[] = [];

    if (key === 'overlapLines') {
      for (const [fa, fb] of edges as Array<[number, number]>) {
        for (const fid of [fa, fb]) {
          const f = mesh.faces[fid];
          for (let c = 0; c < 3; c++) {
            const u0 = f.uv[c];
            const u1 = f.uv[(c + 1) % 3];
            pts.push(mesh.uvs[u0 * 2], mesh.uvs[u0 * 2 + 1], 0.06);
            pts.push(mesh.uvs[u1 * 2], mesh.uvs[u1 * 2 + 1], 0.06);
          }
        }
      }
    } else {
      // 接缝/非流形：对每条位置边，按每个相邻面自己的 UV 角画，
      // 于是接缝天然显示成两条分开的 UV 边。
      for (const e of edges as EdgeInfo[]) {
        for (const fid of e.faces) {
          const f = mesh.faces[fid];
          // 找该面中 a,b 两个位置顶点对应的角
          const corners = [0, 1, 2].filter((c) => f.v[c] === e.a || f.v[c] === e.b);
          if (corners.length !== 2) continue;
          const ua = f.v[corners[0]] === e.a ? f.uv[corners[0]] : f.uv[corners[1]];
          const ub = f.v[corners[0]] === e.b ? f.uv[corners[0]] : f.uv[corners[1]];
          pts.push(mesh.uvs[ua * 2], mesh.uvs[ua * 2 + 1], 0.04);
          pts.push(mesh.uvs[ub * 2], mesh.uvs[ub * 2 + 1], 0.04);
        }
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    );
    lines.renderOrder = 4;
    this[key] = lines;
    this.scene.add(lines);
  }

  private rebuildEdgeOverlays(): void {
    const a = this.currentAnalysis!;
    this.addEdgeLayer('seamLines', a.edges.filter((e) => e.seam), COLORS.seam, 0.95);
    this.addEdgeLayer('nmLines', a.edges.filter((e) => e.nonManifold), COLORS.nonManifold, 1);
    this.addEdgeLayer('overlapLines', a.overlapPairs, COLORS.overlap, 0.9);
  }

  private updateColors(): void {
    if (!this.mesh || !this.currentAnalysis) return;
    const attr = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const color = new THREE.Color();
    const overlapFaces = new Set(this.currentAnalysis.overlapPairs.flat());
    const maxLog = Math.max(0.15, this.currentAnalysis.summary.maxAreaRatioLog);
    const maxAngle = Math.max(5, this.currentAnalysis.summary.maxAngleDistortion);
    for (const fm of this.currentAnalysis.faces) {
      if (this.selection.has(fm.faceId)) color.setHex(COLORS.uvSelected);
      else if (this.heat === 'area' && fm.areaRatio !== null) {
        const t = Math.abs(Math.log2(fm.areaRatio)) / maxLog;
        color.setRGB(1, 1 - t * 0.7, 1 - t);
      } else if (this.heat === 'angle' && fm.angleDistortion !== null) {
        const t = fm.angleDistortion / maxAngle;
        color.setRGB(1, 1 - t * 0.7, 1 - t);
      } else if (this.heat === 'flip') {
        color.setHex(fm.flipped ? 0xff5a4a : fm.degenerateUv ? 0x44484e : 0x5d7ea6);
      } else if (overlapFaces.has(fm.faceId)) {
        color.setHex(0xb3415f);
      } else {
        color.setHex(fm.degenerateUv || fm.degenerate3d ? 0x3a3e44 : COLORS.uvFill);
      }
      for (let c = 0; c < 3; c++) {
        attr.setXYZ(fm.faceId * 3 + c, color.r, color.g, color.b);
      }
    }
    attr.needsUpdate = true;
  }

  frameContent(): void {
    if (!this.currentMesh) return;
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < this.currentMesh.uvs.length; i += 2) {
      minU = Math.min(minU, this.currentMesh.uvs[i]);
      maxU = Math.max(maxU, this.currentMesh.uvs[i]);
      minV = Math.min(minV, this.currentMesh.uvs[i + 1]);
      maxV = Math.max(maxV, this.currentMesh.uvs[i + 1]);
    }
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const aspect = w / h;
    const widthU = Math.max(maxU - minU, 0.001);
    const heightU = Math.max(maxV - minV, 0.001);
    this.halfHeight = Math.max(heightU / 2, widthU / aspect / 2) * 1.25;
    this.center.set((minU + maxU) / 2, (minV + maxV) / 2);
    this.updateCamera();
  }

  frameUnit(): void {
    this.center.set(0.5, 0.5);
    this.halfHeight = 0.75;
    this.updateCamera();
  }

  private updateCamera(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const aspect = w / h;
    this.camera.left = this.center.x - this.halfHeight * aspect;
    this.camera.right = this.center.x + this.halfHeight * aspect;
    this.camera.top = this.center.y + this.halfHeight;
    this.camera.bottom = this.center.y - this.halfHeight;
    this.camera.updateProjectionMatrix();
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.updateCamera();
  }

  private animate = (): void => {
    this.frame = requestAnimationFrame(this.animate);
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.ro?.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
