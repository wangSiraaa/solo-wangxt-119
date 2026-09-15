import { useEffect, useRef } from 'react';
import type { AnalysisResult, MeshData, Selection } from '../model/types';
import { ThreeView3D, type HeatMode } from '../three/ThreeView3D';
import { UVView2D } from '../three/UVView2D';
import { pick } from '../store/appStore';

interface Props {
  mesh: MeshData | null;
  analysis: AnalysisResult | null;
  selection: Selection;
  heat: HeatMode;
  checker: boolean;
}

/** 左右两个视图：3D 模型 + 2D UV。选择通过 store.pick 回流实现两视图同步。 */
export function Viewport({ mesh, analysis, selection, heat, checker }: Props): JSX.Element {
  const ref3d = useRef<HTMLDivElement>(null);
  const ref2d = useRef<HTMLDivElement>(null);
  const view3d = useRef<ThreeView3D | null>(null);
  const view2d = useRef<UVView2D | null>(null);

  // 视图初始化（一次）
  useEffect(() => {
    if (!ref3d.current || !ref2d.current) return;
    const a = new ThreeView3D(ref3d.current, { onPick: pick });
    const b = new UVView2D(ref2d.current, { onPick: pick });
    view3d.current = a;
    view2d.current = b;
    return () => {
      a.dispose();
      b.dispose();
      view3d.current = null;
      view2d.current = null;
    };
  }, []);

  // 网格/分析变化（含历史预览）：刷新数据
  useEffect(() => {
    if (mesh && analysis) {
      view3d.current?.setData(mesh, analysis);
      view2d.current?.setData(mesh, analysis);
    }
  }, [mesh, analysis]);

  useEffect(() => {
    view3d.current?.setSelection(selection);
    view2d.current?.setSelection(selection);
  }, [selection, mesh]);

  useEffect(() => {
    view3d.current?.setHeat(heat);
    view2d.current?.setHeat(heat);
  }, [heat, mesh]);

  useEffect(() => {
    view3d.current?.setChecker(checker);
  }, [checker, mesh]);

  return (
    <div className="views">
      <div className="view" ref={ref3d}>
        <span className="view-tag">3D MODEL · 棋盘纹理</span>
        <span className="view-hint">左键选择面 · Shift 加选 · 拖拽旋转 · 滚轮缩放</span>
        {!mesh && (
          <div className="empty">
            <div>
              从上方工具栏加载样例或导入 OBJ
              <br />
              <span className="muted">所有处理均在本地浏览器完成</span>
            </div>
          </div>
        )}
      </div>
      <div className="view" ref={ref2d}>
        <span className="view-tag">2D UV LAYOUT</span>
        <span className="view-hint">左键选择面 · 右键/Shift 拖拽平移 · 滚轮缩放</span>
        {!mesh && <div className="empty" />}
      </div>
    </div>
  );
}
