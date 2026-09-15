import { useRef, useState } from 'react';
import { SAMPLES } from '../samples/samples';
import { parseOBJ, writeOBJ } from '../io/obj';
import {
  clearSelection,
  commitExternalMesh,
  fixAllFlippedIslands,
  garbageCollectUnreachable,
  listProjects,
  loadMesh,
  mirrorSelected,
  notify,
  openProject,
  persistNow,
  previewRevision,
  deleteProject as deleteProjectById,
  setBusy,
  setChecker,
  setHeat,
  useAppState,
} from '../store/appStore';
import { unwrapMesh } from '../xatlas/unwrap';
import type { HeatMode } from '../three/ThreeView3D';
import { HistoryPanel } from './HistoryPanel';

export function Toolbar(): JSX.Element {
  const state = useAppState();
  const fileRef = useRef<HTMLInputElement>(null);
  const [showHistory, setShowHistory] = useState(false);

  const onImportOBJ = async (file: File) => {
    const text = await file.text();
    const { mesh, warnings } = parseOBJ(text, file.name);
    if (mesh.faces.length === 0) {
      notify('error', 'OBJ 中没有解析到任何三角/多边形面');
      return;
    }
    loadMesh(mesh, file.name);
    notify(
      'info',
      `已导入 ${file.name}：${mesh.positions.length / 3} 位置顶点 / ${mesh.uvs.length / 2} UV 顶点 / ${mesh.faces.length} 三角面` +
        (warnings.length ? `；${warnings.length} 条警告` : ''),
    );
  };

  // 导出严格对应当前选定版本（预览中则为预览版本，并提示）
  const onExportOBJ = () => {
    if (!state.mesh || !state.headId || !state.graph) return;
    const viewingId = state.previewId ?? state.headId;
    const rev = state.graph.revisions[viewingId];
    const text = writeOBJ(rev.mesh);
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = rev.mesh.name.replace(/\.obj$/i, '') + `-v${rev.seq}-uv.obj`;
    a.click();
    URL.revokeObjectURL(a.href);
    notify(
      'info',
      state.previewId
        ? `已导出历史版本 v${rev.seq}（预览，非当前 head）`
        : `已导出版本 v${rev.seq}，可用 Blender / Maya 等标准工具载入验证`,
    );
  };

  const onSave = async () => {
    if (!state.graph) return;
    setBusy('保存修订图谱到 IndexedDB…');
    const ok = await persistNow();
    setBusy(null);
    notify(ok ? 'info' : 'error', ok ? '工程（含完整修订图谱）已保存到本地 IndexedDB' : '保存失败，修订仍保留在本会话');
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
          projects
            .map((p, i) => `${i}: ${p.name} · v${p.headSeq} · ${p.revisionCount} 版本 (${new Date(p.updatedAt).toLocaleString()})`)
            .join('\n'),
        '0',
      );
      const idx = id === null ? NaN : Number(id);
      const rec = projects[idx];
      if (!rec) return;
      const ok = await openProject(rec.id);
      if (ok) notify('info', `已打开工程「${rec.name}」（${rec.revisionCount} 个版本，已迁移/载入修订图谱）`);
      else notify('error', '工程无法读取或已损坏');
    } catch (e) {
      notify('error', `打开失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onDeleteProject = async () => {
    try {
      const projects = await listProjects();
      if (projects.length === 0) {
        notify('info', '没有可删除的工程');
        return;
      }
      const id = window.prompt('删除哪个工程？\n' + projects.map((p, i) => `${i}: ${p.name}`).join('\n'), '0');
      const idx = id === null ? NaN : Number(id);
      const rec = projects[idx];
      if (rec) {
        await deleteProjectById(rec.id);
        notify('info', `已删除工程「${rec.name}」`);
      }
    } catch (e) {
      notify('error', (e as Error).message);
    }
  };

  const onUnwrap = async () => {
    if (!state.mesh || state.busy) return;
    setBusy('加载 xatlas WASM 并自动展开…');
    const sourceMesh = state.mesh;
    try {
      const { mesh, atlasWidth, atlasHeight } = await unwrapMesh(sourceMesh);
      // 成功才产生不可变版本；失败则不提交、图谱与 head 不变
      const rev = commitExternalMesh('xatlas', `xatlas 自动展开（图集 ${atlasWidth}×${atlasHeight}）`, mesh);
      notify(
        'info',
        rev
          ? `xatlas 展开完成：图集 ${atlasWidth}×${atlasHeight}，已生成新版本 v${rev.seq}（原版本可从历史恢复）`
          : 'xatlas 展开结果与当前 UV 等价，未产生新版本',
      );
    } catch (e) {
      notify('error', `xatlas 自动展开失败，未产生版本、已保留当前网格：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onMirror = () => {
    if (state.previewId) {
      notify('info', '正在预览历史版本，请先退出预览再编辑');
      return;
    }
    if (state.selection.size === 0) {
      notify('info', '请先在任一视图中选择要镜像的 UV 岛上的面');
      return;
    }
    const created = mirrorSelected();
    if (!created) notify('info', '镜像后 UV 无变化（未产生新版本）');
  };

  const onFixFlip = () => {
    const n = fixAllFlippedIslands();
    if (n === 0) notify('info', '没有需要修正的翻转岛（重复操作不会产生新版本）');
  };

  const onGc = async () => {
    const removed = await garbageCollectUnreachable();
    notify('info', removed.length ? `已删除 ${removed.length} 个不可达草稿节点` : '没有不可达草稿节点');
  };

  const heatModes: Array<[HeatMode, string]> = [
    ['none', '原色'],
    ['area', '面积畸变'],
    ['angle', '角度畸变'],
    ['flip', '翻转'],
  ];

  const revCount = state.graph ? Object.keys(state.graph.revisions).length : 0;

  return (
    <>
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
            <button key={mode} className={state.heat === mode ? 'active' : ''} onClick={() => setHeat(mode)}>
              {label}
            </button>
          ))}
        </div>

        <div className="group">
          <button disabled={!state.mesh || state.selection.size === 0 || !!state.previewId} onClick={onMirror}>
            镜像所选岛
          </button>
          <button
            disabled={!state.mesh || (state.analysis?.summary.flipped ?? 0) === 0 || !!state.previewId}
            onClick={onFixFlip}
            title="把每个翻转（镜像）的 UV 岛沿自身 U 中线镜像回来"
          >
            修正翻转岛
          </button>
          <button className="primary" disabled={!state.mesh || !!state.busy || !!state.previewId} onClick={onUnwrap}>
            xatlas 展开
          </button>
        </div>

        <div className="group">
          <label className="check">
            <input type="checkbox" checked={state.checker} onChange={(e) => setChecker(e.target.checked)} />
            3D 棋盘
          </label>
        </div>

        <div className="group">
          <button disabled={!state.mesh || !!state.previewId} onClick={() => void onSave()}>
            保存
          </button>
          <button onClick={() => void onOpen()}>打开</button>
          <button onClick={() => void onDeleteProject()}>删除</button>
          <button className={showHistory ? 'active' : ''} disabled={!state.graph} onClick={() => setShowHistory((v) => !v)}>
            版本图谱{revCount > 0 ? ` (${revCount})` : ''}
          </button>
          <button onClick={() => void onGc()} title="删除不可达的草稿/半写入节点">
            清理草稿
          </button>
        </div>

        <div className="group" style={{ borderRight: 'none' }}>
          {state.previewId ? (
            <button
              className="active"
              onClick={() => {
                previewRevision(null);
                clearSelection();
              }}
            >
              退出历史预览
            </button>
          ) : null}
          <span className="muted" style={{ fontSize: 11 }}>
            {state.dirty ? '● 未保存' : '已保存'}
            {state.saveState === 'saving' ? ' · 保存中…' : state.saveState === 'error' ? ' · 保存失败' : ''}
          </span>
        </div>
      </div>
      {showHistory && <HistoryPanel onClose={() => setShowHistory(false)} />}
    </>
  );
}
