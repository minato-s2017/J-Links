"use strict";

let selection = [];          // 選択中(リストに追加された)行
let dialogRows = [];         // 継手参照で現在ロード中の断面候補
let hBuckets = [];           // 追加shape: 選択中の H 100刻みバケット（複数可）
let bBuckets = [];           // 追加shape: 選択中の B 100刻みバケット（複数可）
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
const APP_BUILD = "2026-07-10s";
// 材質グレード（データの SN400/SN490 を表示・マーク用に細分。6種を1列表示）
const MATERIAL_GRADES = ["SS400", "SN400B", "SM490A", "SN490B"];
const DEFAULT_MATERIAL = "SS400";

// ===== テーマ（ダーク/ライト）。<html data-theme> を切替え、localStorageに保存 =====
const THEME_KEY = "joint_list_theme";
function applyTheme(t) {
  const mode = (t === "light") ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", mode);
  const btn = $("btnTheme");
  if (btn) btn.textContent = (mode === "light") ? "ライトモード" : "ダークモード";
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  const next = (cur === "light") ? "dark" : "light";
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyTheme(next);
}

async function init() {
  $("dateSub").textContent = APP_BUILD;
  applyTheme(localStorage.getItem(THEME_KEY) || "light");
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
    buildPills("d_bolt_pills", "d_bolt", f.bolt_size, "M16");       // ボルト径(黄)  = M16/M20/M22
    // 母材鋼種(赤)は固定グレード（データは SN400/SN490 の2クラスだが表示・マーク用に細分）
    materials = MATERIAL_GRADES.slice();
    buildPills("d_material_pills", "d_material", materials, DEFAULT_MATERIAL);
  } catch (e) {
    setMsg("初期化失敗: " + e, true);
  }
  const lk = $("btnLock");
  if (lk) lk.onclick = () => { localStorage.removeItem("jl_pw"); location.reload(); };
  applyMultiUI(false);  // デフォルトで単体選択
  bind();
  renderList();
  buildShapeToggles();  // H/B 100刻みトグルを生成
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
      buildShapeToggles();   // 条件変更で H/B バケット候補を再構築（選択は可能な限り保持）
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
    hBuckets.length = 0; bBuckets.length = 0;   // 全文検索時は H/B トグル選択を解除
    buildShapeToggles();
    refreshShapes();
  });
  $("btnAddBH").onclick = onAddBH;
  // BH材 自動設計 / 検定 / 計算書
  $("btnAutoBH").onclick = onAutoDesignBH;
  $("btnCalcBH").onclick = onCalcBH;
  $("bhCalcClose").onclick = closeBHCalc;
  $("bhCalcCloseBtn").onclick = closeBHCalc;
  $("bhCalcPdf").onclick = onBhCalcPrint;
  $("bhCalcAdd").onclick = () => { onAddBH(); closeBHCalc(); };
  $("bhCalcModal").addEventListener("click", (e) => {
    if (e.target === $("bhCalcModal")) closeBHCalc();
  });
  $("btnBulkHead").onclick = toggleBulkHead;
  $("btnSortSize").onclick = () => { sortBySize(); renderList(); };
  $("btnClear").onclick = () => { selection = []; renderList(); };
  $("btnDownload").onclick = doDownload;
  $("btnSave").onclick = doSave;
  $("btnPreview").onclick = doPreview;
  $("saveFolder").addEventListener("change", (e) =>
    localStorage.setItem("saveFolder", e.target.value.trim()));
  // テーマ切替
  $("btnTheme").onclick = toggleTheme;
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
  $("editHeadGroup").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-head]");
    if (!b) return;
    [...$("editHeadGroup").querySelectorAll("button")].forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  });
  // CSV取込（Revit断面）→ 仮決定モーダル
  $("btnCsvImport").onclick = () => $("csvFile").click();
  $("csvFile").addEventListener("change", onCsvSelected);
  $("csvClose").onclick = closeCsvStage;
  $("csvCancel").onclick = closeCsvStage;
  $("csvReflect").onclick = reflectCsv;
  $("csvBolt").addEventListener("change", (e) => { csvBoltMode = e.target.value; rebuildCsvStage(); });
  $("csvCheckAll").addEventListener("change", (e) => toggleCsvAll(e.target.checked));
  $("csvModal").addEventListener("click", (e) => { if (e.target === $("csvModal")) closeCsvStage(); });
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
  buildPills("d_bolt_pills", "d_bolt", facets.bolt_size, "M16");
  buildPills("d_material_pills", "d_material", materials, DEFAULT_MATERIAL);
  ["d_h", "d_b", "d_tw", "d_tf"].forEach((id) => ($(id).value = ""));
  $("searchBox").value = "";
  hBuckets.length = 0; bBuckets.length = 0;   // H/B トグル選択も解除
  buildShapeToggles();
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
      hBuckets, bBuckets,   // H/B 100刻みトグルの選択（複数可）
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

// ===== 追加shape: H / B の 100刻みトグル =====
// 現在の 種別/鋼種/等級/ボルト 条件で存在する H・B の「百の位」帯を列挙してトグル生成。
function buildShapeToggles() {
  let av = { h: [], b: [] };
  try {
    av = JointData.hundreds({
      grade: $("d_grade").value, type: $("d_type").value,
      material: $("d_material").value, bolt: $("d_bolt").value,
    });
  } catch (e) { /* データ未ロード時などは空 */ }
  renderBucketPills("d_h_pills", av.h, hBuckets);
  renderBucketPills("d_b_pills", av.b, bBuckets);
}

// 候補 avail をトグルボタン化。選択状態は stateArr(配列)に保持（複数選択・OR）。
function renderBucketPills(containerId, avail, stateArr) {
  const c = $(containerId);
  if (!c) return;
  // 候補から消えたバケットは選択解除（条件変更で存在しなくなった場合）
  for (let i = stateArr.length - 1; i >= 0; i--) {
    if (!avail.includes(stateArr[i])) stateArr.splice(i, 1);
  }
  c.innerHTML = "";
  if (!avail.length) { c.innerHTML = `<span class="hb-empty">該当なし</span>`; return; }
  avail.forEach((v) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = v; b.dataset.value = v;
    if (stateArr.includes(v)) b.classList.add("active");
    b.onclick = () => {
      const idx = stateArr.indexOf(v);
      if (idx >= 0) { stateArr.splice(idx, 1); b.classList.remove("active"); }
      else { stateArr.push(v); b.classList.add("active"); }
      refreshShapes();
    };
    c.appendChild(b);
  });
}

// （所在検索機能は廃止。条件変更は中央リストの「編集」ボタンから行う＝Step3で実装）

function onAddRef() {
  const sel = $("d_shape");
  const ids = [...sel.selectedOptions].map((o) => parseInt(o.value, 10));
  if (!ids.length) { setMsg("Shape を選択してください", true); return; }
  const rowsToAdd = ids.map((id) => dialogRows.find((r) => r.id === id)).filter(Boolean);
  addRows(rowsToAdd);
}

// BH材 入力フォーム → params（自動設計・検定・追加で共用）
function bhFormParams() {
  const num = (id) => $(id).value.trim();
  return {
    H: num("bh_H"), B: num("bh_B"), tw: num("bh_tw"), tf: num("bh_tf"),
    material: $("bh_material").value, bolt_size: $("bh_bolt").value,
    grade: $("bh_grade").value, family: $("bh_family").value,
    type: "beam", galv: $("bh_galv").checked,
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
}

async function onAddBH() {
  const params = bhFormParams();
  if (!params.H || !params.B) { setMsg("少なくとも H と B を入力してください", true); return; }
  try {
    const row = JointData.buildRowFromParams(params, -Date.now());
    if (row) { addRows([row]); setMsg("BH材を追加しました"); }
    else setMsg("BH材追加失敗", true);
  } catch (e) { setMsg("BH材追加失敗: " + e, true); }
}

// 設計結果 params をフォームへ反映（自動設計・再検定後の充填）
function fillBHForm(p) {
  const set = (id, v) => { if (v != null) $(id).value = v; };
  set("bh_n_fbolt", p.n_fbolt); set("bh_m_fbolt", p.m_fbolt);
  set("bh_t_fspl1", p.t_fspl1_mm); set("bh_w_fspl1", p.w_fspl1_mm);
  set("bh_t_fspl2", p.t_fspl2_mm); set("bh_w_fspl2", p.w_fspl2_mm);
  set("bh_l_fspl", p.l_fspl_mm);
  set("bh_n_wbolt", p.n_wbolt); set("bh_m_wbolt", p.m_wbolt); set("bh_p_wbolt", p.p_wbolt_mm);
  set("bh_t_wspl", p.t_wspl_mm); set("bh_w_wspl", p.w_wspl_mm); set("bh_l_wspl", p.l_wspl_mm);
}

let _bhCalcParams = null;

// 自動設計（断面 → 継手諸元） SCSS §2.4：許容応力度設計＋α確認
function onAutoDesignBH() {
  const params = bhFormParams();
  if (!params.H || !params.B || !params.tw || !params.tf) {
    setMsg("自動設計には H・B・t_w・t_f が必要です", true); return;
  }
  try {
    const data = BHDesign.run(params, true);
    fillBHForm(data.params);
    openBHCalc(data);
    const s = data.summary;
    setMsg(`自動設計: αj=${s.alpha_j} (≥${s.alpha_req}) ${s.ok ? "OK" : "NG"}`, !s.ok);
  } catch (e) { setMsg("自動設計失敗: " + e, true); }
}

// フォームの継手諸元で再検定（手動上書き後の確認）
function onCalcBH() {
  const params = bhFormParams();
  if (!params.H || !params.B) { setMsg("H・B を入力してください", true); return; }
  try {
    const data = BHDesign.run(params, false);
    fillBHForm(data.params);
    openBHCalc(data);
    setMsg("再検定しました");
  } catch (e) { setMsg("検定失敗: " + e, true); }
}

function openBHCalc(data) {
  _bhCalcParams = bhFormParams();
  const s = data.summary || {};
  $("bhCalcSummary").innerHTML =
    `総合 <span class="${s.ok ? "ok" : "ng"}">${s.ok ? "OK" : "NG"}</span>　`
    + `αj=${s.alpha_j} (≥${s.alpha_req})　Mj=${s.Mj}kNm　Qj=${s.Qj}kN　Lq=${s.Lq}m`;
  $("bhCalcBody").innerHTML = data.calc_html || "";
  $("bhCalcModal").classList.remove("hidden");
}

function closeBHCalc() { $("bhCalcModal").classList.add("hidden"); }

// 計算書をブラウザ印刷（→ PDFで保存）。静的版はバックエンド無しのため印刷方式。
function onBhCalcPrint() {
  const body = $("bhCalcBody").innerHTML;
  if (!body) { setMsg("先に自動設計または再検定を実行してください", true); return; }
  const esc = (s) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const summary = ($("bhCalcSummary").textContent || "").trim();
  const w = window.open("", "_blank", "width=920,height=760");
  if (!w) { setMsg("ポップアップがブロックされました。印刷を許可してください", true); return; }
  w.document.write(
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
    + "<title>BH継手計算書</title><style>"
    + "body{font-family:sans-serif;margin:18px;color:#111;background:#fff}"
    + ".psum{font-size:13px;margin:0 0 12px;padding:7px 11px;border:1px solid #ccd;border-radius:5px}"
    + BHDesign.CALC_CSS + "</style></head><body>"
    + '<div class="psum">' + esc(summary) + "</div>"
    + body + "</body></html>");
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch (e) { /* noop */ } }, 300);
}

// ===== CSV取込（Revit断面書き出し）=====
// 列: 符号,使用階,継手種別,母材鋼種,H,B,t_w,t_f,断面サイズ（UTF-8 BOM）
let csvStaged = [];
let csvLastRows = [];       // 直近パースしたCSV行（ボルト径変更で再グループ用）
let csvBoltMode = "auto";   // "auto"(M20→無ければM22) / "M16".."M24"

function _splitCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsvText(text) {
  text = String(text || "");
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // BOM除去
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { rows: [], error: "データ行がありません" };
  const header = _splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const col = {
    mark: idx("符号"), floor: idx("使用階"), type: idx("継手種別"),
    material: idx("母材鋼種"), H: idx("H"), B: idx("B"),
    tw: idx("t_w"), tf: idx("t_f"), size: idx("断面サイズ"),
  };
  for (const k of ["mark", "material", "H", "B", "tw", "tf"]) {
    if (col[k] < 0) return { rows: [], error: "想定した列が見つかりません（符号/母材鋼種/H/B/t_w/t_f）" };
  }
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const c = _splitCsvLine(lines[li]);
    const g = (i) => (i >= 0 && i < c.length ? String(c[i]).trim() : "");
    rows.push({
      mark: g(col.mark), floor: g(col.floor), type: g(col.type),
      material: g(col.material), H: g(col.H), B: g(col.B),
      tw: g(col.tw), tf: g(col.tf), size: g(col.size),
    });
  }
  return { rows, error: null };
}

// (種別,H,B,tw,tf) をカタログ(DB)照合し 3状態を返す:
//   {status:"hit", row, bolt}      … 断面あり＋選択ボルト径あり（採用可）
//   {status:"bolt_na", availBolts} … 断面はあるが選択ボルト径の値だけ無い（BH材ではない）
//   {status:"bh"}                  … 断面自体がカタログに無い（＝BH材・要検討）
// memberType = "beam"(大梁) / "column"(柱)。柱は柱カタログ、梁は梁カタログで照合する。
function catalogLookup(memberType, H, B, tw, tf, material) {
  const want = `${H}x${B}x${tw}x${tf}`.replace(/\s/g, "").toLowerCase();
  const matchShape = (rows) => (rows || []).filter(
    (r) => String(r.shape || "").replace(/\s/g, "").toLowerCase() === want);
  const search = (bolt) => {
    try { return JointData.search({ grade: "F10T", type: memberType, material, bolt }); }
    catch (e) { return { rows: [] }; }
  };
  // ① 選択ボルト径(auto=M20→無ければM22)で照合
  const bolts = (csvBoltMode === "auto") ? ["M20", "M22"] : [csvBoltMode];
  for (const bolt of bolts) {
    const hit = matchShape(search(bolt).rows)[0];
    if (hit) return { status: "hit", row: hit, bolt };
  }
  // ② 断面自体がカタログに在るか（ボルト径を問わず）
  const availBolts = [...new Set(matchShape(search(undefined).rows)
    .map((r) => r.bolt_size).filter(Boolean))];
  if (availBolts.length) return { status: "bolt_na", availBolts };  // 断面は在る／選択径だけ無い
  return { status: "bh" };                                          // 断面が無い＝BH材
}

// CSVの母材鋼種を正準グレードへ正規化する。
//  ・SN400→SN400B / SN490→SN490B / SM490→SM490A のように、A/B 表記が無くても既定サフィックスを補う。
//  ・空欄・「-1」・「構造フレーム」等の鋼種として解釈できない値(Revitで材質未設定のケース)は既定の "SN400B"。
//  ・SN490B のように既に完全表記ならそのまま採用。
// ※ Revit 側は材質未設定だと空欄/無関係な値を出しうるため、取込側(ここ)で確実に鋼種を確定させる。
const CSV_GRADE_DEFAULT = "SN400B";
function normalizeMaterialGrade(raw) {
  const s = String(raw == null ? "" : raw).toUpperCase();
  // 鋼種トークン抽出(長い接頭辞を先に): SNR/STKN/STKR/STK/SN/SM/SS/BCR/BCP/SSC + 3桁 + 任意A/B/C
  const m = s.match(/(SNR|STKN|STKR|STK|SN|SM|SS|BCR|BCP|SSC)\s*(\d{3})\s*([ABC])?/);
  if (!m) return CSV_GRADE_DEFAULT;                 // 空欄・「-1」・「構造フレーム」等 → 既定
  const prefix = m[1], num = m[2];
  let suffix = m[3] || "";
  if (!suffix) {
    // 完全表記が無い場合の既定サフィックス:
    //   SS系→無し(SS400) / SM系→A(SM490A) / それ以外(SN/SNR/BCR…)→B(SN400B/SN490B)
    if (prefix === "SS") suffix = "";
    else if (prefix === "SM") suffix = "A";
    else suffix = "B";
  }
  return prefix + num + suffix;
}

// 継手種別(CSVの値) → カタログ照合用の type。BEAM/空欄→beam, COLUMN→column, それ以外(小梁等)→null(除外)。
function csvMemberType(rawType) {
  const t = String(rawType || "").toUpperCase().trim();
  if (t === "COLUMN") return "column";
  if (t === "BEAM" || t === "") return "beam";
  return null;
}

// CSV行 → (種別,断面H,B,tw,tf,確定グレード)でグループ化＋使用符号集約＋カタログ照合
function buildCsvStage(csvRows) {
  const groups = new Map();
  for (const r of csvRows) {
    const memberType = csvMemberType(r.type);                  // 大梁(beam)・柱(column)を対象。小梁等は除外
    if (memberType === null) continue;
    if (!r.H || !r.B || !r.tw || !r.tf) continue;
    const grade = normalizeMaterialGrade(r.material);          // 母材鋼種を確定(空欄/無関係→SN400B, SN400→SN400B 等)
    const cls = /490/.test(grade) ? "SN490" : "SN400";
    const key = `${memberType}|${r.H}|${r.B}|${r.tw}|${r.tf}|${grade}`;  // 種別×断面×確定グレードでグループ化
    if (!groups.has(key)) {
      groups.set(key, { memberType, H: r.H, B: r.B, tw: r.tw, tf: r.tf, cls,
        material: grade, marks: [] });
    }
    const g = groups.get(key);
    const _fl = String(r.floor || "").trim();
    const _lab = !r.mark ? "" : (_fl ? `${r.mark} (${/^\d+$/.test(_fl) ? _fl + "FL" : _fl})` : r.mark);
    if (_lab && !g.marks.includes(_lab)) g.marks.push(_lab);  // CSVは符号順＝そのまま
  }
  const staged = [];
  for (const g of groups.values()) {
    const lk = catalogLookup(g.memberType, g.H, g.B, g.tw, g.tf, g.material);
    staged.push({
      memberType: g.memberType,                // "beam" | "column"
      typeLabel: g.memberType === "column" ? "柱" : "大梁",
      symbols: g.marks.join("・"),
      shapeStr: `H-${g.H}x${g.B}x${g.tw}x${g.tf}`,
      material: g.material,
      status: lk.status,                       // "hit" | "bolt_na" | "bh"
      hit: lk.status === "hit",
      bolt: lk.bolt || null, row: lk.row || null,
      availBolts: lk.availBolts || null,
      _h: parseFloat(g.H) || 0, _b: parseFloat(g.B) || 0,
    });
  }
  // 柱→大梁 の順、状態(一致→径のみ無→BH材)、各内はサイズ順
  const rank = (s) => (s.status === "hit" ? 0 : (s.status === "bolt_na" ? 1 : 2));
  const tOrder = (s) => (s.memberType === "column" ? 0 : 1);
  staged.sort((a, b) => (tOrder(a) - tOrder(b)) || (rank(a) - rank(b)) || (a._h - b._h) || (a._b - b._b));
  return staged;
}

function onCsvSelected(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";                                  // 同じファイルを再選択できるように
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseCsvText(reader.result);
      if (parsed.error) { setMsg("CSV取込: " + parsed.error, true); return; }
      csvLastRows = parsed.rows;
      csvStaged = buildCsvStage(csvLastRows);
      if (!csvStaged.length) { setMsg("取込対象の断面がありません", true); return; }
      openCsvStage();
    } catch (err) { setMsg("CSV取込失敗: " + err, true); }
  };
  reader.onerror = () => setMsg("ファイル読込に失敗しました", true);
  reader.readAsText(file, "utf-8");
}

function openCsvStage() { renderCsvStage(); $("csvModal").classList.remove("hidden"); }
function closeCsvStage() { $("csvModal").classList.add("hidden"); }

// ボルト径（一律）変更 → 同じCSV行で再グループ・再照合
function rebuildCsvStage() {
  if (!csvLastRows.length) return;
  csvStaged = buildCsvStage(csvLastRows);
  renderCsvStage();
}

function renderCsvStage() {
  const nHit = csvStaged.filter((s) => s.status === "hit").length;
  const nBoltNa = csvStaged.filter((s) => s.status === "bolt_na").length;
  const nBh = csvStaged.filter((s) => s.status === "bh").length;
  const nCol = csvStaged.filter((s) => s.memberType === "column").length;
  const nBeam = csvStaged.filter((s) => s.memberType === "beam").length;
  $("csvSummary").innerHTML =
    `全 <b>${csvStaged.length}</b> 断面（柱 ${nCol} / 大梁 ${nBeam}）　`
    + `<span class="csv-ok">カタログ一致 ${nHit}</span>　`
    + `<span class="csv-warn">径カタログ無 ${nBoltNa}</span>　`
    + `<span class="csv-ng">BH材(要検討) ${nBh}</span>`;
  $("csvStageBody").innerHTML = csvStaged.map((s, i) => {
    const head = (ck) =>
      `<td class="csv-ck"><input type="checkbox" class="csv-chk" data-i="${i}"${ck}></td>`
      + `<td class="csv-sym">${esc(s.symbols || "—")}</td>`
      + `<td class="csv-type">${esc(s.typeLabel)}</td>`
      + `<td class="csv-shape">${esc(s.shapeStr)}</td>`
      + `<td>${esc(s.material)}</td>`;
    if (s.status === "hit") {
      const fb = (s.row && s.row.f_bolt) ? s.row.f_bolt : "—";
      const wb = (s.row && s.row.w_bolt) ? s.row.w_bolt : "—";
      return `<tr class="csv-hit">${head(" checked")}`
        + `<td class="csv-bolt">${esc(fb)}</td><td class="csv-bolt">${esc(wb)}</td>`
        + `<td class="csv-ok">カタログ一致</td></tr>`;
    }
    if (s.status === "bolt_na") {
      const av = (s.availBolts && s.availBolts.length) ? s.availBolts.join("・") : "—";
      return `<tr class="csv-boltna">${head(" disabled")}`
        + `<td class="csv-bolt">—</td><td class="csv-bolt">—</td>`
        + `<td class="csv-warn">この径のカタログ値なし（在: ${esc(av)}）</td></tr>`;
    }
    return `<tr class="csv-bh">${head(" disabled")}`
      + `<td class="csv-bolt">—</td><td class="csv-bolt">—</td>`
      + `<td class="csv-ng">BH材のため検討が必要です</td></tr>`;
  }).join("");
  $("csvStageBody").querySelectorAll(".csv-chk").forEach((chk) => { chk.onchange = updateCsvSelCount; });
  if ($("csvBolt")) $("csvBolt").value = csvBoltMode;
  $("csvCheckAll").checked = nHit > 0;
  updateCsvSelCount();
}

function updateCsvSelCount() {
  const n = $("csvStageBody").querySelectorAll(".csv-chk:checked").length;
  $("csvSelCount").textContent = n;
  $("csvReflect").disabled = n === 0;
}

function toggleCsvAll(on) {
  $("csvStageBody").querySelectorAll(".csv-chk:not(:disabled)").forEach((chk) => { chk.checked = on; });
  updateCsvSelCount();
}

function reflectCsv() {
  const rows = [];
  $("csvStageBody").querySelectorAll(".csv-chk:checked").forEach((c) => {
    const s = csvStaged[parseInt(c.dataset.i, 10)];
    if (s && s.hit && s.row) rows.push({ ...s.row, symbols: s.symbols });
  });
  if (!rows.length) { setMsg("反映する断面を選択してください", true); return; }
  addRows(rows);
  closeCsvStage();
  setMsg(`${rows.length} 断面を選択中リストへ反映しました`);
}

// ===== selection =====
// 各行に一意の内部キー _uid を振る（複製は同じ DB id を持つため id では区別不可）
let _uidCounter = 1;
function nextUid() { return _uidCounter++; }
function findByUid(uid) { return selection.findIndex((r) => r._uid === uid); }

function addRows(rows) {
  rows.forEach((r) => {
    // 同一断面＋同一材質の二重追加のみ防ぐ（材質が違えば同じ断面でも追加できる）
    const dup = selection.some((s) => s.id === r.id && s.material === r.material);
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
  // データ実体の family（SH/BH）はバッジで明示（H統合表示でも元がSHと分かるように）
  if (r.family && String(r.family).toUpperCase() !== "H") parts.push(`<span class="badge b-fam">${esc(r.family)}</span>`);
  return parts.length ? `<div class="ref-badges">${parts.join("")}</div>` : "";
}

function renderList() {
  const body = $("listBody");
  if (!selection.length) {
    body.innerHTML = `<tr><td colspan="4" class="empty">左の「Revit CSV を取込」または「継手参照 / BH材 手動」から追加してください。</td></tr>`;
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
        <td class="symbols">${r.symbols ? esc(r.symbols) : ""}</td>
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
  updateBulkHeadBtn();
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
  const fam = String(r.family || "").toUpperCase();
  const isBH = fam === "BH";
  const canSH = fam === "SH";                 // 頭マークを SH にできるのは JSON実体が SH の断面のみ
  const head = String(r.head || (isBH ? "BH" : "H")).toUpperCase();
  $("editSecLabel").textContent = r.section || r.shape || "";
  // 頭マーク切替UIは SH実体のときだけ表示。H（圧延H）/ BH は固定なので理由を注記する
  $("editHeadGroup").classList.toggle("hidden", !canSH);
  const fixed = $("editHeadFixed");
  if (canSH) {
    fixed.classList.add("hidden");
  } else {
    fixed.classList.remove("hidden");
    fixed.textContent = isBH
      ? "この断面は BH材（DB外）のため、頭マークは「BH」固定です。"
      : "この断面は JSON実体が H（圧延H）のため、頭マークは「H」固定です（SH表示にはできません）。";
  }
  [...$("editHeadGroup").querySelectorAll("button")].forEach((b) =>
    b.classList.toggle("active", b.dataset.head === head));
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
  let r = selection[i];
  const sel = _editConds.find((c) => c.key === _editSelKey);
  const curKey = condKey(r.grade, r.material, r.bolt_size);
  if (sel && sel.key !== curKey) {
    const dispMat = (sel.cls === matClass(r.material)) ? r.material : sel.dispMat;
    const nrows = (JointData.shapeRows({ grade: sel.grade, type: r.type || "beam",
                    material: dispMat, bolt: sel.bolt_size, shape: r.shape }).rows) || [];
    const nr = nrows.find((x) => x.shape === r.shape);
    if (!nr) { setMsg("この断面はこの条件には存在しません", true); return; }
    selection[i] = { ...nr, _uid: r._uid, remarks: r.remarks };   // 継手値ごと差し替え・_uid/備考は保持
    r = selection[i];
  }
  // 頭マーク（SH実体のみ）
  if (String(r.family || "").toUpperCase() === "SH") {
    const act = $("editHeadGroup").querySelector("button.active");
    const head = act ? act.dataset.head : "H";
    r.head = head;
    r.section = head + "-" + (r.shape || "");   // 頭マーク + "-" + 断面寸法（CADにもこのheadが渡る）
  }
  renderList();
  closeEdit();
  setMsg("行を更新しました");
}

// ===== 頭マーク H/SH の一括切替（BH材は対象外） =====
// 頭マークを H/SH 切替できるのは JSON実体が SH の断面のみ（H＝圧延H・BH は固定）
function eligibleHeadRows() {
  return selection.filter((r) => String(r.family || "").toUpperCase() === "SH");
}
function toggleBulkHead() {
  const elig = eligibleHeadRows();
  if (!elig.length) { setMsg("H/SH 切替の対象がありません（BH材のみ）", true); return; }
  // 全行がSH表示なら H に、そうでなければ SH に揃える
  const allSH = elig.every((r) => String(r.head || "H").toUpperCase() === "SH");
  const target = allSH ? "H" : "SH";
  elig.forEach((r) => { r.head = target; r.section = target + "-" + (r.shape || ""); });
  renderList();
  setMsg(`頭マークを全 ${elig.length} 件 ${target} 表示にしました`);
}
// ボタンの活性/表示文字を現状に合わせて更新（renderList から呼ぶ）
function updateBulkHeadBtn() {
  const btn = $("btnBulkHead");
  if (!btn) return;
  const elig = eligibleHeadRows();
  btn.disabled = elig.length === 0;
  const allSH = elig.length > 0 && elig.every((r) => String(r.head || "H").toUpperCase() === "SH");
  btn.textContent = allSH ? "全てHに" : "全てSHに";
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
    const src = await (await fetch("./py/dxf_list.py?v=htbolt2")).text();
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

    // 「保存先を選ぶ」がON かつ対応ブラウザ(Chrome/Edge)なら、保存ダイアログでフォルダを選択
    const _fname = `鉄骨剛接合リスト_${ts()}.dxf`;
    const _pick = $("chkPickFolder") && $("chkPickFolder").checked;
    if (_pick && window.showSaveFilePicker) {
      try {
        const _h = await window.showSaveFilePicker({
          suggestedName: _fname, id: "jointlinks-dxf", startIn: "downloads",
          types: [{ description: "DXF file", accept: { "application/octet-stream": [".dxf"] } }],
        });
        const _w = await _h.createWritable();
        await _w.write(blob);
        await _w.close();
        setMsg(`${selection.length} 件を DXF で保存しました（保存先を選択）`);
        autoSnapshotHistory("DXF出力");
        return;
      } catch (err) {
        if (err && err.name === "AbortError") { setMsg("保存をキャンセルしました"); return; }
        setMsg("フォルダ選択に失敗→通常のダウンロードに切替えます: " + err, true);
      }
    } else if (_pick) {
      setMsg("このブラウザはフォルダ選択に未対応のため Downloads に保存します（Chrome/Edge推奨）", true);
    }
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
