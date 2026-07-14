"""DXF生成: 「鉄骨剛接合リスト」表を ezdxf で作図する。

- 回収したレイヤー設定を適用（TEXT=yellow/ACI2, 0=white/ACI7, JOINT=magenta/ACI6,
  DEFPOINTS=gray/ACI8）。表罫線は仮レイヤ "LIST"(緑/ACI3)。
- 行高さ=210（ユーザー指定）。
- 複数レコードを縦に連結して 1 ファイルに出力（= 複数同時出力）。

座標系: 表の左上を原点(0,0)とし、右方向 +X / 下方向 -Y で展開。
"""

import ezdxf
from ezdxf.enums import TextEntityAlignment

# ============================================================
# レイヤー設定（過去API作成時の設定を踏襲）
#   ※ "LIST"(表罫線) は元設定に無いため仮置き。色/名称は調整可。
# ============================================================
LAYERS = [
    # name,        color(ACI), linetype
    ("TEXT",       2, "Continuous"),   # 文字（黄）
    ("0",          7, "Continuous"),   # 継手セット（白）
    ("JOINT",      6, "Continuous"),   # 継手ブロック枠（マゼンタ）
    ("DEFPOINTS",  8, "Continuous"),   # 基点（灰・非プロット）
    ("LIST",       3, "Continuous"),   # 表罫線（緑）★仮
]

# 文字を載せるレイヤ・罫線を載せるレイヤ
LYR_TEXT = "TEXT"
LYR_GRID = "LIST"
LYR_MARK = "TEXT"   # □○Bマーク（必要なら "0" 等へ変更可）

# テキストスタイル
STYLE_ASCII = "_Kozo_Romans"   # 寸法値など ASCII（romans.shx）
STYLE_JP = "_Kozo_JP"          # 日本語見出し（MSゴシック）

# ============================================================
# 寸法パラメータ（mm）— プレビューで微調整する想定
# ============================================================
ROW_H = 210.0        # データ行高さ（ユーザー指定）
TITLE_H = 260.0      # タイトル行高さ
HDR1_H = 170.0       # 見出し上段（グループ名）高さ
HDR2_H = 190.0       # 見出し下段（列名）高さ

TXT_H = 90.0         # データ文字高さ
HDR_TXT_H = 85.0     # 見出し文字高さ
TITLE_TXT_H = 150.0  # タイトル文字高さ

PAD = 60.0           # 列内パディング（左右各）
MIN_COL_W = 120.0    # 最小列幅
MARK_SIZE = 90.0     # □○マークの一辺/直径
MARK_GAP = 45.0      # マークと断面テキストの間隔

# ============================================================
# 列定義
#   key      : data.to_list_row() のキー（None=断面の特殊描画）
#   header   : 下段見出し
#   align    : "center" / "section"(マーク＋左寄せ)
# ============================================================
COLUMNS = [
    {"key": "section", "header": "部材断面寸法（中央部材）", "align": "section"},
    {"key": "f_bolt",  "header": "H.T.BOLT", "align": "center"},
    {"key": "spl1",    "header": "S PL-1",   "align": "center"},
    {"key": "spl2",    "header": "S PL-2",   "align": "center"},
    {"key": "spl_l",   "header": "S PL-L",   "align": "center"},
    {"key": "w_bolt",  "header": "H.T.BOLT", "align": "center"},
    {"key": "N",       "header": "N",        "align": "center"},
    {"key": "M",       "header": "M",        "align": "center"},
    {"key": "E1",      "header": "E1",       "align": "center"},
    {"key": "P1",      "header": "P1",       "align": "center"},
    {"key": "spl3",    "header": "S PL-3",   "align": "center"},
]

# グループ見出し（上段）: (タイトル, 開始列index, 終了列index[含む])
GROUPS = [
    ("フランジ継手", 1, 4),
    ("ウェブ継手", 5, 10),
]

TITLE = "鉄骨剛接合リスト"


# ------------------------------------------------------------
# ユーティリティ
# ------------------------------------------------------------
def _is_cjk(ch):
    return ord(ch) > 0x2E80


def _text_width(s, h):
    """テキストの概算幅。CJKは全角(=h)、ASCIIは約0.6h。"""
    w = 0.0
    for ch in str(s):
        w += h * (1.0 if _is_cjk(ch) else 0.6)
    return w


def _setup_layers(doc):
    for name, color, lt in LAYERS:
        if name == "0":
            doc.layers.get("0").color = color
            continue
        if name in doc.layers:
            lyr = doc.layers.get(name)
            lyr.color = color
        else:
            doc.layers.add(name, color=color, linetype=lt)


def _setup_styles(doc):
    if STYLE_ASCII not in doc.styles:
        doc.styles.add(STYLE_ASCII, font="romans.shx")
    if STYLE_JP not in doc.styles:
        # 日本語表示用。環境に無ければCAD側で代替フォントに置換される。
        doc.styles.add(STYLE_JP, font="msgothic.ttc")


def _line(msp, p1, p2, layer=LYR_GRID):
    msp.add_line(p1, p2, dxfattribs={"layer": layer})


def _text(msp, s, x, y, h, align, layer=LYR_TEXT, jp=False):
    if s is None or str(s) == "":
        return
    style = STYLE_JP if jp else STYLE_ASCII
    t = msp.add_text(str(s), dxfattribs={"height": h, "layer": layer, "style": style})
    t.set_placement((x, y), align=align)


def _mark(msp, cx, cy, kind, size, layer=LYR_MARK, letter="B"):
    """材質マーク（□=SN400 / ○=SN490 / ◇=SM490 / なし=SS）＋中央に letter('A'/'B')。"""
    if kind == "none":
        return  # SS系はマークも文字も描かない
    half = size / 2.0
    if kind == "circle":
        msp.add_circle((cx, cy), half, dxfattribs={"layer": layer})
    elif kind == "diamond":
        pts = [(cx, cy + half), (cx + half, cy), (cx, cy - half), (cx - half, cy)]
        msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": layer})
    else:  # square
        pts = [(cx - half, cy - half), (cx + half, cy - half),
               (cx + half, cy + half), (cx - half, cy + half)]
        msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": layer})
    bt = msp.add_text(str(letter or "B"), dxfattribs={"height": size * 0.6, "layer": layer, "style": STYLE_ASCII})
    bt.set_placement((cx, cy), align=TextEntityAlignment.MIDDLE_CENTER)


# ------------------------------------------------------------
# 列幅の自動計算（内容に合わせる）
# ------------------------------------------------------------
def _compute_widths(rows):
    widths = []
    for ci, col in enumerate(COLUMNS):
        # 見出し幅（上段グループ見出しは別途チェック）
        w = _text_width(col["header"], HDR_TXT_H)
        for r in rows:
            val = r.get(col["key"], "")
            cw = _text_width(val, TXT_H)
            if col["align"] == "section":
                cw += MARK_SIZE + MARK_GAP
            w = max(w, cw)
        widths.append(max(MIN_COL_W, w + 2 * PAD))

    # グループ見出しが、束ねる列の合計幅に収まるよう必要なら広げる
    for title, c0, c1 in GROUPS:
        need = _text_width(title, HDR_TXT_H) + 2 * PAD
        span = sum(widths[c0:c1 + 1])
        if need > span:
            extra = (need - span) / (c1 - c0 + 1)
            for i in range(c0, c1 + 1):
                widths[i] += extra
    return widths


# ------------------------------------------------------------
# 表の描画
# ------------------------------------------------------------
def _draw_table(msp, rows, title=TITLE):
    widths = _compute_widths(rows)
    xs = [0.0]
    for w in widths:
        xs.append(xs[-1] + w)
    total_w = xs[-1]
    ncol = len(COLUMNS)

    # 縦方向の境界 y（上から下へ）
    y_title_top = 0.0
    y_title_bot = -TITLE_H
    y_hdr1_bot = y_title_bot - HDR1_H
    y_hdr2_bot = y_hdr1_bot - HDR2_H        # = 見出し帯の最下端 = データ開始
    y_data_top = y_hdr2_bot
    y_data_bot = y_data_top - ROW_H * len(rows)
    y_bottom = y_data_bot

    # ---- タイトル（全幅1セル） ----
    _text(msp, title, xs[0] + PAD, (y_title_top + y_title_bot) / 2,
          TITLE_TXT_H, TextEntityAlignment.MIDDLE_LEFT, jp=True)

    # ---- セクション見出し（hdr1+hdr2 をまたぐ） ----
    sec_cx = (xs[0] + xs[1]) / 2
    sec_cy = (y_title_bot + y_hdr2_bot) / 2
    _text(msp, COLUMNS[0]["header"], sec_cx, sec_cy,
          HDR_TXT_H, TextEntityAlignment.MIDDLE_CENTER, jp=True)

    # ---- グループ見出し（hdr1） ----
    for gtitle, c0, c1 in GROUPS:
        gcx = (xs[c0] + xs[c1 + 1]) / 2
        gcy = (y_title_bot + y_hdr1_bot) / 2
        _text(msp, gtitle, gcx, gcy, HDR_TXT_H, TextEntityAlignment.MIDDLE_CENTER, jp=True)

    # ---- 列見出し（hdr2） ----
    hcy = (y_hdr1_bot + y_hdr2_bot) / 2
    for ci in range(1, ncol):
        cx = (xs[ci] + xs[ci + 1]) / 2
        hdr = COLUMNS[ci]["header"]
        is_jp = any(_is_cjk(c) for c in hdr)
        _text(msp, hdr, cx, hcy, HDR_TXT_H, TextEntityAlignment.MIDDLE_CENTER, jp=is_jp)

    # ---- データ行 ----
    for ri, row in enumerate(rows):
        y_mid = y_data_top - ROW_H * ri - ROW_H / 2
        for ci, col in enumerate(COLUMNS):
            if col["align"] == "section":
                # マーク + 断面テキスト（左寄せ）
                mark_cx = xs[ci] + PAD + MARK_SIZE / 2
                _mark(msp, mark_cx, y_mid, row.get("mark", "square"), MARK_SIZE,
                      letter=row.get("mark_letter", "B"))
                tx = xs[ci] + PAD + MARK_SIZE + MARK_GAP
                _text(msp, row.get("section", ""), tx, y_mid, TXT_H,
                      TextEntityAlignment.MIDDLE_LEFT)
            else:
                cx = (xs[ci] + xs[ci + 1]) / 2
                _text(msp, row.get(col["key"], ""), cx, y_mid, TXT_H,
                      TextEntityAlignment.MIDDLE_CENTER)

    # ====== 罫線 ======
    # 横線（全幅）: 上端 / タイトル下 / 見出し下 / 各データ行下
    for y in (y_title_top, y_title_bot, y_hdr2_bot):
        _line(msp, (xs[0], y), (total_w, y))
    for ri in range(len(rows) + 1):
        y = y_data_top - ROW_H * ri
        _line(msp, (xs[0], y), (total_w, y))

    # hdr1/hdr2 間の横線（セクション列を除く: xs[1]→右端）
    _line(msp, (xs[1], y_hdr1_bot), (total_w, y_hdr1_bot))

    # 縦線
    # 外枠左右 + セクション列右(xs[1]) はタイトル下〜最下端まで通し
    for x in (xs[0], xs[1], total_w):
        _line(msp, (x, y_title_bot), (x, y_bottom))
    # タイトル行の左右端（タイトル帯も枠で囲う）
    _line(msp, (xs[0], y_title_top), (xs[0], y_title_bot))
    _line(msp, (total_w, y_title_top), (total_w, y_title_bot))

    # グループ境界の縦線（hdr1帯にも存在）: xs[5]（フランジ|ウェブ）
    for _, c0, c1 in GROUPS:
        xb = xs[c1 + 1]
        if xb < total_w:
            _line(msp, (xb, y_title_bot), (xb, y_bottom))

    # それ以外の列境界（hdr2帯〜データ帯のみ。hdr1帯は引かない）
    group_bounds = {xs[1], total_w}
    for _, c0, c1 in GROUPS:
        group_bounds.add(xs[c0])
        group_bounds.add(xs[c1 + 1])
    for ci in range(2, ncol):
        x = xs[ci]
        if x in group_bounds:
            continue
        _line(msp, (x, y_hdr1_bot), (x, y_bottom))

    return {
        "width": total_w,
        "height": -y_bottom,
        "col_x": xs,
        "n_rows": len(rows),
    }


# ============================================================
# データ専用出力（既存CADテンプレートに貼り付ける用）
#   - 表罫線・タイトル・見出しは出力しない
#   - 左上(0,0) に基点L字（DEFPOINTSレイヤ）
#   - ⑦のx_positionsに準拠した列基準座標で配置
#   - 文字レイヤ=TEXT、スタイル=_Kozo_Romans
# ============================================================
# 各列を「箱(セル)」として扱う。12箱＝11データ列 ＋ 末尾の備考列。
# BOX_W=箱の幅。テキストは (箱の左端 BOX_LEFT + 右寄せ量) の固定位置に左揃え（文字幅に依存しない）。
BOX_W = [1650, 720, 780, 840, 510, 750, 300, 300, 375, 375, 1500, 3100]  # 箱の幅（末尾=備考）
# 箱の左端からテキストを右へ寄せる量。先頭(断面)列だけ「頭マーク」の幅で変わる:
#   頭マークが "H"     → BOX_SHIFT_H[0]  = 463
#   頭マークが "SH"/"BH"→ BOX_SHIFT_SH[0] = 384
# 2列目以降は共通。
# 全列を右へ +50（前回移動済みの 3・4列目=+50 は据置、11列目 S PL-3 のみ +55）。値=テキスト左端。
BOX_SHIFT_H  = [513, 197, 212, 209, 167.4, 244.76, 120.8, 120.8, 139, 139, 432, 110]  # 頭マーク "H"
BOX_SHIFT_SH = [434, 197, 212, 209, 167.4, 244.76, 120.8, 120.8, 139, 139, 432, 110]  # 頭マーク "SH" / "BH"
BOX_LEFT = [sum(BOX_W[:i]) for i in range(len(BOX_W))]   # 各箱の左端（累積）

DATA_COL_KEYS = ["section", "f_bolt", "spl1", "spl2", "spl_l",
                 "w_bolt", "N", "M", "E1", "P1", "spl3"]
MARKED_COL_INDEX = {0, 2, 3, 10}  # section, S PL-1, S PL-2, S PL-3
REMARKS_BOX_INDEX = 11            # 備考＝12番目の箱（index 11）

DATA_ROW_H = 210.0          # 行高さ（仕様）
DATA_TXT_H = 90.0           # ⑦のTextHeight 0.90 を ×100 して mm 換算
DATA_MARK_HALF = 67.5       # □/○ 半径（=半幅）。対角/直径/一辺 = 135
DATA_DIAMOND_HALF = 85.0    # ◇(SM490)のみ大きめ: 対角(頂点間) = 170（= 2×85）
TEXT_Y_FROM_BOTTOM = 105.0  # テキスト/Bマークの y ＝「箱の下端」から上へ105（=行高210の中央）
MARK_SHIFT_FIRST = 320.0    # 先頭(断面)列のBマーク中心 ＝ 箱の左端 + 320（断面テキスト+50に追従）
MARK_TEXT_GAP = 27.0        # 先頭以外のBマーク中心 = テキスト左端 -(GAP+半幅)。GAP大=マークが左へ（12→27で左に15移動）
BASE_L_LEN = 60.0           # 基点L字の腕長さ
LYR_DEFPOINTS = "DEFPOINTS"


def _shift_for_head(head):
    """頭マークに応じたテキスト右寄せ量(配列)を返す。
    'SH' / 'BH' → BOX_SHIFT_SH、それ以外（'H' / 未設定）→ BOX_SHIFT_H。"""
    return BOX_SHIFT_SH if str(head or "H").upper() in ("SH", "BH") else BOX_SHIFT_H


def _draw_data_only(msp, rows):
    """データのみ（罫線・見出しなし）を描画。基点を左上(0,0)に置く。
    ・各列は「箱(セル)」。値テキストは (箱の左端 BOX_LEFT + 右寄せ量) に左揃え(MIDDLE_LEFT)。
      右寄せ量は頭マーク(H / SH・BH)で先頭(断面)列だけ変わる（_shift_for_head）。
    ・テキスト/Bマークの y は「箱の下端」から上へ TEXT_Y_FROM_BOTTOM(=105)。
    ・Bマーク(□/○/◇ ＋ A/B): 先頭(断面)列は (箱の左端 + MARK_SHIFT_FIRST=270) に中心。
      それ以外のSPL列は (テキスト左端 - MARK_TEXT_GAP - 半幅) に中心＝テキストに近接（旧方式）。"""
    # --- 基点L字（左上）on DEFPOINTS ---
    msp.add_line((0, 0), (0, -BASE_L_LEN), dxfattribs={"layer": LYR_DEFPOINTS})  # 下方向
    msp.add_line((0, 0), (BASE_L_LEN, 0), dxfattribs={"layer": LYR_DEFPOINTS})   # 右方向

    # --- 各行 ---
    for ri, row in enumerate(rows):
        y = -DATA_ROW_H * (ri + 1) + TEXT_Y_FROM_BOTTOM   # 箱の下端 + 105（上方向＝行中央）
        mark_kind = row.get("mark", "square")             # square/circle/diamond/none
        shift = _shift_for_head(row.get("head"))          # 頭マーク別の右寄せ量(配列)
        for i, key in enumerate(DATA_COL_KEYS):
            val = str(row.get(key, ""))
            tx = BOX_LEFT[i] + shift[i]                    # 箱の左端 + 右寄せ量（=テキスト左端）
            # マーク有無: 先頭(断面)列は値があれば必ず／SPL列は "PL-" を含むとき
            if i == 0:
                has_mark = bool(val) and mark_kind != "none"
            else:
                has_mark = (i in MARKED_COL_INDEX) and ("PL-" in val) and mark_kind != "none"
            # 値テキスト：箱内の固定位置に左揃え（文字幅に依存しない）
            if val:
                t = msp.add_text(val, dxfattribs={
                    "height": DATA_TXT_H, "layer": LYR_TEXT, "style": STYLE_ASCII})
                t.set_placement((tx, y), align=TextEntityAlignment.MIDDLE_LEFT)
            # Bマーク(□/○/◇ ＋ A/B)：箱の左端 + シフト量 を中心に配置（テキストと独立）
            if has_mark:
                # ◇(diamond=SM490)だけ対角160(half=80)。□○は従来どおり135(half=67.5)。
                # マーク中心はサイズ非依存に固定し、□○◇を同心にする（大きい◇は中心の周りへ対称に拡大）。
                # 断面列・SPL列とも同じ挙動＝どのマークも中心位置が揃う（前回SPLだけ中心がずれていた点を修正）。
                h = DATA_DIAMOND_HALF if mark_kind == "diamond" else DATA_MARK_HALF
                if i == 0:
                    mx = BOX_LEFT[i] + MARK_SHIFT_FIRST              # 断面列: 箱の左端 + 270（中心固定）
                else:
                    mx = tx - MARK_TEXT_GAP - DATA_MARK_HALF         # SPL列: 基準半幅で中心固定（□○◇同心）
                if mark_kind == "circle":
                    msp.add_circle((mx, y), h, dxfattribs={"layer": LYR_TEXT})
                elif mark_kind == "diamond":
                    pts = [(mx, y + h), (mx + h, y), (mx, y - h), (mx - h, y)]
                    msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": LYR_TEXT})
                else:
                    pts = [(mx - h, y - h), (mx + h, y - h),
                           (mx + h, y + h), (mx - h, y + h)]
                    msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": LYR_TEXT})
                bt = msp.add_text(str(row.get("mark_letter", "B")), dxfattribs={
                    "height": DATA_TXT_H, "layer": LYR_TEXT, "style": STYLE_ASCII})
                bt.set_placement((mx, y), align=TextEntityAlignment.MIDDLE_CENTER)

        # 備考（12番目の箱に左揃えで配置。他データと同じ _Kozo_Romans を適用）
        #   ※ _Kozo_Romans は romans.shx（ASCII系）。和文備考は CAD 側で代替フォント表示になる点に留意。
        remarks = str(row.get("remarks", "") or "").strip()
        if remarks:
            rt = msp.add_text(remarks, dxfattribs={
                "height": DATA_TXT_H, "layer": LYR_TEXT, "style": STYLE_ASCII})
            rx = BOX_LEFT[REMARKS_BOX_INDEX] + shift[REMARKS_BOX_INDEX]
            rt.set_placement((rx, y), align=TextEntityAlignment.MIDDLE_LEFT)


def generate(rows, out_path, dxfversion="R2010"):
    """【新仕様】データのみ出力（CAD貼り付け用）。基点L字を左上(0,0)に置く。
    rows: data.to_list_row() の dict 配列。"""
    doc = ezdxf.new(dxfversion, setup=True)
    _setup_layers(doc)
    _setup_styles(doc)
    msp = doc.modelspace()
    _draw_data_only(msp, rows)
    doc.saveas(out_path)
    return out_path, {
        "n_rows": len(rows),
        "width": sum(BOX_W),
        "height": DATA_ROW_H * len(rows),
    }


def generate_table(rows, out_path, title=TITLE, dxfversion="R2010"):
    """【旧/プレビュー用】表全体（罫線・タイトル・見出し・データ）を出力。"""
    doc = ezdxf.new(dxfversion, setup=True)
    _setup_layers(doc)
    _setup_styles(doc)
    msp = doc.modelspace()
    info = _draw_table(msp, rows, title=title)
    doc.saveas(out_path)
    return out_path, info


if __name__ == "__main__":
    import os
    import data as data_mod

    recs = data_mod.load_db()
    sample = (
        data_mod.search(recs, grade="F10T", material="SN400", bolt="M20", shape="400x200x8x13")
        + data_mod.search(recs, grade="F10T", material="SN490", bolt="M20", shape="700x300x13x24")
    )
    rows = [data_mod.to_list_row(r) for r in sample]
    # CAD用（データのみ）
    out1 = os.path.join(os.path.dirname(__file__), "sample_data_only.dxf")
    p1, info1 = generate(rows, out1)
    print("data-only:", p1, info1)
    # プレビュー用（表全体）
    out2 = os.path.join(os.path.dirname(__file__), "sample_list.dxf")
    p2, info2 = generate_table(rows, out2)
    print("table    :", p2, info2)
