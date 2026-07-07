/* bh_design.js — BH材（ビルトアップH）梁継手 設計エンジン（静的版）
 *
 * EXE版 bh_design.py（計算）＋ bh_report.py（計算書HTML）を **忠実にJS移植**。
 * SCSS-H97 §2.4 準拠（第1段階=許容応力度設計／第2段階=第1種保有耐力接合 α確認）。
 * 計算式は「継手の設計ver2.xlsx」に一致（Excel実例で梁43項目・柱153項目 検証済）。
 *
 * グローバル `BHDesign` を公開。app.js から次を呼ぶ:
 *   BHDesign.run(formParams, auto)  -> { params, d, calc_html, summary }
 *     auto=true : 自動設計（断面→継手諸元）  / false : フォーム値の再検定
 */
const BHDesign = (() => {
  "use strict";

  // ============================ 設定（bh_design.py と同一） ============================
  const ALPHA_REQUIRED = { 235: 1.30, 325: 1.20, 355: 1.20 };  // 必要α（基準強度Fごと）
  const SIGMA_U        = { 235: 400.0, 325: 490.0, 355: 520.0 }; // σu（引張強さ）
  const ETA = 0.5;                 // ウェブ曲げ分担率 η
  const WEB_BOLT_HPITCH = 60.0;    // ウェブボルト 材軸直角(水平)ピッチ（Excel固定値60）

  // Excel式の3つの癖（true=Excel忠実再現）
  const FLAG_B1_NO_PI        = true;  // (1) B1 に PI を付けない
  const FLAG_ZPE_EXCEL_BRANCH = true; // (2) Zpe nf<nw+2 分岐を Excel どおり
  const FLAG_PLAEW_USE_TW    = true;  // (3) plAew に tw を使う

  const BOLT_PRETENSION = {
    812: 45.8, 816: 85.2, 820: 133.0, 822: 165.0, 824: 192.0, 827: 250.0, 830: 305.0,
    1012: 56.9, 1016: 106.0, 1020: 165.0, 1022: 205.0, 1024: 238.0, 1027: 310.0, 1030: 379.0,
  };
  const BOLT_TAU = { 8: 640.0, 10: 900.0 };              // F8T→640, S10T→900
  const GRADE_DIGIT = { "F8T": 8, "S10T": 10, "F10T": 10 };

  // フランジボルト ゲージ表（DATA: Bf → G1,G2,e2,P）
  const FLANGE_GAUGE = {
    150: { G1: 90, G2: 0, e2: 30, P: 60 }, 175: { G1: 105, G2: 0, e2: 35, P: 60 },
    200: { G1: 120, G2: 0, e2: 40, P: 60 }, 225: { G1: 135, G2: 0, e2: 45, P: 60 },
    250: { G1: 150, G2: 0, e2: 50, P: 60 }, 300: { G1: 150, G2: 40, e2: 35, P: 45 },
    350: { G1: 140, G2: 70, e2: 35, P: 60 }, 400: { G1: 140, G2: 90, e2: 40, P: 60 },
  };

  const STD_T_FLANGE = [9, 12, 16, 19, 22, 25, 28, 32, 36, 40];  // フランジ添板 標準板厚
  const STD_T_WEB    = [6, 9, 12, 16, 19, 22, 25, 28];           // ウェブ添板 標準板厚

  // ============================ ヘルパ ============================
  const rnd = (x) => Math.round(x);
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  function sigma_u_of(F) { const v = SIGMA_U[rnd(F)]; return v == null ? 400.0 : v; }
  function alpha_required(F) { const v = ALPHA_REQUIRED[rnd(F)]; return v == null ? 1.30 : v; }

  function _gauge(B) {
    if (FLANGE_GAUGE[B]) return FLANGE_GAUGE[B];
    const keys = Object.keys(FLANGE_GAUGE).map(Number).sort((a, b) => a - b);
    const le = keys.filter((k) => k <= B);
    return FLANGE_GAUGE[le.length ? le[le.length - 1] : keys[0]];
  }
  function mf_from_B(B) { return B <= 300 ? 2 : (B >= 350 ? 4 : 2); }  // 300<B<350 は 2 で代用
  function g_from_B(B) { return B === 300 ? 2.75 : (B >= 350 ? 4.0 : 2.0); }
  function hole_dia(dia) { return dia + (dia > 24 ? 3 : 2); }

  function web_vpitch(H, tf, t_fi, mw) {  // ウェブボルト材軸直角(縦)ピッチ P1（Excel U7）
    if (mw <= 1) return 90.0;
    const plogic = (H - 2 * tf - 2 * t_fi - 120) / (mw - 1);
    return plogic < 90 ? 60.0 : (plogic >= 120 ? 120.0 : 90.0);
  }
  function _ej_list(mw, P1, jmax = 10) {  // 各ウェブボルト行の中立軸距離 ej
    const out = [];
    for (let j = 1; j <= jmax; j++) {
      let v;
      if (mw % 2 === 1) v = ((mw - 1) / 2 - (j - 1)) * P1;
      else v = ((mw - 2) / 2 - (j - 1)) * P1 + P1 / 2;
      out.push(v > 0 ? v : 0.0);
    }
    return out;
  }

  // ============================================================
  // Excel「梁継手」シート 忠実再現
  // ============================================================
  function check_joint(H, B, tw, tf, r, F, grade, dia, galv, opt) {
    opt = opt || {};
    const nf = opt.nf, nw = opt.nw, mw = opt.mw;
    const t_fo = opt.t_fo, t_fi = opt.t_fi, t_w = opt.t_w;
    const e = (opt.e == null) ? 40.0 : opt.e;
    H = +H; B = +B; tw = +tw; tf = +tf; r = +r; F = +F;
    const su = sigma_u_of(F);
    const alpha = (opt.alpha == null) ? alpha_required(F) : opt.alpha;
    const mf = (opt.mf == null) ? mf_from_B(B) : opt.mf;
    const gd = GRADE_DIGIT[String(grade).toUpperCase()];
    const code = gd * 100 + parseInt(dia, 10);
    const mu = galv ? 0.4 : 0.45;
    const P = _gauge(B).P;
    const g = g_from_B(B);
    const d = hole_dia(dia);
    const tau = BOLT_TAU[gd];
    const hw = H - 2 * tf;
    const arm = H - tf;

    // --- 派生ジオメトリ ---
    const P1 = web_vpitch(H, tf, t_fi, mw);                    // U7
    const ej = _ej_list(mw, P1);                               // AF7..
    const b_fi = _gauge(B).e2 * 2 + _gauge(B).G2;              // Z7 内添板幅
    const w_spl_w = (mw - 1) * P1 + 2 * e;                     // AC7 ウェブ添板幅

    // --- 断面性能（AZ7,BA7,BB7） ---
    const I0 = (B * H ** 3 - (B - tw) * (H - 2 * tf) ** 3) / 12.0;             // AZ7 [mm4]
    const flange_I_ded = 2 * g * (d * tf ** 3 / 12.0 + d * tf * ((H - tf) / 2.0) ** 2);
    let Ie;
    if (nf < nw + 2) {
      const web_I_ded = tw * d ** 3 * mw / 12.0 + 2 * sum(ej.map((x) => d * tw * x ** 2));
      Ie = I0 - flange_I_ded - web_I_ded;
    } else {
      Ie = I0 - flange_I_ded;                                                 // BA7 [mm4]
    }
    const Aew = tw * (H - 2 * tf - 2 * r) - mw * d * tw;                       // BB7 [mm2]

    // --- 設計応力（BC7,BD7,G12,H12） ---
    const Mj = Ie / (H / 2.0) * F / 1e6;                       // 設計曲げ kNm
    const Qj = Aew * F / Math.sqrt(3) / 1e3;                   // 設計せん断 kN
    const Mw = ETA * (tw * hw ** 3 / 12.0) / I0 * Mj;          // ウェブ分担
    const Mf = Mj - Mw;                                        // フランジ分担
    const Qw = Qj;

    // --- 許容: フランジ添板（J12,K12,M12） ---
    const Zef = Mf * 1e6 / F;                                  // 所要 mm3
    const Aef = t_fo * B + t_fi * b_fi * 2 - g * d * (t_fo + t_fi);  // 添板有効断面 mm2
    const ratio_f = Aef * arm / Zef;                          // ≥1
    // --- 許容: フランジボルト（O12,P12,Q12） ---
    const Rs = BOLT_PRETENSION[code] * mu * 2;                 // 2面 kN
    const need_fbolt = Math.ceil(Zef * F / Rs / 2 / 1000 / arm);
    const fbolt_ok = (mf * nf > need_fbolt);
    // --- 許容: ウェブ添板（S12,U12,V12） ---
    const tw_pl = FLAG_PLAEW_USE_TW ? tw : t_w;
    const plAew = 2 * tw_pl * (w_spl_w - mw * d) / 100.0;      // cm2
    const plAew_ok = plAew >= Aew / 100.0;
    const Zpew_req = Mw * 1e6 / F / 1000.0;                    // cm3 (U12)
    const web_hole_I = sum(ej.map((x) => 2 * t_w * d * x ** 2 * 2));
    const plZew = (2 * t_w * w_spl_w ** 3 / 12.0 - 2 * t_w * d ** 3 / 12.0 * mw
                   - web_hole_I) / (0.5 * w_spl_w) / 1000.0;   // cm3 (V12)
    const plZew_ok = plZew >= Zpew_req;
    // --- 許容: ウェブボルト合成（X12,Y12,..AC12） ---
    const S = (mw > 1 || nw > 1)
      ? ((mw * (mw - 1) * (mw + 1) * nw
          + nw * (nw - 1) * (nw + 1) * mw * (WEB_BOLT_HPITCH / P1) ** 2)
         / (6 * Math.sqrt((mw - 1) ** 2 + (WEB_BOLT_HPITCH / P1) ** 2 * (nw - 1) ** 2))
         * P1)
      : 1e9;
    const theta = ej[0] ? Math.atan(WEB_BOLT_HPITCH * (nw - 1) / 2 / ej[0]) : 0.0;
    const f1 = Zpew_req * 1000 * F / S * Math.cos(theta) / 1000;
    const f2 = Qw / (mw * nw);
    const f3 = Zpew_req * 1000 * F / S * Math.sin(theta) / 1000;
    const f_res = Math.sqrt((f2 + f3) ** 2 + f1 ** 2);
    const wbolt_ok = Rs >= f_res;

    // --- 保有耐力: 母材（G17,I17,K17,M17） ---
    const Zp0 = (B * tf * (H - tf) + 0.25 * (H - 2 * tf) ** 2 * tw
                 + 0.4292 * r * r * (H - 2 * tf - 0.4467 * r));  // BH r=0
    const Mp0 = Zp0 * F / 1e6;
    const bHw = (mw + 1) / 2 * P1;                              // J17（癖④: ODD常時TRUE）
    let Zpe;
    if (nf < nw + 2) {
      if (FLAG_ZPE_EXCEL_BRANCH) {                             // Excel忠実（tf抜け・web項tf）
        Zpe = (Zp0 - g * d * arm - bHw * d * tf * Math.floor(mw / 2)
               - 0.25 * tw * d * d * (mw % 2));
      } else {                                                 // SCSS正論
        Zpe = (Zp0 - g * d * tf * arm - hw * d * tw * Math.floor(mw / 2)
               - 0.25 * tw * d * d * (mw % 2));
      }
    } else {
      Zpe = Zp0 - g * d * tf * arm;
    }
    const M1 = Zpe * su / 1e6;

    // --- 保有耐力: 接合部 Fp=min(A1,A2,A3), Wp=min(B1,B2,B3)（AF17..AK17） ---
    const bolt_area_pi = 0.75 * 0.75 * (dia / 2) ** 2 * Math.PI;
    const bolt_area_nopi = 0.75 * 0.75 * (dia / 2) ** 2;
    const A1 = 2 * mf * nf * bolt_area_pi * tau / 1000;        // ボルト終局
    const A2 = mf * nf * e * tf * su / 1000;                   // 母材はしあき
    const A3 = Aef * su / 1000;                                // 添板有効断面
    const Fp = Math.min(A1, A2, A3);
    const b1_area = FLAG_B1_NO_PI ? bolt_area_nopi : bolt_area_pi;
    const B1 = 2 * nw * 2 * Math.floor(mw / 2) * b1_area * tau / 1000;  // ウェブボルト終局
    const B2 = nw * 2 * Math.floor(mw / 2) * e * tw * su / 1000;        // ウェブ母材はしあき
    const plHw = (mw - 1) / 2 * P1 + e;                        // AL17（癖④: ODD常時TRUE）
    const B3 = plHw / bHw * plAew * 100 * su / 1000;           // ウェブ添板
    const Wp = Math.min(B1, B2, B3);
    const M2 = (Fp * arm + 0.5 * Wp * bHw) / 1000;             // Q17 kNm
    const Mu = Math.min(M1, M2);
    const alpha_j = Mu / Mp0;
    const bend_ok = alpha_j >= alpha;

    // --- 保有耐力: せん断 Qu=min(C1,C2,C3), Lq（U17..AA17） ---
    const C1 = plAew * 100 * su / Math.sqrt(3) / 1000;
    const C2 = Aew * su / Math.sqrt(3) / 1000;
    const C3 = 2 * nw * 2 * Math.floor(mw / 2) * bolt_area_pi * tau / 1000;
    const Qu = Math.min(C1, C2, C3);
    const Lq = Qu ? 2 * alpha * Mp0 / Qu : 0.0;

    return {
      mf, P, g, d, mu, P1, ej, b_fi, w_spl_w,
      I0, Ie, Aew, Mj, Qj, Mw, Mf, Qw,
      Zef, Aef, ratio_f, Rs, need_fbolt, nfmf: mf * nf, fbolt_ok,
      plAew, plAew_ok, Zpew_req, plZew, plZew_ok,
      S, theta, f1, f2, f3, f_res, wbolt_ok,
      Zp0, Mp0, bHw, Zpe, su, M1,
      A1, A2, A3, Fp, B1, B2, B3, Wp, plHw,
      M2, Mu, alpha_j, alpha_req: alpha, bend_ok,
      C1, C2, C3, Qu, Lq,
      allow_ok: (ratio_f >= 1 && fbolt_ok && plAew_ok && plZew_ok && wbolt_ok),
    };
  }

  // ============================================================
  // 添板ジオメトリ／評価／自動設計（BH: r=0）
  // ============================================================
  function _splice_geometry(c, B, nf, nw, t_fo, t_fi, t_w, P, e) {
    const fl_len = (40 + (nf - 1) * P + 40) * 2 + 10;                 // AA7 フランジ添板長
    const web_len = (40 * 2 + (nw - 1) * WEB_BOLT_HPITCH) * 2 + 10;   // AD7 ウェブ添板長
    return {
      spl_flange_outer: { t: t_fo, b: B, L: fl_len, n: 1 },          // 外フランジ添板
      spl_flange_inner: { t: t_fi, b: c.b_fi, L: fl_len, n: 2 },     // 内フランジ添板×2
      spl_web: { t: t_w, b: c.w_spl_w, L: web_len, n: 2 },           // ウェブ添板×2
    };
  }

  function evaluate_joint(H, B, tw, tf, r, F, grade, dia, galv, opt) {
    opt = opt || {};
    const e = (opt.e == null) ? 40.0 : opt.e;
    const c = check_joint(H, B, tw, tf, r, F, grade, dia, galv, {
      nf: opt.nf, nw: opt.nw, mw: opt.mw, t_fo: opt.t_fo, t_fi: opt.t_fi, t_w: opt.t_w,
      e, alpha: opt.alpha,
    });
    const P = _gauge(B).P;
    Object.assign(c, {
      nf: opt.nf, mf: mf_from_B(B), nw: opt.nw, mw: opt.mw,
      t_fo: opt.t_fo, t_fi: opt.t_fi, t_w: opt.t_w,
      grade, dia, F: +F, B: +B, H: +H, tw: +tw, tf: +tf, r: +r,
      galv, e, P, ok: (c.allow_ok && c.bend_ok),
    });
    Object.assign(c, _splice_geometry(c, B, opt.nf, opt.nw, opt.t_fo, opt.t_fi, opt.t_w, P, e));
    return c;
  }

  function design_bh(H, B, tw, tf, opt) {
    opt = opt || {};
    const F = (opt.F == null) ? 325 : opt.F;
    const grade = opt.grade || "F8T";
    const dia = (opt.dia == null) ? 22 : opt.dia;
    const galv = !!opt.galv;
    const r = (opt.r == null) ? 0.0 : opt.r;
    const e = (opt.e == null) ? 40.0 : opt.e;
    const nf_max = (opt.nf_max == null) ? 12 : opt.nf_max;
    const nw_max = (opt.nw_max == null) ? 12 : opt.nw_max;
    let mw = opt.mw;
    if (mw == null) mw = Math.max(2, Math.min(Math.floor((H - 2 * tf - 80) / 90) + 1, 8));

    const chk = (nf, nw, t_fo, t_fi, t_w) =>
      check_joint(H, B, tw, tf, r, F, grade, dia, galv, { nf, nw, mw, t_fo, t_fi, t_w, e });

    const pick_flange_t = (nf, nw) => {
      for (const t of STD_T_FLANGE) {
        const c = chk(nf, nw, t, t, 9);
        if (c.ratio_f >= 1.0 && c.A3 >= Math.min(c.A1, c.A2)) return t;
      }
      return STD_T_FLANGE[STD_T_FLANGE.length - 1];
    };
    const pick_web_t = (nf, nw, t_f) => {
      for (const t of STD_T_WEB) {
        const c = chk(nf, nw, t_f, t_f, t);
        if (c.plZew_ok && c.plAew_ok) return t;
      }
      return STD_T_WEB[STD_T_WEB.length - 1];
    };

    let best = null;
    for (let nw = 2; nw <= nw_max && !best; nw++) {
      for (let nf = 2; nf <= nf_max; nf++) {
        const t_f = pick_flange_t(nf, nw);
        const t_w = pick_web_t(nf, nw, t_f);
        const c = chk(nf, nw, t_f, t_f, t_w);
        if (c.allow_ok && c.bend_ok) { best = { nf, nw, t_f, t_w }; break; }
      }
    }
    if (!best) {                                        // 未達: 最大本数で返す
      const nf = nf_max, nw = nw_max;
      const t_f = pick_flange_t(nf, nw);
      const t_w = pick_web_t(nf, nw, t_f);
      best = { nf, nw, t_f, t_w };
    }
    return evaluate_joint(H, B, tw, tf, r, F, grade, dia, galv, {
      nf: best.nf, nw: best.nw, mw, t_fo: best.t_f, t_fi: best.t_f, t_w: best.t_w, e,
    });
  }

  function _numfmt(v) { const f = +v; return f === Math.trunc(f) ? Math.trunc(f) : f; }

  function to_row_params(d) {
    const fo = d.spl_flange_outer, fi = d.spl_flange_inner, w = d.spl_web;
    const F = rnd(d.F);
    const material = F >= 300 ? "SN490" : "SN400";
    return {
      H: Math.trunc(d.H), B: Math.trunc(d.B), tw: _numfmt(d.tw), tf: _numfmt(d.tf),
      family: "BH", type: "beam", material, grade: "",
      bolt_size: "M" + Math.trunc(d.dia),
      n_fbolt: d.nf, m_fbolt: d.mf,
      t_fspl1_mm: Math.trunc(fo.t), w_fspl1_mm: Math.trunc(fo.b),
      t_fspl2_mm: Math.trunc(fi.t), w_fspl2_mm: Math.trunc(fi.b),
      l_fspl_mm: Math.trunc(fo.L),
      m_wbolt: d.mw, n_wbolt: d.nw, p_wbolt_mm: rnd(d.P1),
      t_wspl_mm: Math.trunc(w.t), l_wspl_mm: Math.trunc(w.L), w_wspl_mm: Math.trunc(w.b),
    };
  }

  // ============================================================
  // 計算書（検定表）HTML — bh_report.py 忠実移植
  // ============================================================
  function _fmt(v, nd = 1) {
    const f = Number(v);
    if (!isFinite(f)) return String(v);
    if (f === Math.trunc(f) && Math.abs(f) < 1e7) return String(Math.trunc(f));
    return f.toLocaleString("en-US", { minimumFractionDigits: nd, maximumFractionDigits: nd });
  }
  const _ok = (flag) => (flag ? "OK" : "NG");

  function build_sheet_model(d) {
    const F = rnd(d.F);
    const su = ("su" in d) ? rnd(d.su) : sigma_u_of(F);
    const head = `BH-${Math.trunc(d.H)}x${Math.trunc(d.B)}x${_numfmt(d.tw)}x${_numfmt(d.tf)}`;
    const fo = d.spl_flange_outer, fi = d.spl_flange_inner, w = d.spl_web;
    const mu = d.galv ? 0.4 : 0.45;

    const info = [
      ["断面", `${head}（BH材, F=${F}, σu=${su} N/mm²）`],
      ["高力ボルト", `${d.grade}-M${Math.trunc(d.dia)}（μ=${mu}, Rs=${_fmt(d.Rs)} kN/本）`],
      ["フランジ継手",
        `${d.nf}×${d.mf} 本／添板 外PL-${Math.trunc(fo.t)}×${Math.trunc(fo.b)}, `
        + `内2PL-${Math.trunc(fi.t)}×${Math.trunc(fi.b)}, L=${Math.trunc(fo.L)}`],
      ["ウェブ継手",
        `${d.nw}×${d.mw} 本／添板 2PL-${Math.trunc(w.t)}×${Math.trunc(w.L)}×${Math.trunc(w.b)}, `
        + `P1=${rnd(d.P1)}`],
    ];
    const allow = [
      ["設計用曲げ", "Mj = Ze·F", `${_fmt(d.Mj)} kNm`, ""],
      ["設計用せん断", "Qj = Aew·F/√3", `${_fmt(d.Qj)} kN`, ""],
      ["曲げ分担", "Mf / Mw", `${_fmt(d.Mf)} / ${_fmt(d.Mw)} kNm`, ""],
      ["フランジ添板", "Aef·(H−tf)/Zef ≥ 1", `${_fmt(d.ratio_f, 2)}`, _ok(d.ratio_f >= 1)],
      ["フランジボルト", "nf·mf ≥ 所要", `${d.nfmf} ≥ ${d.need_fbolt}`, _ok(d.fbolt_ok)],
      ["ウェブ添板(断面)", "plAew ≥ Aew", `${_fmt(d.plAew)} ≥ ${_fmt(d.Aew / 100)} cm²`, _ok(d.plAew_ok)],
      ["ウェブ添板(係数)", "plZew ≥ Z'ew", `${_fmt(d.plZew)} ≥ ${_fmt(d.Zpew_req)} cm³`, _ok(d.plZew_ok)],
      ["ウェブボルト", "合成 f ≤ Rs",
        `${_fmt(d.f_res != null ? d.f_res : d.Qb)} ≤ ${_fmt(d.Rs)} kN`, _ok(d.wbolt_ok)],
    ];
    const cap = [
      ["母材 全塑性", "Mp0 = Zp0·σy", `${_fmt(d.Mp0)} kNm`, ""],
      ["母材(孔控除)", "M1 = Zpe·σu", `${_fmt(d.M1)} kNm`, ""],
      ["接合部 フランジ", "Fp = min(A1,A2,A3)", `${_fmt(d.Fp)} kN`, ""],
      ["接合部 ウェブ", "Wp = min(B1,B2,B3)", `${_fmt(d.Wp)} kN`, ""],
      ["接合部耐力", "M2 = (Fp·(H−tf)+0.5·Wp·bHw)/1000", `${_fmt(d.M2)} kNm`, ""],
      ["終局曲げ", "Mu = min(M1, M2)", `${_fmt(d.Mu)} kNm`, ""],
      ["曲げ α", "αj = Mu/Mp0 ≥ α", `${_fmt(d.alpha_j, 3)} ≥ ${d.alpha_req}`, _ok(d.bend_ok)],
      ["せん断 Qu", "Qu = min(C1,C2,C3)", `${_fmt(d.Qu)} kN`, ""],
      ["最小せん断スパン", "Lq = 2·α·Mp0/Qu", `${_fmt(d.Lq, 2)} m`, ""],
    ];
    const overall = ("ok" in d) ? d.ok : (d.bend_ok && d.allow_ok);
    return { title: "BH梁継手 計算書（検定表）", head, info, allow, cap, overall: !!overall };
  }

  function calc_sheet_html(d) {
    const m = build_sheet_model(d);
    const rows = (items) => items.map((it) => {
      if (it.length === 2) return `<tr><th>${it[0]}</th><td colspan="3">${it[1]}</td></tr>`;
      const [nm, ex, val, jd] = it;
      const cls = jd === "OK" ? "ok" : (jd === "NG" ? "ng" : "");
      const badge = jd ? `<span class="badge ${cls}">${jd}</span>` : "";
      return `<tr><th>${nm}</th><td class='ex'>${ex}</td>`
        + `<td class='val'>${val}</td><td class='jd'>${badge}</td></tr>`;
    }).join("\n");
    const ov = m.overall ? "OK" : "NG";
    return `<div class="bh-calc">
  <h2>${m.title} <span class="overall ${ov.toLowerCase()}">総合 ${ov}</span></h2>
  <table class="info">${rows(m.info)}</table>
  <h3>第1段階　許容応力度設計（SCSS §2.4.1）</h3>
  <table class="chk">${rows(m.allow)}</table>
  <h3>第2段階　第1種保有耐力接合 α確認（SCSS §2.4.2）</h3>
  <table class="chk">${rows(m.cap)}</table>
  <p class="note">準拠: SCSS-H97 §2.4 ／ 計算式は「継手の設計ver2.xlsx」に一致。</p>
</div>`;
  }

  // 印刷（ブラウザ→PDF）用の自己完結CSS（bh_report.py CALC_CSS 相当）
  const CALC_CSS = `
.bh-calc{font-family:sans-serif;color:#111;max-width:780px}
.bh-calc h2{font-size:16px;margin:6px 0}
.bh-calc h3{font-size:13px;margin:12px 0 4px;color:#1a3a5c;border-bottom:1px solid #cdd}
.bh-calc table{border-collapse:collapse;width:100%;font-size:12px}
.bh-calc th,.bh-calc td{border:1px solid #bbc;padding:3px 7px;text-align:left;vertical-align:middle}
.bh-calc th{background:#eef2f6;white-space:nowrap;width:120px}
.bh-calc td.ex{color:#445;font-family:monospace}
.bh-calc td.val{text-align:right;white-space:nowrap}
.bh-calc td.jd{width:42px;text-align:center}
.bh-calc .badge{font-weight:bold;padding:1px 6px;border-radius:3px;font-size:11px}
.bh-calc .badge.ok{background:#d6f5dd;color:#1a6b2e}
.bh-calc .badge.ng{background:#fadbd8;color:#a11}
.bh-calc .overall{font-size:12px;padding:2px 8px;border-radius:4px}
.bh-calc .overall.ok{background:#1a6b2e;color:#fff}
.bh-calc .overall.ng{background:#a11;color:#fff}
.bh-calc .note{font-size:10px;color:#667;margin-top:8px}`;

  // ============================================================
  // フォーム params → 計算 → 返却ペイロード（server.py _bh_evaluate/_bh_result_payload 相当）
  // ============================================================
  function _f_from_material(m) { return String(m).toUpperCase().includes("490") ? 325.0 : 235.0; }
  function _dia_from_bolt(b) {
    const digits = String(b == null ? "" : b).replace(/\D/g, "");
    return digits ? parseInt(digits, 10) : 22;
  }

  function run(formParams, auto) {
    const p = formParams || {};
    const H = +p.H, B = +p.B, tw = +p.tw, tf = +p.tf;
    if (!(H && B && tw && tf)) throw new Error("H・B・t_w・t_f が必要です");
    const F = _f_from_material(p.material);
    const grade = (p.grade || "F10T").toUpperCase();
    const dia = _dia_from_bolt(p.bolt_size || p.bolt);
    const galv = !!p.galv;
    let d;
    if (auto) {
      d = design_bh(H, B, tw, tf, { F, grade, dia, galv });
    } else {
      const iv = (k, def = 0) => { const v = parseInt(p[k], 10); return Number.isFinite(v) ? v : def; };
      const fv = (k, def = 0) => { const v = parseFloat(p[k]); return Number.isFinite(v) ? v : def; };
      d = evaluate_joint(H, B, tw, tf, 0.0, F, grade, dia, galv, {
        nf: iv("n_fbolt"), nw: iv("n_wbolt"), mw: iv("m_wbolt"),
        t_fo: fv("t_fspl1_mm"), t_fi: fv("t_fspl2_mm"), t_w: fv("t_wspl_mm"),
      });
    }
    return {
      params: to_row_params(d),
      d,
      calc_html: calc_sheet_html(d),
      summary: {
        alpha_j: Math.round(d.alpha_j * 1000) / 1000, alpha_req: d.alpha_req,
        Lq: Math.round(d.Lq * 100) / 100, Mj: Math.round(d.Mj * 10) / 10,
        Qj: Math.round(d.Qj * 10) / 10,
        ok: !!(("ok" in d) ? d.ok : (d.bend_ok && d.allow_ok)),
      },
    };
  }

  return {
    run, check_joint, evaluate_joint, design_bh, to_row_params,
    calc_sheet_html, build_sheet_model, CALC_CSS,
    _f_from_material, _dia_from_bolt,
  };
})();

if (typeof window !== "undefined") window.BHDesign = BHDesign;
if (typeof module !== "undefined" && module.exports) module.exports = BHDesign;
