"use strict";
/* =====================================================================
 * joint_data.js  ―  データ層（サーバー不要のブラウザ版）
 *
 * 元 Python: joint_list_web/data.py を 1:1 で移植したもの。
 *   - サーバー(server.py)の /api/facets, /api/search, /api/shapes,
 *     /api/bh_row が行っていた計算を、すべてブラウザ内で実行する。
 *   - DB(SCSS_F8T.F10T.json) は起動時に fetch で読み込み、メモリ上に保持。
 *   - DXF出力(/api/export 相当)は dxf.js（Stage 3）で別途実装する。
 *
 * グローバル `JointData` を公開し、app.js から呼び出す。
 * ===================================================================== */

const JointData = (() => {
  // 空欄表記（旧「ー」→ 見やすい em-dash「—」）
  const EMPTY_MARK = "—";
  // データに無くてもUIに必ず出す既知の選択肢
  const KNOWN_TYPES = ["beam", "column"];
  // SS400 はマーク非表示専用の概念のため Material には含めない
  const KNOWN_MATERIALS = ["SN400", "SN490"];
  // DBファイルの場所（このフォルダ内の data/ に同梱）
  const DB_URL = "./data/SCSS_F8T.F10T.json";
  const ENC_URL = "./data/SCSS_F8T.F10T.enc";   // 公開配布用の暗号化データ(AES-GCM)

  // 読み込んだDB（フラットなレコード配列）
  let RECORDS = [];

  // ---- 数値ヘルパ（data.py の _intnum 等に対応）----

  // 整数化（"5.5"→5, ""→0, "16"→16）。プレート寸法・本数用。
  function _intnum(v) {
    const f = parseFloat(String(v));
    return Number.isNaN(f) ? 0 : Math.trunc(f);
  }

  // ---- マーク（材質→形状・中央文字）----

  // 材質マーク形状: SS系→none / SM系→diamond(◇) / 490→circle(○) / それ以外→square(□)
  function mark_type(material) {
    const m = String(material).toUpperCase();
    if (m.startsWith("SS")) return "none";
    if (m.startsWith("SM")) return "diamond";
    if (m.includes("490")) return "circle";
    return "square";
  }
  // マーク中央の文字: 語尾 'A' → 'A'、それ以外 → 'B'
  function mark_letter(material) {
    return String(material).toUpperCase().endsWith("A") ? "A" : "B";
  }

  // ---- ウェブ継手 E1（H鋼外面〜上 縁端距離）----
  // m偶数: center = p/2 + p*(m/2 - 1) / m奇数: center = p*(m-1)/2 / E1 = H/2 - center
  function compute_e1(rec) {
    const shape = String(rec.shape || "");
    const H = parseFloat(shape.split("x")[0]);
    const m = Math.trunc(parseFloat(rec.m_wbolt != null ? rec.m_wbolt : 0));
    const p = parseFloat(rec.p_wbolt_mm != null ? rec.p_wbolt_mm : 0);
    if (Number.isNaN(H) || Number.isNaN(m) || Number.isNaN(p)) return "";
    if (m < 1) return "";
    let center;
    if (m % 2 === 0) center = p / 2 + p * (m / 2 - 1);
    else center = p * (m - 1) / 2;
    const e1 = H / 2 - center;
    // E1 は H/2 −（p/2 の倍数）で必ず 0.5mm 刻みの量。従来は _pyround(偶数丸め)で整数化しており
    // 87.5 → 88 のように半値が誤って繰り上がっていた（例: 175x175x7.5x11, m_wbolt=1 → 正 87.5）。
    // 0.5刻みへ正規化(浮動小数の塵除去)し、半値はそのまま "87.5"、整数は "88" 等で表示する。
    return String(Math.round(e1 * 2) / 2);
  }

  // ---- ボルト・プレート表記（data.py の _bolt_text / _plate_text）----

  // 本数0または径0なら "-"、それ以外 "{count}-M{d}"
  function _bolt_text(count, bolt_size) {
    const d = _intnum(String(bolt_size).toUpperCase().replace(/M/g, ""));
    if (count === 0 || d === 0) return "-";
    return `${Math.trunc(count)}-M${d}`;
  }

  // t==0なら "—"、l>0なら3寸法(txbxl)、それ以外2寸法(txb)。n==1→"PL-…" / n>=2→"{n}PL-…"
  function _plate_text(t, b, l = null, n = 1) {
    t = _intnum(t);
    b = _intnum(b);
    if (t === 0) return EMPTY_MARK;
    let core;
    if (l !== null && l !== undefined && _intnum(l) > 0) {
      core = `${t}x${b}x${_intnum(l)}`;
    } else {
      core = `${t}x${b}`;
    }
    return (n === 1) ? ("PL-" + core) : `${Math.trunc(n)}PL-${core}`;
  }

  // ---- 断面の「頭マーク」(section列の接頭辞) 既定値。BH(手動ビルトアップH)→'BH' / それ以外→'H' ----
  // ※ JSON実体が SH の断面でも既定は 'H' に統合表示（data.py head_for と同仕様）。
  function head_for(family) {
    return String(family).toUpperCase() === "BH" ? "BH" : "H";
  }

  // ---- 1レコード → 「鉄骨剛接合リスト」1行ぶんの表示データ ----
  // material_override: 画面で選んだグレード(SS400/SN400B/…)。指定時は表示・マークへ反映。
  // head_override: 頭マーク('H'/'SH'/'BH')を明示指定。未指定なら family から既定値(head_for)。
  function to_list_row(rec, material_override = null, head_override = null) {
    const bolt = (rec.bolt_size != null) ? rec.bolt_size : "";
    const material = material_override || ((rec.material != null) ? rec.material : "");
    const family = (rec.family != null) ? rec.family : "";
    const head = head_override || head_for(family);
    const n_fb = _intnum(rec.n_fbolt);
    const m_fb = _intnum(rec.m_fbolt);
    const m_wb = _intnum(rec.m_wbolt);
    const n_wb = _intnum(rec.n_wbolt);
    const lf = _intnum(rec.l_fspl_mm);
    const p1 = _intnum(rec.p_wbolt_mm);

    return {
      id: rec.id,
      grade: (rec.grade != null) ? rec.grade : "",
      type: (rec.type != null) ? rec.type : "",   // beam/column（条件バッジ・条件変更用）
      material: material,
      bolt_size: bolt,
      family: family,                          // データ実体 H / SH / BH（保持）
      head: head,                              // 表示用 頭マーク H / SH / BH
      shape: (rec.shape != null) ? rec.shape : "",
      // --- 表示列 ---
      mark: mark_type(material),               // square/circle/diamond/none
      mark_letter: mark_letter(material),       // 'A' / 'B'
      section: head + "-" + String((rec.shape != null) ? rec.shape : ""),
      // フランジ継手
      f_bolt: _bolt_text(n_fb * m_fb, bolt),
      spl1: _plate_text(rec.t_fspl1_mm, rec.w_fspl1_mm, null, 1),
      spl2: _plate_text(rec.t_fspl2_mm, rec.w_fspl2_mm, null, 2),
      spl_l: String(lf),
      // ウェブ継手
      w_bolt: _bolt_text(n_wb * m_wb, bolt),
      N: String(n_wb),
      M: String(m_wb),
      E1: compute_e1(rec),
      P1: String(p1),
      // SPL-3: "2PL-{t}x{w_wspl}x{l_wspl}"（例 t=9, w_wspl=260, l_wspl=170 → 2PL-9x260x170）。
      // w_wspl_mm が無い個体は w_wspl1_mm にフォールバック。以前は l_wspl と w_wspl が逆だったのを修正。
      spl3: _plate_text(rec.t_wspl_mm, (rec.w_wspl_mm || rec.w_wspl1_mm),
                        rec.l_wspl_mm, 2),
    };
  }

  // ---- 検索（完全一致＋shape部分一致＋寸法の前方一致）----
  function search(records, kw = {}) {
    const { grade, type: mtype, material, bolt, shape, family, h, b, tw, tf,
            hBuckets, bBuckets } = kw;
    let out = records;
    if (grade)  out = out.filter((r) => r.grade === grade);
    if (mtype)  out = out.filter((r) => r.type === mtype);
    if (material) {
      // データ材質は SN400/SN490 の2クラス。画面グレードは 490系→SN490, それ以外→SN400 で絞る。
      const want490 = String(material).toUpperCase().includes("490");
      out = out.filter((r) => (String(r.material || "").toUpperCase().includes("490")) === want490);
    }
    if (bolt)   out = out.filter((r) => r.bolt_size === bolt);
    if (family) out = out.filter((r) => r.family === family);
    if (shape) {
      const q = String(shape).replace(/ /g, "").toLowerCase();
      out = out.filter((r) => String(r.shape || "").toLowerCase().includes(q));
    }
    const dims = [h, b, tw, tf];
    const hasDim = dims.some((d) => d !== null && d !== undefined && d !== "");
    if (hasDim) {
      out = out.filter((r) => {
        const toks = String(r.shape || "").split("x");
        for (let i = 0; i < dims.length; i++) {
          const d = dims[i];
          if (d === null || d === undefined || d === "") continue;
          if (i >= toks.length || !String(toks[i]).startsWith(String(d).trim())) return false;
        }
        return true;
      });
    }
    // 100刻みトグル。バケット境界を下へシフト: H=floor((H+20)/100)*100、B=floor((B+10)/100)*100。
    //   各バケットVの範囲 → H:[V-20,V+80)、B:[V-10,V+90)。例: H200=180〜279、H=428→400、H=388→400。
    //   複数選択は OR。hundreds() の候補算出と同じ式で整合させる。
    const hb = Array.isArray(hBuckets) ? hBuckets.map(Number).filter((n) => !Number.isNaN(n)) : [];
    const bb = Array.isArray(bBuckets) ? bBuckets.map(Number).filter((n) => !Number.isNaN(n)) : [];
    if (hb.length || bb.length) {
      const band = (v, off) => { const n = parseFloat(v); return Number.isNaN(n) ? null : Math.floor((n + off) / 100) * 100; };
      out = out.filter((r) => {
        const toks = String(r.shape || "").split("x");
        if (hb.length) { const H = band(toks[0], 20); if (H === null || !hb.includes(H)) return false; }
        if (bb.length) { const B = band(toks[1], 10); if (B === null || !bb.includes(B)) return false; }
        return true;
      });
    }
    return out;
  }

  // ---- H/B の「百の位」バケット候補（100刻みトグル用）----
  // 寸法テキスト(h/b/tw/tf)やバケット選択は無視し、種別/鋼種/等級/ボルトの母集合から算出。
  function hundreds(records, filters = {}) {
    const base = search(records, {
      grade: filters.grade, type: filters.type, material: filters.material,
      bolt: filters.bolt, family: filters.family, shape: filters.shape,
    });
    const hs = new Set(), bs = new Set();
    for (const r of base) {
      const toks = String(r.shape || "").split("x");
      const H = parseFloat(toks[0]), B = parseFloat(toks[1]);
      if (!Number.isNaN(H)) hs.add(Math.floor((H + 20) / 100) * 100);   // search と同じ -20 シフト境界
      if (!Number.isNaN(B)) bs.add(Math.floor((B + 10) / 100) * 100);   // search と同じ -10 シフト境界
    }
    const asc = (x, y) => x - y;
    return { h: [...hs].sort(asc), b: [...bs].sort(asc) };
  }

  // ---- 断面のサイズ順ソート用キー比較（HxBxt_wxt_f を数値比較）----
  function _shapeKey(shape) {
    const t = String(shape).split("x");
    const n = (i) => { const v = parseFloat(t[i]); return Number.isNaN(v) ? 0 : v; };
    return [n(0), n(1), n(2), n(3)];
  }
  function _cmpShape(a, b) {
    const ka = _shapeKey(a), kb = _shapeKey(b);
    for (let i = 0; i < 4; i++) { if (ka[i] !== kb[i]) return ka[i] - kb[i]; }
    return 0;
  }

  // ---- 絞り込み結果を「断面ごとに重複なし・サイズ順」で返す（Shapeドロップダウン用）----
  function shape_rows(records, filters = {}) {
    const hits = search(records, filters);
    const seen = new Set();
    const uniq = [];
    for (const r of hits) {
      const s = r.shape || "";
      if (seen.has(s)) continue;
      seen.add(s);
      uniq.push(r);
    }
    uniq.sort((a, b) => _cmpShape(a.shape || "", b.shape || ""));
    const override = filters.material || null;  // 選んだグレードを表示・マークへ反映
    return uniq.map((r) => to_list_row(r, override));
  }

  // ---- UIの絞り込み候補（重複なし・ソート済み）----
  function facets(records) {
    const uniq = (key) => [...new Set(records.map((r) => r[key] || "").filter((v) => v))].sort();
    const types = [...new Set([...uniq("type"), ...KNOWN_TYPES])].sort();
    const mats  = [...new Set([...uniq("material"), ...KNOWN_MATERIALS])].sort();
    return {
      grade: uniq("grade"),
      type: types,
      material: mats,
      bolt_size: uniq("bolt_size"),
      family: uniq("family"),
    };
  }

  // ---- id配列の順序を保ってレコードを取得 ----
  function get_by_ids(records, ids) {
    const by = new Map(records.map((r) => [r.id, r]));
    const out = [];
    for (const i of ids) {
      const r = by.get(parseInt(i, 10));
      if (r) out.push(r);
    }
    return out;
  }

  // ---- BH材（DBに無い断面）の手動入力 → リスト1行を組み立て ----
  function build_row_from_params(params, row_id = null) {
    const rec = Object.assign({}, params || {});
    if (!rec.shape) {
      if (rec.H != null && rec.B != null && rec.tw != null && rec.tf != null) {
        rec.shape = `${rec.H}x${rec.B}x${rec.tw}x${rec.tf}`;
      } else {
        rec.shape = "";
      }
    }
    const setdefault = (k, v) => { if (!(k in rec)) rec[k] = v; };
    setdefault("family", "BH");
    setdefault("type", "beam");
    setdefault("grade", "");
    setdefault("material", "");
    setdefault("bolt_size", "");
    rec.id = (row_id != null) ? row_id : -1;
    const row = to_list_row(rec);
    if (rec.remarks) row.remarks = rec.remarks;
    return row;
  }

  // ---- DB読み込み（[{F10T:[group,…]},{F8T:[…]}] → フラットなレコード配列）----
  function _flatten(raw) {
    const records = [];
    let rid = 0;
    for (const block of raw) {                 // [{"F10T":[...]}, {"F8T":[...]}]
      for (const grade of Object.keys(block)) {
        const groups = block[grade] || [];
        for (const g of groups) {
          const cs = g.common_settings || {};
          // メンバーは "beams"(梁) または "columns"(柱) に格納される。
          // 旧実装は "beams" のみ読んでいたため type=column が常に0件だった（EXE版 data.py と同修正）。
          const members = [...(g.beams || []), ...(g.columns || [])];
          for (const b of members) {
            const rec = Object.assign({}, b);
            rec.id = rid;
            rec.grade = grade;
            rec.type = cs.type || "";
            rec.material = cs.material || "";
            rec.bolt_size = cs.bolt_size || "";
            records.push(rec);
            rid += 1;
          }
        }
      }
    }
    return records;
  }

  async function loadDB(url = DB_URL) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("DB読込失敗 HTTP " + res.status);
    const raw = await res.json();
    RECORDS = _flatten(raw);
    return RECORDS;
  }

  // ===== 暗号化DB（公開配布用）: PBKDF2-SHA256 + AES-GCM をブラウザ内で復号 =====
  // Node の _encrypt_data.mjs と同一方式。パスワード誤りは AES-GCM 認証失敗で検知。
  async function _deriveKey(password, salt, iter) {
    const base = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }
  async function loadEncrypted(password, url = ENC_URL) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("暗号データ読込失敗 HTTP " + res.status);
    const m = await res.json();
    const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const key = await _deriveKey(password, b64(m.salt), m.iter);
    let ptBuf;
    try {
      ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(m.iv) }, key, b64(m.ct));
    } catch (_) {
      const e = new Error("PASSWORD_WRONG"); e.code = "PASSWORD_WRONG"; throw e;
    }
    RECORDS = _flatten(JSON.parse(new TextDecoder().decode(ptBuf)));
    return RECORDS;
  }

  // ===== 公開API（server.py の各エンドポイント相当）=====
  return {
    loadDB,
    loadEncrypted,
    // GET /api/facets
    facets: () => facets(RECORDS),
    // H/B の 100刻みバケット候補 {h:[...], b:[...]}（現在の種別/鋼種/等級/ボルト条件で算出）
    hundreds: (filters) => hundreds(RECORDS, filters || {}),
    // GET /api/shapes  → {count, rows}（断面ごと重複なし・サイズ順）
    shapeRows: (filters) => {
      const rows = shape_rows(RECORDS, filters || {});
      return { count: rows.length, rows };
    },
    // GET /api/search  → {count, rows}（条件一致の全行）
    search: (filters) => {
      const f = filters || {};
      const rows = search(RECORDS, f).map((r) => to_list_row(r, f.material || null));
      return { count: rows.length, rows };
    },
    // POST /api/bh_row → row
    buildRowFromParams: (params, id) => build_row_from_params(params, id),
    // 出力用（dxf.js / Stage3 で使用）
    getByIds: (ids) => get_by_ids(RECORDS, ids),
    toListRow: to_list_row,
    get records() { return RECORDS; },
  };
})();
