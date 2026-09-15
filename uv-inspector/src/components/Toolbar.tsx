import { useRef } from 'react';
import { SAMPLES } from '../samples/samples';
import { parseOBJ, writeOBJ } from '../io/obj';
import {
  fixAllFlippedIslands,
  loadMesh,
  markSaved,
  notify,
  replaceMesh,
  setBusy,
  setChecker,
  setHeat,
  useAppState,
} from '../store/appStore';
import { saveProject, listProjects, loadProject, deleteProject, deserializeMesh } from '../io/storage';
import { unwrapMesh } from '../xatlas/unwrap';
import { mirrorIslandsU } from '../model/uvedit';
import type { HeatMode } from '../three/ThreeView3D';

export function Toolbar(): JSX.Element {
  const state = useAppState();
  const fileRef = useRef<HTMLInputElement>(null);

  const onImportOBJ = async (file: File) => {
    const text = await file.text();
    const { mesh, warnings } = parseOBJ(text, file.name);
    if (mesh.faces.length === 0) {
      notify('error', 'OBJ 中没有解析到任何三角/多边形面');
      return;
    }
    loadMesh(mesh);
    notify(
      'info',
      `已导入 ${file.name}：${mesh.positions.length / 3} 位置顶点 / ${mesh.uvs.length / 2} UV 顶点 / ${mesh.faces.length} 三角面` +
        (warnings.length ? `；${warnings.length} 条警告` : ''),
    );
  };

  const onExportOBJ = () => {
    if (!state.mesh) return;
    const text = writeOBJ(state.mesh);
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.mesh.name.replace(/\.obj$/i, '') + '-uv.obj';
    a.click();
    URL.revokeObjectURL(a.href);
    notify('info', '已导出 OBJ，可用 Blender / Maya / 任意标准工具载入验证 UV');
  };

  const onSave = async () => {
    if (!state.mesh) return;
    setBusy('保存工程到 IndexedDB…');
    try {
      await saveProject(state.projectId, state.projectName, state.mesh);
      markSaved(state.projectId, state.projectName);
      notify('info', `工程「${state.projectName}」已保存到本地 IndexedDB`);
    } catch (e) {
      notify('error', `保存失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onOpen = async () => {
    setBusy('读取工程…');
    try {
      const projects = await listProjects();
      if (projects.length === 0) {
        notify('info', 'IndexedDB 中还没有保存过工程');
        return;
      }
      const id = window.prompt(
        '输入要打开的工程编号：\n' +
          projects.map((p, i) => `${i}: ${p.name} (${new Date(p.updatedAt).toLocaleString()})`).join('\n'),
        '0',
      );
      const idx = id === null ? NaN : Number(id);
      const rec = projects[idx];
      if (!rec) return;
      const full = await loadProject(rec.id);
      if (!full) return;
      loadMesh(deserializeMesh(full.mesh), full.name);
      notify('info', `已打开工程「${full.name}」`);
    } catch (e) {
      notify('error', `打开失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onDeleteProject = async () => {
    setBusy('读取工程…');
    try {
      const projects = await listProjects();
      if (projects.length === 0) {
        notify('info', '没有可删除的工程');
        return;
      }
      const id = window.prompt(
        '删除哪个工程？\n' +
          projects.map((p, i) => `${i}: ${p.name}`).join('\n'),
        '0',
      );
      const idx = id === null ? NaN : Number(id);
      const rec = projects[idx];
      if (rec) await deleteProject(rec.id);
      if (rec) notify('info', `已删除「${rec.name}」`);
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onUnwrap = async () => {
    if (!state.mesh) return;
    setBusy('加载 xatlas WASM 并自动展开（首次需从本地读取 wasm）…');
    const original = state.mesh;
    try {
      const { mesh, atlasWidth, atlasHeight } = await unwrapMesh(original);
      replaceMesh(mesh, 'xatlas 自动展开完成（原 UV 已替换，可导出验证）');
      notify('info', `xatlas 展开完成：图集 ${atlasWidth}×${atlasHeight}`);
    } catch (e) {
      // 自动展开失败（含 WASM 加载失败）：unwrapMesh 不修改入参，
      // 当前网格/选择/分析结果原封不动，只提示原因。
      notify('error', `xatlas 自动展开失败，已保留原模型：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onMirror = () => {
    if (!state.mesh || state.selection.size === 0) {
      notify('info', '请先在任一视图中选择要镜像的 UV 岛上的面');
      return;
    }
    const next = mirrorIslandsU(state.mesh, state.selection);
    replaceMesh(next, '已镜像所选 UV 岛（U 翻转，身份不变）');
  };

  const heatModes: Array<[HeatMode, string]> = [
    ['none', '原色'],
    ['area', '面积畸变'],
    ['angle', '角度畸变'],
    ['flip', '翻转'],
  ];

  return (
    <div className="toolbar">
      <div className="group">
        <strong style={{ marginRight: 6 }}>UV Inspector</strong>
        <select
          onChange={(e) => {
            const s = SAMPLES.find((x) => x.id === e.target.value);
            if (s) {
              loadMesh(s.build(), s.label);
              notify('info', s.description);
            }
            e.target.value = '';
          }}
          defaultValue=""
        >
          <option value="" disabled>
            载入样例…
          </option>
          {SAMPLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          ref={fileRef}
          type="file"
          accept=".obj,model/obj,text/plain"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImportOBJ(f);
            e.target.value = '';
          }}
        />
        <button onClick={() => fileRef.current?.click()}>导入 OBJ</button>
        <button disabled={!state.mesh} onClick={onExportOBJ}>
          导出 OBJ
        </button>
      </div>

      <div className="group">
        {heatModes.map(([mode, label]) => (
          <button
            key={mode}
            className={state.heat === mode ? 'active' : ''}
            onClick={() => setHeat(mode)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="group">
        <button disabled={!state.mesh || state.selection.size === 0} onClick={onMirror}>
          镜像所选 UV 岛
        </button>
        <button
          disabled={!state.mesh || state.analysis?.summary.flipped === 0}
          onClick={() => {
            const n = fixAllFlippedIslands();
            if (n === 0) notify('info', '没有检测到翻转岛');
          }}
          title="把每个翻转（镜像）的 UV 岛沿自身 U 中线镜像回来"
        >
          修正翻转岛
        </button>
        <button className="primary" disabled={!state.mesh} onClick={onUnwrap}>
          xatlas 自动展开
        </button>
      </div>

      <div className="group">
        <label className="check">
          <input
            type="checkbox"
            checked={state.checker}
            onChange={(e) => setChecker(e.target.checked)}
          />
          3D 棋盘
        </label>
      </div>

      <div className="group">
        <button disabled={!state.mesh} onClick={() => void onSave()}>
          保存
        </button>
        <button onClick={() => void onOpen()}>打开</button>
        <button onClick={() => void onDeleteProject()}>删除</button>
      </div>
    </div>
  );
}
