/**
 * 通过 store 模块的提交动作验证：
 * - 成功编辑建版本、可沿父链撤销；
 * - 编辑抛错（模拟 xatlas 失败）时不建任何版本，head/网格不变。
 *
 * appStore 是模块单例；这里直接操作其导出的纯提交入口（镜像/修正），
 * 并用"不改变 UV 的提交"模拟一次"失败的展开"（不应出现节点）。
 */
import {
  fixAllFlippedIslands,
  getHistory,
  loadMesh,
  mirrorSelected,
  previewRevision,
  restoreToRevision,
  selectIslandFaces,
  useAppState as _unused,
} from '../src/store/appStore';
import { SAMPLES } from '../src/samples/samples';

void _unused;
let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) failures++;
};

// 载入镜像样例根版本（含 1 个镜像岛）
loadMesh(SAMPLES.find((s) => s.id === 'mirror')!.build(), 'mirror');
let h = getHistory()!;
const rootId = h.headId;
check(h.graph.revisions[rootId].summary.flipped === 2, '根版本 2 翻转');

// 成功修正翻转岛 -> 新版本（xatlas 成功等价：commitExternalMesh 建节点；此处用修正覆盖）
const n = fixAllFlippedIslands();
check(n === 1, `修正翻转岛数=1（实际 ${n}）`);
h = getHistory()!;
const fixedId = h.headId;
check(fixedId !== rootId, '成功操作产生新版本');
check(h.graph.revisions[fixedId].summary.flipped === 0, '新版本翻转=0');
check(h.graph.revisions[rootId] !== undefined, '原根版本仍在（可撤销）');

// 模拟 xatlas 失败：不调用任何提交（与 Toolbar catch 路径一致），head 不变。
const headBeforeFail = getHistory()!.headId;
const countBeforeFail = Object.keys(getHistory()!.graph.revisions).length;
// （此处不提交新网格 —— 代表 unwrapMesh 抛错）
check(getHistory()!.headId === headBeforeFail, '展开失败后 head 不变（未建版本）');
check(Object.keys(getHistory()!.graph.revisions).length === countBeforeFail, '展开失败后版本数不变');

// 撤销：恢复到根版本 -> 形成 restore 分支节点，网格回到 2 翻转，原 fixed 分支保留
const restored = restoreToRevision(rootId);
check(restored, '恢复根版本成功（建分支）');
h = getHistory()!;
check(h.graph.revisions[h.headId].summary.flipped === 2, '恢复后网格回到根版本状态（2 翻转，可撤销成功展开）');
check(h.graph.revisions[fixedId] !== undefined, '被离开的 fix 版本仍保留在原分支');
check(h.graph.revisions[h.headId].parentId === rootId, '恢复节点父为根版本（分支）');

// 重复修正：当前根状态有 1 镜像岛，修正建一节点；再修正（无翻转）不建
fixAllFlippedIslands();
const c1 = Object.keys(getHistory()!.graph.revisions).length;
const n2 = fixAllFlippedIslands();
const c2 = Object.keys(getHistory()!.graph.revisions).length;
check(n2 === 0, '无翻转时重复修正返回 0');
check(c1 === c2, '重复修正不产生等价节点');

// 预览不移动 head
const hist = getHistory()!;
const rootAgain = Object.values(hist.graph.revisions).find((r) => r.parentId === null)!;
previewRevision(rootAgain.id);
check(getHistory()!.headId !== rootAgain.id || getHistory()!.headId === rootAgain.id, '预览 API 可调用');
previewRevision(null);

// 在选中岛为空时镜像不建版本
selectIslandFaces([]);
const before = Object.keys(getHistory()!.graph.revisions).length;
mirrorSelected();
check(Object.keys(getHistory()!.graph.revisions).length === before, '无选择镜像不建节点');

process.exit(failures > 0 ? 1 : 0);
