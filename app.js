"use strict";

let selection = [];          // 選択中(リストに追加された)行
let dialogRows = [];         // 継手参照で現在ロード中の断面候補
let multiMode = true;        // デフォルト ON
const currentFmt = "dxf";    // 出力は DXF のみ
let materials = [];          // facets material
let facets = {};             // JointData.facets() の結果（reset時のピル再生成に使用）

const $ = (id) => document.getElementById(id);
const VALCOLS = ["f_bolt", "spl1", "spl2", "spl_l", "w_bolt", "N", "M", "E1", "P1", "spl3"];
const MARK_KEYS = new Set(["section", "spl1", "spl2", "spl3"]);
const HIST_KEY = "joint_list_history";
const HIST_MAX = 20;
// ビルド版数（ヘッダに表示）。EXE 再ビルドのたびに更新し、起動中のEXEが新旧どちらかを
// 一目で判別できるようにする。旧版は「最終更新 X月Y日(=今日)」表示なので様式自体が異なる。
const APP_BUILD = "2026-07-02s";
// 材質グレード（データの SN400/SN490 を表示・マーク用に細分。6種を1列表示）
const MATERIAL_GRADES = ["SS400", "SN400B", "SM490A", "SN490B"];
const DEFAULT_MATERIAL = "SN400B";

async function init() {
  $("dateSub").textContent = `版 ${APP_BUILD}`;
  const sf = localStorage.getItem("saveFolder"); if (sf) $("saveFolder").value = sf;
  const pn = localStorage.getItem("projName"); if (pn) $("projName").value = pn;
  $("projName").addEventListener("change", e => localStorage.setItem("projName", e.target.value.trim()));

  try {
    // データは boot() のパスワードゲートで復号済み（JointData.loadEncrypted）
    const f = JointData.facets();
    facets = f;
    // 4項目とも「ピル選択」方式。選択色は CSS の pill-blue/red/green/yellow で付与。
    buildPills("d_grade_pills", "d_grade", f.grade, "F10T");        // ボルト等級(緑) = F10T/F8T
    buildPills("d_type_pills", "d_type", f.type, "beam");           // 継手種別(青)  = beam/column
    buildPills("d_bolt_pills", "d_bolt", f.bolt_size, "M20");       // ボルト径(黄)  = M16/M20/M22
    // 母材鋼種(赤)は固定グレード（データは SN400/SN490 の2クラスだが表示・マーク用に細分）
    materials = MATERIAL_GRADES.slice();
    buildPills("d_material_pills", "d_material", materials, DEFAULT_MATERIAL);
  } catch (e) {
    setMsg("初期化失敗: " + e, true);
  }
  const lk = $("btnLock");
  if (lk) lk.onclick = () => { localStorage.removeItem("jl_pw"); location.reload(); };
  applyMultiUI(true);   // デフォルトで複数選択ON
  bind();
  renderList();
  refreshShapes();
}

function fillSelect(id, values) {
  const sel = $(id); sel.innerHTML = "";
  (values || []).forEach((v) => {
    const o = document.createElement("option"); o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
}
function setVal(id, v) {
  const el = $(id);
  if (el.tagName === "SELECT") {
    if ([...el.options].some((o) => o.value === v)) el.value = v;
  } else {
    el.value = v;
  }
}

// 汎用ピル生成: values をボタン列で描画し、選択値を hidden(hiddenId) に反映。current が無ければ先頭。
function buildPills(containerId, hiddenId, values, current) {
  const c = $(containerId); c.innerHTML = "";
  const list = values || [];
  const sel = list.includes(current) ? current : (list[0] || "");
  list.forEach((v) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = v; b.dataset.value = v;
    if (v === sel) b.classList.add("active");
    b.onclick = () => {
      [...c.querySelectorAll("button")].forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      $(hiddenId).value = v;
      refreshShapes();
    };
    c.appendChild(b);
  });
  $(hiddenId).value = sel;
}
// 既存ピルの選択状態を value に合わせて更新（条件変更の適用用）。
function selectPill(containerId, hiddenId, value) {
  const c = $(containerId);
  let matched = false;
  [...c.querySelectorAll("button")].forEach((x) => {
    const on = x.dataset.value === value;
    x.classList.toggle("active", on);
    if (on) matched = true;
  });
  if (matched) $(hiddenId).value = value;
}

function bind() {
  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode);
  });
  $("btnAdd").onclick = onAddRef;
  $("btnMulti").onclick = toggleMulti;
  $("btnReset").onclick = resetFilters;
  // 継手種別/母材鋼種/ボルト等級/ボルト径 はピル方式（onclick で直接 refreshShapes）
  ["d_h", "d_b", "d_tw", "d_tf"].forEach((id) =>
    $(id).addEventListener("input", refreshShapes));
  $("searchBox").addEventListener("input", (e) => {
    const v = e.target.value.trim().replace(/×/g, "x");
    const parts = v.split("x").map((s) => s.trim());
    $("d_h").value = parts[0] || ""; $("d_b").value = parts[1] || "";
    $("d_tw").value = parts[2] || ""; $("d_tf").value = parts[3] || "";
    refreshShapes();
  });
  $("btnAddBH").onclick = onAddBH;
  $("btnSortSize").onclick = () => { sortBySize(); renderList(); };
  $("btnClear").onclick = () => { selection = []; renderList(); };
  $("btnDownload").onclick = doDownload;
  $("btnSave").onclick = doSave;
  $("btnPreview").onclick = doPreview;
  $("saveFolder").addEventListener("change", (e) =>
    localStorage.setItem("saveFolder", e.target.value.trim()));
  // 履歴
  $("btnHistory").onclick = openHistory;
  $("histClose").onclick = closeHistory;
  $("histSave").onclick = saveCurrentToHistory;
  $("histClear").onclick = clearHistoryAll;
  $("historyModal").addEventListener("click", (e) => {
    if (e.target === $("historyModal")) closeHistory();
  });
  // 行編集（条件変更）モーダル
  $("editClose").onclick = closeEdit;
  $("editCancel").onclick = closeEdit;
  $("editSave").onclick = saveEdit;
  $("editModal").addEventListener("click", (e) => { if (e.target === $("editModal")) closeEdit(); });
}

function setMode(mode) {
  document.querySelectorAll(".seg-btn").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("pane-ref").classList.toggle("hidden", mode !== "ref");
  $("pane-bh").classList.toggle("hidden", mode !== "bh");
}

function toggleMulti() {
  multiMode = !multiMode;
  applyMultiUI(multiMode);
}
function applyMultiUI(on) {
  multiMode = on;
  $("btnMulti").setAttribute("aria-pressed", String(on));
  $("btnMulti").textContent = on ? "複数選択中" : "複数選択";
  const sel = $("d_shape");
  const pick = sel.parentElement;
  if (on) { sel.setAttribute("multiple", ""); sel.size = 8; pick.classList.add("multi"); }
  else { sel.removeAttribute("multiple"); sel.size = 1; pick.classList.remove("multi"); }
}

function resetFilters() {
  buildPills("d_grade_pills", "d_grade", facets.grade, "F10T");
  buildPills("d_type_pills", "d_type", facets.type, "beam");
  buildPills("d_bolt_pills", "d_bolt", facets.bolt_size, "M20");
  buildPills("d_material_pills", "d_material", materials, DEFAULT_MATERIAL);
  ["d_h", "d_b", "d_tw", "d_tf"].forEach((id) => ($(id).value = ""));
  $("searchBox").value = "";
  refreshShapes();
  setMsg("条件をリセットしました");
}

async function refreshShapes() {
  try {
    const data = JointData.shapeRows({
      grade: $("d_grade").value, type: $("d_type").value,
      material: $("d_material").value, bolt: $("d_bolt").value,
      // family は意図的に送らない(H/SH統合扱い)
      h: $("d_h").value.trim(), b: $("d_b").value.trim(),
      tw: $("d_tw").value.trim(), tf: $("d_tf").value.trim(),
    });
    dialogRows = data.rows || [];
    $("d_shape").innerHTML = dialogRows
      .map((r) => `<option value="${r.id}">${esc(r.shape)}</option>`).join("");
    $("d_count").textContent = `該当: ${data.count}件`;
    setMsg("");
  } catch (e) {
    $("d_count").textContent = "該当: 取得失敗";
    setMsg("断面取得失敗: " + e, true);
  }
}

// （所在検索機能は廃止。条件変更は中央リストの「編集」ボタンから行う＝Step3で実装）

function onAddRef() {
  const sel = $("d_shape");
  const ids = [...sel.selectedOptions].map((o) => parseInt(o.value, 10));
  if (!ids.length) { setMsg("Shape を選択してください", true); return; }
  const rowsToAdd = ids.map((id) => dialogRows.find((r) => r.id === id)).filter(Boolean);
  addRows(rowsToAdd);
}

async function onAddBH() {
  const num = (id) => $(id).value.trim();
  const params = {
    H: num("bh_H"), B: num("bh_B"), tw: num("bh_tw"), tf: num("bh_tf"),
    material: $("bh_material").value, bolt_size: $("bh_bolt").value,
    grade: $("bh_grade").value, family: $("bh_family").value,
    type: "beam",
    n_fbolt: num("bh_n_fbolt"), m_fbolt: num("bh_m_fbolt"),
    g1_fbolt_mm: num("bh_g1"), g2_fbolt_mm: num("bh_g2"),
    t_fspl1_mm: num("bh_t_fspl1"), w_fspl1_mm: num("bh_w_fspl1"),
    t_fspl2_mm: num("bh_t_fspl2"), w_fspl2_mm: num("bh_w_fspl2"),
    l_fspl_mm: num("bh_l_fspl"),
    n_wbolt: num("bh_n_wbolt"), m_wbolt: num("bh_m_wbolt"),
    p_wbolt_mm: num("bh_p_wbolt"),
    t_wspl_mm: num("bh_t_wspl"), w_wspl_mm: num("bh_w_wspl"), l_wspl_mm: num("bh_l_wspl"),
    remarks: num("bh_remarks"),
  };
  if (!params.H || !params.B) { setMsg("少なくとも H と B を入力してください", true); return; }
  try {
    const row = JointData.buildRowFromParams(params, -Date.now());
    if (row) { addRows([row]); setMsg("BH材を追加しました"); }
    else setMsg("BH材追加失敗", true);
  } catch (e) { setMsg("BH材追加失敗: " + e, true); }
}

// ===== selection =====
// 各行に一意の内部キー _uid を振る（複製は同じ DB id を持つため id では区別不可）
let _uidCounter = 1;
function nextUid() { return _uidCounter++; }
function findByUid(uid) { return selection.findIndex((r) => r._uid === uid); }

function addRows(rows) {
  rows.forEach((r) => {
    // 同一断面の二重追加は防ぐ
    const dup = selection.some((s) => s.id === r.id);
    if (!dup) {
      const row = { ...r };
      row._uid = nextUid();
      insertBySize(row);   // 既存の並びは保持し、サイズ順の位置へ挿入
    }
  });
  renderList();
}

// 既存行の順序は変えず、新規1行をサイズ順の位置に挿入
function insertBySize(row) {
  const k = sizeKey(row);
  let idx = selection.findIndex((r) => sizeKey(r) > k);
  if (idx < 0) idx = selection.length;   // どれより大きい → 末尾
  selection.splice(idx, 0, row);
}

function removeRow(uid) {
  selection = selection.filter((r) => r._uid !== uid);
  renderList();
}

// ===== ドラッグ&ドロップ並べ替え =====
let _dragUid = null;

// from行を target行の前/後ろへ移動
function moveRowTo(fromUid, targetUid, after) {
  if (fromUid === targetUid) return;
  const from = findByUid(fromUid);
  if (from < 0) return;
  const [moved] = selection.splice(from, 1);
  let target = selection.findIndex((r) => r._uid === targetUid);
  if (target < 0) { selection.splice(from, 0, moved); return; }  // 保険: 戻す
  if (after) target += 1;
  selection.splice(target, 0, moved);
  renderList();
}

// 描画後に各行へドラッグ&ドロップのイベントを結線
function bindDragReorder(body) {
  body.querySelectorAll(".drag-handle").forEach((h) => {
    h.addEventListener("dragstart", (e) => {
      _dragUid = parseInt(h.dataset.uid, 10);
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(_dragUid)); } catch (_) {}
      const tr = h.closest("tr"); if (tr) tr.classList.add("dragging");
    });
    h.addEventListener("dragend", () => {
      _dragUid = null;
      body.querySelectorAll("tr").forEach((tr) =>
        tr.classList.remove("dragging", "drop-before", "drop-after"));
    });
  });
  body.querySelectorAll("tr[data-uid]").forEach((tr) => {
    tr.addEventListener("dragover", (e) => {
      if (_dragUid == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = tr.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      tr.classList.toggle("drop-after", after);
      tr.classList.toggle("drop-before", !after);
    });
    tr.addEventListener("dragleave", () => {
      tr.classList.remove("drop-before", "drop-after");
    });
    tr.addEventListener("drop", (e) => {
      e.preventDefault();
      if (_dragUid == null) return;
      const targetUid = parseInt(tr.dataset.uid, 10);
      const rect = tr.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      moveRowTo(_dragUid, targetUid, after);
      _dragUid = null;
    });
  });
}

function sortBySize() {
  selection.sort((a, b) => sizeKey(a) - sizeKey(b));
}
function sizeKey(r) {
  const t = String(r.shape || "").split("x").map((s) => parseFloat(s) || 0);
  return (t[0] || 0) * 1e12 + (t[1] || 0) * 1e8 + (t[2] || 0) * 1e4 + (t[3] || 0);
}

// 行の表示用 mark を計算
function effectiveMark(r) {
  return r.mark || "square";
}

// CAD送信用に rows を変換
function rowsForExport() {
  return selection.map((r) => ({ ...r, mark: effectiveMark(r) }));
}

// ===== 中央リスト描画 =====
function markSpan(kind, letter) {
  const cls = (kind === "circle" || kind === "diamond" || kind === "none") ? kind : "square";
  return `<span class="mark ${cls}">${esc(letter || "B")}</span>`;
}
function valCell(key, value, markKind) {
  const v = String(value ?? "");
  const isEmpty = v === "—" || v === "" || v === "ー";
  const cls = "val" + (isEmpty ? " empty-mark" : "");
  const hasMarkable = MARK_KEYS.has(key) && /PL-|H-/.test(v);
  const showMark = hasMarkable && (markKind === "square" || markKind === "circle");
  if (showMark) return `<td class="${cls}">${markSpan(markKind)}${esc(v)}</td>`;
  return `<td class="${cls}">${esc(v || "—")}</td>`;
}

function refBadgesHtml(r) {
  // 条件選択（type/material/grade/bolt）をフィルタと同じ色で表示（青/赤/緑/黄）
  const parts = [];
  if (r.type)      parts.push(`<span class="badge b-type">${esc(r.type)}</span>`);
  if (r.material)  parts.push(`<span class="badge b-mat">${esc(r.material)}</span>`);
  if (r.grade)     parts.push(`<span class="badge b-grade">${esc(r.grade)}</span>`);
  if (r.bolt_size) parts.push(`<span class="badge b-bolt">${esc(r.bolt_size)}</span>`);
  if (r.family && r.family !== "H" && r.family !== "SH") parts.push(`<span class="badge b-fam">${esc(r.family)}</span>`);
  return parts.length ? `<div class="ref-badges">${parts.join("")}</div>` : "";
}

function renderList() {
  const body = $("listBody");
  if (!selection.length) {
    body.innerHTML = `<tr><td colspan="3" class="empty">左の「継手参照」または「BH材 手動」から追加してください。</td></tr>`;
  } else {
    body.innerHTML = selection.map((r) => {
      const eff = effectiveMark(r);
      const secMark = (eff === "none") ? "" : markSpan(eff, r.mark_letter);
      const rem = esc(r.remarks || "");
      return `<tr data-uid="${r._uid}" class="drag-row">
        <td class="actcol"><div class="act-cell">
          <span class="drag-handle" draggable="true" data-uid="${r._uid}" title="ドラッグで並べ替え">⠿</span>
          <button class="edit" data-uid="${r._uid}" title="編集（条件選択の変更）">✎</button>
          <button class="del" data-uid="${r._uid}" title="削除">✕</button>
        </div></td>
        <td class="section">${secMark}${esc(r.section || "")}${refBadgesHtml(r)}</td>
        <td class="remarks"><input type="text" data-uid="${r._uid}" value="${rem}" placeholder="備考"></td>
      </tr>`;
    }).join("");
    body.querySelectorAll(".del").forEach((b) => b.onclick = () => removeRow(parseInt(b.dataset.uid, 10)));
    body.querySelectorAll(".edit").forEach((b) => b.onclick = () => openEdit(parseInt(b.dataset.uid, 10)));
    body.querySelectorAll(".remarks input").forEach((inp) => {
      inp.oninput = () => {
        const i = findByUid(parseInt(inp.dataset.uid, 10));
        if (i >= 0) { selection[i].remarks = inp.value; doPreview(); }
      };
    });
    bindDragReorder(body);
  }
  const n = selection.length;
  $("selCount").textContent = `選択 ${n} 件`;
  $("outCount").textContent = n;
  $("btnDownload").disabled = n === 0;
  $("btnSave").disabled = n === 0;
  $("btnPreview").disabled = n === 0;
  $("btnClear").disabled = n === 0;
  if (n === 0) {
    $("prevDoc").classList.add("hidden");
    $("prevEmpty").style.display = "block";
  } else {
    // 選択が変わるたびにプレビューも自動更新
    doPreview();
  }
}

// ===== 行の編集（条件選択の変更）=====
// その断面が在る (grade, 材質クラス, bolt) を JointData.search で列挙 → 選択 →
// JointData.shapeRows で該当条件の継手値を再取得し行ごと差し替え（_uid・並び位置・備考は保持）。
let _editUid = null;
let _editConds = [];
let _editSelKey = null;
function matClass(m) { return String(m).toUpperCase().includes("490") ? "SN490" : "SN400"; }
function boltNum(b) { const m = String(b).match(/\d+/); return m ? parseInt(m[0], 10) : 0; }
function condKey(grade, mat, bolt) { return `${grade}|${matClass(mat)}|${bolt}`; }

function openEdit(uid) {
  const i = findByUid(uid);
  if (i < 0) return;
  _editUid = uid;
  const r = selection[i];
  $("editSecLabel").textContent = r.section || r.shape || "";
  loadEditConditions(r);
  $("editModal").classList.remove("hidden");
}
function loadEditConditions(r) {
  const box = $("editCondGroup");
  _editConds = []; _editSelKey = null;
  if (String(r.family || "").toUpperCase() === "BH") {
    box.innerHTML = `<div class="edit-note">BH材（手動入力）は条件変更の対象外です。</div>`;
    return;
  }
  let rows = [];
  try { rows = (JointData.search({ shape: r.shape }).rows) || []; }
  catch (e) { box.innerHTML = `<div class="edit-note">条件の取得に失敗しました</div>`; return; }
  const seen = new Set();
  rows.forEach((x) => {
    if (x.shape !== r.shape) return;                 // 完全一致のみ
    const cls = matClass(x.material);
    const key = `${x.grade}|${cls}|${x.bolt_size}`;
    if (seen.has(key)) return;
    seen.add(key);
    _editConds.push({ grade: x.grade, cls, bolt_size: x.bolt_size,
                      dispMat: cls === "SN490" ? "SN490B" : "SN400B", key });
  });
  _editConds.sort((a, b) =>
    a.grade.localeCompare(b.grade) || a.cls.localeCompare(b.cls) || boltNum(a.bolt_size) - boltNum(b.bolt_size));
  const curKey = condKey(r.grade, r.material, r.bolt_size);
  _editSelKey = _editConds.some((c) => c.key === curKey) ? curKey : (_editConds[0] ? _editConds[0].key : null);
  renderEditConds(r);
}
function renderEditConds(r) {
  const box = $("editCondGroup");
  if (!_editConds.length) { box.innerHTML = `<div class="edit-note">この断面が在る条件が見つかりません。</div>`; return; }
  const curKey = condKey(r.grade, r.material, r.bolt_size);
  box.innerHTML = _editConds.map((c) => {
    const on = c.key === _editSelKey ? " active" : "";
    const cur = c.key === curKey ? ` <span class="cond-cur">(現在)</span>` : "";
    const matLabel = (c.cls === matClass(r.material)) ? r.material : c.dispMat;
    return `<button type="button" class="cond-opt${on}" data-key="${esc(c.key)}">
      <span class="badge b-type">${esc(r.type || "beam")}</span>
      <span class="badge b-mat">${esc(matLabel)}</span>
      <span class="badge b-grade">${esc(c.grade)}</span>
      <span class="badge b-bolt">${esc(c.bolt_size)}</span>${cur}
    </button>`;
  }).join("");
  box.querySelectorAll(".cond-opt").forEach((b) => {
    b.onclick = () => { _editSelKey = b.dataset.key; renderEditConds(r); };
  });
}
function closeEdit() { $("editModal").classList.add("hidden"); _editUid = null; }
function saveEdit() {
  const i = findByUid(_editUid);
  if (i < 0) { closeEdit(); return; }
  const r = selection[i];
  const sel = _editConds.find((c) => c.key === _editSelKey);
  const curKey = condKey(r.grade, r.material, r.bolt_size);
  if (sel && sel.key !== curKey) {
    const dispMat = (sel.cls === matClass(r.material)) ? r.material : sel.dispMat;
    const nrows = (JointData.shapeRows({ grade: sel.grade, type: r.type || "beam",
                    material: dispMat, bolt: sel.bolt_size, shape: r.shape }).rows) || [];
    const nr = nrows.find((x) => x.shape === r.shape);
    if (!nr) { setMsg("この断面はこの条件には存在しません", true); return; }
    selection[i] = { ...nr, _uid: r._uid, remarks: r.remarks };   // 継手値ごと差し替え・_uid/備考は保持
  }
  renderList();
  closeEdit();
  setMsg("行を更新しました");
}

// ===== プレビュー =====
function previewValCell(key, value, mark, letter) {
  const v = String(value ?? "");
  const isEmpty = !v || v === "—" || v === "ー";
  const hasMarkable = ["spl1", "spl2", "spl3"].includes(key) && /PL-/.test(v);
  if (hasMarkable && mark !== "none") {
    return `<td><span class="prev-mark ${mark}">${esc(letter || "B")}</span>${esc(v)}</td>`;
  }
  if (isEmpty) return `<td class="empty-em">—</td>`;
  return `<td>${esc(v)}</td>`;
}

function doPreview() {
  if (!selection.length) return;
  const body = $("prevTbody");
  body.innerHTML = selection.map((r) => {
    const mark = effectiveMark(r);
    const letter = r.mark_letter || "B";
    const secInner = (mark !== "none" ? `<span class="prev-mark ${mark}">${esc(letter)}</span>` : "") + esc(r.section || "");
    const nm = (r.N || r.M) ? `${esc(r.N || "")}&nbsp;&nbsp;${esc(r.M || "")}` : "—";
    return `<tr>
      <td class="sec">${secInner}</td>
      ${previewValCell("f_bolt", r.f_bolt, mark, letter)}
      ${previewValCell("spl1", r.spl1, mark, letter)}
      ${previewValCell("spl2", r.spl2, mark, letter)}
      ${previewValCell("spl_l", r.spl_l, mark, letter)}
      ${previewValCell("w_bolt", r.w_bolt, mark, letter)}
      <td>${nm}</td>
      ${previewValCell("E1", r.E1, mark, letter)}
      ${previewValCell("P1", r.P1, mark, letter)}
      ${previewValCell("spl3", r.spl3, mark, letter)}
      <td class="remarks-cell">${esc(r.remarks || "")}</td>
    </tr>`;
  }).join("");
  $("prevDoc").classList.remove("hidden");
  $("prevEmpty").style.display = "none";
}

// ===== 出力 =====
function exportPayload() {
  return { rows: rowsForExport(), format: currentFmt };
}

// ===== DXF出力（Pyodide で既存 dxf_list.py をそのまま実行）=====
// 初回だけ Pyodide(本体) + ezdxf を読み込む。以後は使い回す（数十秒→即時）。
let _dxfEnginePromise = null;
async function ensureDxfEngine() {
  if (_dxfEnginePromise) return _dxfEnginePromise;
  _dxfEnginePromise = (async () => {
    setMsg("DXFエンジン準備中…（初回のみ数十秒かかります）");
    if (typeof loadPyodide === "undefined") {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";
        s.onload = resolve;
        s.onerror = () => reject(new Error("Pyodide本体の読込に失敗（ネット接続をご確認ください）"));
        document.head.appendChild(s);
      });
    }
    const py = await loadPyodide();
    await py.loadPackage("micropip");
    const micropip = py.pyimport("micropip");
    await micropip.install("ezdxf==1.4.3");   // ローカルPython版と同一バージョンに固定
    const src = await (await fetch("./py/dxf_list.py")).text();
    py.FS.writeFile("dxf_list.py", src);
    py.runPython(`
import dxf_list, json
def _make_dxf(rows_json):
    rows = json.loads(rows_json)
    dxf_list.generate(rows, "/out.dxf")   # ★既存Pythonと同一コードでDXF生成
    with open("/out.dxf", "r", encoding="utf-8") as f:
        return f.read()
`);
    return py;
  })();
  return _dxfEnginePromise;
}

async function doDownload() {
  if (!selection.length) return;
  try {
    const py = await ensureDxfEngine();
    setMsg("DXF 生成中...");
    py.globals.set("_rows_json", JSON.stringify(rowsForExport()));
    const dxfText = py.runPython("_make_dxf(_rows_json)");
    window.__lastDxf = dxfText;   // 動作検証用（最終版で除去可）
    const dxfCRLF = dxfText.replace(/\r?\n/g, "\r\n");   // 元のWindows版に合わせ改行をCRLFへ
    const blob = new Blob([dxfCRLF], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `鉄骨剛接合リスト_${ts()}.dxf`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setMsg(`${selection.length} 件を DXF でダウンロードしました`);
    autoSnapshotHistory("DXF出力");
  } catch (e) {
    setMsg("DXF出力失敗: " + e, true);
  }
}

async function doSave() {
  // 静的版(サーバー無し)では「サーバの指定フォルダへ保存」は行えません。
  // DXF はブラウザのダウンロードで取得します（Stage 3）。
  setMsg("静的版ではサーバ保存は使用しません。出力ボタンからダウンロードしてください。", true);
}

// ===== 履歴 (localStorage) =====
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); }
  catch { return []; }
}
function saveHistory(list) {
  localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX)));
}
function pushHistoryItem(label) {
  if (!selection.length) return;
  const list = loadHistory();
  const item = {
    ts: new Date().toISOString(),
    label: label || "保存",
    proj: $("projName").value.trim() || "",
    rows: selection.map((r) => ({ ...r })),  // deep copy
  };
  list.unshift(item);
  saveHistory(list);
}
function autoSnapshotHistory(label) {
  pushHistoryItem(label);
  if (!$("historyModal").classList.contains("hidden")) renderHistoryList();
}

function openHistory() { $("historyModal").classList.remove("hidden"); renderHistoryList(); }
function closeHistory() { $("historyModal").classList.add("hidden"); }
function saveCurrentToHistory() {
  if (!selection.length) { setMsg("選択が空です", true); return; }
  pushHistoryItem("手動保存");
  renderHistoryList();
  setMsg("履歴に保存しました");
}
function clearHistoryAll() {
  if (!confirm("履歴をすべて削除しますか?")) return;
  saveHistory([]);
  renderHistoryList();
}
function renderHistoryList() {
  const list = loadHistory();
  const c = $("histList");
  if (!list.length) {
    c.innerHTML = `<div class="hist-empty">履歴はありません</div>`;
    return;
  }
  c.innerHTML = list.map((it, idx) => {
    const dt = new Date(it.ts);
    const pad = (n) => String(n).padStart(2, "0");
    const tsStr = `${dt.getFullYear()}/${pad(dt.getMonth()+1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    const projLabel = it.proj ? `[${esc(it.proj)}] ` : "";
    const sampleShape = (it.rows[0] && it.rows[0].section) || "";
    const desc = `${projLabel}${esc(it.label)} ・ ${it.rows.length}件 ・ 例: ${esc(sampleShape)}`;
    return `<div class="hist-item">
      <div class="hist-item-info">
        <div class="hist-item-ts">${tsStr}</div>
        <div class="hist-item-desc">${desc}</div>
      </div>
      <div class="hist-item-btns">
        <button class="primary" data-act="load" data-idx="${idx}">復元</button>
        <button class="ghost" data-act="del" data-idx="${idx}">削除</button>
      </div>
    </div>`;
  }).join("");
  c.querySelectorAll(".hist-item button").forEach((b) => {
    b.onclick = () => historyAction(b.dataset.act, parseInt(b.dataset.idx, 10));
  });
}
function historyAction(act, idx) {
  const list = loadHistory();
  if (idx < 0 || idx >= list.length) return;
  if (act === "load") {
    if (selection.length && !confirm("現在の選択を上書きしますか?")) return;
    const raw = list[idx].rows.map((r) => ({ ...r }));
    raw.forEach((r) => { r._uid = nextUid(); });
    selection = raw;
    renderList();
    closeHistory();
    setMsg(`履歴から ${selection.length} 件を復元しました`);
  } else if (act === "del") {
    list.splice(idx, 1); saveHistory(list); renderHistoryList();
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function ts() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function setMsg(s, err) {
  const m = $("msg"); m.textContent = s || "";
  m.style.color = err ? "var(--danger)" : "var(--muted)";
}

// ===== パスワードゲート（暗号データを復号してから init）=====
const PW_KEY = "jl_pw";
async function tryUnlock(password, remember) {
  await JointData.loadEncrypted(password);        // 失敗時は例外(PASSWORD_WRONG等)
  if (remember) localStorage.setItem(PW_KEY, password);
  const ov = $("authOverlay"); if (ov) ov.remove();
  await init();
}
async function boot() {
  const form = $("authForm"), err = $("authErr"), btn = $("authBtn");
  if (form) form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (err) err.textContent = "";
    const pw = $("authPass").value;
    if (!pw) { if (err) err.textContent = "パスワードを入力してください"; return; }
    btn.disabled = true; btn.textContent = "確認中…";
    try {
      await tryUnlock(pw, $("authRemember").checked);
    } catch (ex) {
      if (err) err.textContent = (ex && ex.code === "PASSWORD_WRONG")
        ? "パスワードが違います" : ("読込エラー: " + ((ex && ex.message) || ex));
      btn.disabled = false; btn.textContent = "解除して開く";
    }
  });
  // この端末で記憶済みなら自動解除
  const saved = localStorage.getItem(PW_KEY);
  if (saved) {
    try { await tryUnlock(saved, true); return; }
    catch (_) { localStorage.removeItem(PW_KEY); }   // 保存パスワードが古い→再入力へ
  }
  const p = $("authPass"); if (p) p.focus();
}
boot();
