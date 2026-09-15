import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { AnalysisResult, MeshData, Selection } from '../model/types';
import { COLORS, makeCheckerTexture } from './visuals';

export type HeatMode = 'none' | 'area' | 'angle' | 'flip';

export interface View3DOptions {
  onPick: (faceIds: number[], additive: boolean) => void;
}

/**
 * 3D 模型视图。
 * 采用**非索引逐三角几何体**：每个三角形独立 3 个顶点，
 * 这样：
 *  - 面颜色 / 射线拾取结果通过 (vertexIndex/3) 直接映射稳定面 id；
 *  - 接缝两侧顶点本来就是不同角点，无需也不会被焊接。
 */
export class ThreeView3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private wire: THREE.LineSegments | null = null;
  private checker: THREE.DataTexture;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private currentMesh: MeshData | null = null;
  private currentAnalysis: AnalysisResult | null = null;
  private selection: Selection = new Set();
  private heat: HeatMode = 'none';
  private showChecker = true;
  private frame = 0;
  private ro?: ResizeObserver;

  constructor(private container: HTMLElement, private opts: View3DOptions) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x1b1f26, 1);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(2.2, 1.6, 2.6);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30363f, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(3, 5, 4);
    this.scene.add(dir);

    const grid = new THREE.GridHelper(10, 40, 0x39404b, 0x2a2f38);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);

    this.checker = makeCheckerTexture(8, 256);

    this.bindEvents();
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.animate();
  }

  private bindEvents(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      this.dragged = false;
    });
    el.addEventListener('pointermove', () => {
      this.dragged = true;
    });
    el.addEventListener('pointerup', (ev) => {
      if (this.dragged) return;
      const rect = el.getBoundingClientRect();
      this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      this.pick(ev.shiftKey || ev.ctrlKey || ev.metaKey);
    });
  }

  private dragged = false;

  private pick(additive: boolean): void {
    if (!this.mesh || !this.currentMesh) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.mesh, false);
    if (hits.length === 0) {
      if (!additive) this.opts.onPick([], false);
      return;
    }
    const faceId = Math.floor((hits[0].face!.a) / 3);
    this.opts.onPick([faceId], additive);
  }

  setData(mesh: MeshData, analysis: AnalysisResult): void {
    this.currentMesh = mesh;
    this.currentAnalysis = analysis;
    this.selection = new Set();
    this.rebuild();
    this.frameView();
  }

  setSelection(sel: Selection): void {
    this.selection = sel;
    this.updateColors();
  }

  setHeat(mode: HeatMode): void {
    this.heat = mode;
    this.updateColors();
  }

  setChecker(on: boolean): void {
    this.showChecker = on;
    if (this.mesh) {
      const mat = this.mesh.material as THREE.MeshStandardMaterial;
      mat.map = on ? this.checker : null;
      mat.needsUpdate = true;
    }
  }

  private rebuild(): void {
    if (!this.currentMesh || !this.currentAnalysis) return;
    const mesh = this.currentMesh;
    const n = mesh.faces.length;

    const positions = new Float32Array(n * 9);
    const uvs = new Float32Array(n * 6);
    const colors = new Float32Array(n * 9);
    const wirePos: number[] = [];

    mesh.faces.forEach((f, fid) => {
      const o3 = fid * 9;
      const o2 = fid * 6;
      for (let c = 0; c < 3; c++) {
        const vi = f.v[c];
        positions[o3 + c * 3] = mesh.positions[vi * 3];
        positions[o3 + c * 3 + 1] = mesh.positions[vi * 3 + 1];
        positions[o3 + c * 3 + 2] = mesh.positions[vi * 3 + 2];
        const ui = f.uv[c];
        uvs[o2 + c * 2] = mesh.uvs[ui * 2];
        uvs[o2 + c * 2 + 1] = mesh.uvs[ui * 2 + 1];
      }
      // 线框：三个半边（接缝会自然显示为双线）
      for (let c = 0; c < 3; c++) {
        const va = f.v[c];
        const vb = f.v[(c + 1) % 3];
        wirePos.push(
          mesh.positions[va * 3], mesh.positions[va * 3 + 1], mesh.positions[va * 3 + 2],
          mesh.positions[vb * 3], mesh.positions[vb * 3 + 1], mesh.positions[vb * 3 + 2],
        );
      }
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this.showChecker ? this.checker : null,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.mesh);

    if (this.wire) {
      this.scene.remove(this.wire);
      this.wire.geometry.dispose();
    }
    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute('position', new THREE.Float32BufferAttribute(wirePos, 3));
    this.wire = new THREE.LineSegments(
      wgeo,
      new THREE.LineBasicMaterial({ color: COLORS.wire }),
    );
    this.scene.add(this.wire);

    this.updateColors();
  }

  private updateColors(): void {
    if (!this.mesh || !this.currentAnalysis) return;
    const attr = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const color = new THREE.Color();
    const { faces } = this.currentAnalysis;
    const maxLog = Math.max(0.15, this.currentAnalysis.summary.maxAreaRatioLog);
    const maxAngle = Math.max(
      5,
      this.currentAnalysis.summary.maxAngleDistortion,
    );
    faces.forEach((fm) => {
      if (this.selection.has(fm.faceId)) color.setHex(COLORS.selected);
      else if (this.heat === 'area' && fm.areaRatio !== null) {
        const t = Math.abs(Math.log2(fm.areaRatio)) / maxLog;
        color.setRGB(1, 1 - t * 0.7, 1 - t); // 白 -> 红
      } else if (this.heat === 'angle' && fm.angleDistortion !== null) {
        const t = fm.angleDistortion / maxAngle;
        color.setRGB(1, 1 - t * 0.7, 1 - t);
      } else if (this.heat === 'flip') {
        color.setHex(fm.flipped ? 0xff5a4a : 0x7fa8c9);
      } else {
        color.setHex(COLORS.faceBase);
      }
      if (fm.degenerate3d || fm.degenerateUv) color.setHex(0x222428);
      for (let c = 0; c < 3; c++) {
        attr.setXYZ(fm.faceId * 3 + c, color.r, color.g, color.b);
      }
    });
    attr.needsUpdate = true;
  }

  frameView(): void {
    if (!this.mesh) return;
    const box = new THREE.Box3().setFromObject(this.mesh);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    const dir2 = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir2, sphere.radius * 3.2);
    this.camera.near = sphere.radius / 100;
    this.camera.far = sphere.radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    this.frame = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.ro?.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
