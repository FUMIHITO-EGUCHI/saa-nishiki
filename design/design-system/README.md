SAA-Nishiki は ComfyUI で画像を作るデスクトップアプリ（Electron）。画面は情報が詰まった作業台で、左に設定とプロンプトの行、右にギャラリーとビューワー、下に run bar を置く。既定はダークで、ライトも同じ部品で動く。

このシステムのトークン名は、アプリの CSS 変数とそのまま同じ名前にしてある（`saa-bg-app` → `var(--saa-bg-app)`）。色の元はリポジトリの `design/tokens.json` の 1 か所で、`scripts/buildThemeTokens.mjs` がダークとライトのテーマファイルに書き出す。ここにあるトークンはそのファイルと同じもの。

## 言葉

- UI の文言は英語。中国語訳は `data/language.json` に持つ。
- ボタンは動詞で始める（「Take samples」「Use settings…」「Make negative」）。
- 何かを開く項目には「…」を付ける（「Presets…」「Insert part…」）。
- 数は括弧で添える（「Add (2)」「2 off」）。
- 文頭だけ大文字にする（「Batch (Last)」「Keep the ratio」）。
- 説明文は置かない。見れば操作が分かる形にする。形や並びで足りないときも、ヒント文ではなく見せ方を変えて解決する（比率は形を描いたタイル、チェーンはつながった鎖と切れた鎖で見せる）。
- 同じ操作の置き場所は 1 つにする。行に見えている操作をメニューに重ねない。
- 絵文字は使わない。記号は ⋯（メニュー）、×（閉じる・外す）、✓（選択中）、▾（開く）、●（行のオン・オフ）など、役割が決まったものに限る。

## 色

**面の重なり**（奥から手前）
1. `saa-bg-app`：窓の地。
2. `saa-bg-panel`：カードと浮き面（run bar、ポップオーバー、メニュー）。
3. `saa-bg-control`：ボタン、数値欄、チップ、タイルの面。
4. `saa-bg-field`：文字を打つ欄。
- ホバーは必ず `saa-bg-hover`。

**縁**
- 区切りは `saa-border`。
- 操作できる部品の縁は `saa-border-ctl`。
- 浮き面と選択中のタブの縁は `saa-border-strong`。

**文字**
- 本文は `saa-text`。
- 補足は `saa-muted`。
- 読ませたい控えめな字は `saa-muted2`（アイコンボタン、タブ、ピル）。
- `saa-placeholder` は入力欄の空表示だけに使う。

**アクセント**
- `saa-accent` は「選ばれている」「つながっている」「フォーカス」の 3 つに使う。選択中のタイルとタブ、つながったチェーン、オンの LoRA スイッチ、2px のフォーカス線。
- 装飾には使わない。

**実行**
- `saa-run` 系は生成の実行ボタンだけに使う。Generate は橙、Batch は赤（`saa-run-batch`）、Batch (Last) は紺（`saa-run-same`）、Skip と Cancel は灰（`saa-run-stop`）。
- ほかのボタンに橙を使わない。

**状態**
- `saa-ok`：準備できた。
- `saa-busy`：処理中。
- `saa-warn`：注意（サイズが上限を超えた、など）。
- `saa-danger`：エラー、削除、範囲外。
- ライトの `saa-ok` と `saa-warn` は 3:1 前後なので、点と縁にだけ使い、文字にはしない。

**行の帯**
- `saa-stripe-*` はプロンプト行の役割の色（Common、View、Positive、Negative、AI、Exclude）。
- 行の左の 3px の帯と、見出しの ● にだけ使う。

**LoRA と Parts**
- LoRA は紫（`saa-lora-*`）、Parts は金（`saa-part-*`）。
- LoRA はライト用の値も持つ（`saa-lora-text` はライトで 7.5:1、`saa-lora-mark` は 5.1:1）。縁の `saa-lora-border` だけは両テーマで同じ値。
- Parts の色は、parts: の頭文字や Parts への導線も含めて、すべて `saa-part-*` から取る。

**ひとつのパレット**
- 面・縁・文字・アクセントは、上の基本トークンだけを使う。部品ごとに同じような色を別の名前で持っていたトークン（`saa-classic-*`、もとのプロンプト欄の文字色 `saa-prompt-*`、チップの面・縁・文字、作者プロフィールの `saa-artist-*`）は、Unify でなくした（SAA 837542c）。
- アクセントを薄くした地は `saa-accent-soft`、モーダルの後ろの暗幕は `saa-backdrop`。
- テーマファイル（index_dark.css、index_light.css）はトークンの値だけを持つ。ルールはすべて theme.css と gallery.css にあり、両テーマで同じ。
- スロット行のボタンはアイコンボタンになり、`saa-slot-*` の色もなくした（SAA 4a38a9f）。

**分類の色**
- `saa-cat-*` は LoRA の分類、Parts の分類、ビューワーの時間帯の色。
- 今は loraUi.js・partsUi.js・viewerInfo.js に同じ値が別々に書かれている。ここを唯一の出どころにする。

**残っている古い色**
- `saa-legacy-*` は、もとのアプリの部品（myButtons.js）の色。
- 新しく作るものには使わない。

## 文字

- 書体はシステムの sans（`--font-sans`）と、数値用の等幅 Consolas（`--font-mono`）の 2 つ。フォントファイルは同梱しない。
- 大きさは `label`（11px）と `body`（12px）が中心。
- 太字は 600 だけ使う（モーダルの題は 700）。
- 数値欄と px の表示は等幅か `tabular-nums` で桁を揃える。
- 今は 10・10.5・11・11.5・12・12.5・13・14・15・16px の 10 段がある。新しい部品は、なるべく `label`・`body`・`caption`・`control-lg` から選ぶ。

## 間隔・高さ・角

- 並べるときは `gap` で間を取る。8px（`saa-space-8`）が既定で、詰めるときは 6・4、群と群の間は 10・12。
- 1 行の部品は同じ高さに揃える。
  - run bar の中：`saa-h-26`
  - LoRA の行：`saa-h-28`
  - チップとメニュー項目：`saa-h-24`
  - 面の主ボタン：`saa-h-32`
- 角は部品の大きさで決める。
  - 24〜28px の部品：`saa-radius-5`
  - タイル・メニュー・入力欄：`saa-radius-6`
  - 浮き面：`saa-radius-8`
  - モーダル：`saa-radius-9`
  - チップとピル：高さの半分

## 影と重なり

- 影は浮くものだけに付ける。
  - ポップオーバーとモーダル：`saa-shadow-popover`
  - 小さなメニュー：`saa-shadow-menu`
  - サンプルビューワー：`saa-shadow-overlay`
  - run bar：`saa-shadow-bar`
- 重なり順は `saa-z-*` の層を使う。モーダル類（タグ選択、サンプルビューワー、Retake）は同じ 11000 の層に置き、DOM で後にあるものが上に来る。

## 状態の見せ方

- ホバー：面を `saa-bg-hover` にし、文字を `saa-text` にする。
- フォーカス：`saa-accent` の 2px の線（`:focus-visible`）。
- 押せない：不透明度を下げる（ボタン 0.5、アイコンボタン 0.32、メニュー項目 0.4）。
- 選択中：縁を `saa-accent` にし、タイルは左上に ✓ を付ける。
- オフにしたものは、値を残したまま見た目だけを落とす（チップの `is-off`、LoRA の行のスイッチ）。

## アイコン

- アイコンは IconSet の 45 個を使う。アプリでは `scripts/shared/iconSet.js` が唯一の定義で、`scripts/svg` のファイルも `scripts/buildIconFiles.mjs` がここから書き出す。16 単位の枠、線 1.5、端と角は丸め。色は `currentColor` で文字色を引き継ぐ。
- もとの SAA から引き継いだ塗りのアイコン（Legacy グループ）は、すべて IconSet の形に置き換えた。
- Icons・TagIcons・Legacy のグループは、置き換える前のアイコンの記録（同じ形が 5 か所に別々に定義され、線の太さも 1.5・1.6・1.8 とばらついていた）。
- アイコンボタンの中では 14px、チップと 12px の文字の横では 12px で描く。

## テーマ

- 色は必ずトークンで書く。部品の CSS に色の値を直接書かない。
- 規則は 1 か所に書く。両方のテーマに共通の規則は `theme.css` と `gallery.css` に置く。`index_dark.css` と `index_light.css` には、トークンの値と、そのテーマにしかない数行の規則だけを置く。
- 値を変えるときは `design/tokens.json` を直して `node scripts/buildThemeTokens.mjs` を流す。テーマファイルのトークンの部分は手で直さない（テストが食い違いを見つける）。
- JS が塗る色（実行ボタン、分類の色、ビューワーの時間帯）も `var(--saa-*)` で渡す。
- まだトークンを通っていない色：`index.css` の、両テーマで同じ値の直書き（Parts の金など）と、テーマ専用の数行の規則。

## 写さないもの

- `#007bff`（myDialog.js の青）。主ボタンには `saa-accent` を使う。
- `.selection-modal-tab` のフォーカス線の `#4da3ff`。`saa-accent` を使う。
- ダークの白文字 × `saa-accent`（2.6:1）と、白文字 × `saa-run`（3.6:1）。この組み合わせを新しい部品で増やさない。
