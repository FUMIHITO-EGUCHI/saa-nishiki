# IconSet

アプリのアイコンをこの 45 個にまとめる（アプリでは `scripts/shared/iconSet.js` が唯一の定義）。もとの SAA から引き継いだ scripts/svg の 19 個もここに置き換える。

## 形の決まり
- 16 単位の枠、線の太さ 1.5、端と角は丸め（round）、塗りなし。
- インクは `currentColor`。置いた場所の文字色をそのまま使う。
- 小さな点（info の点、dice の目）だけは塗る。
- 描く大きさ：
  - アイコンボタンの中は 14px（24〜28px のボタン）。
  - チップの中と 12px の文字の横は 12px。
  - チップのトグルは 10px。

## もとの SAA のアイコンの置き換え
- add → `plus`（スロットを足す）
- del → `minus`（スロットを外す）
- delete → `trash`（プリセットの削除）
- info → `info`
- refresh と reload → `refresh`（ページの再読み込みとモデルの再読み込みを 1 つの形にする）
- save → `save`
- preset → `bookmark`
- sliders → `sliders`（設定とスロットの詳細）
- swap → `swap`（左右の入れ替え）
- moon と sun → `moon`・`sun`
- paste → `clipboard`
- image-upload → `image-upload`
- file-upload → `file-upload`
- portrait → `portrait`（ADetailer の顔）
- painting → `brush`（ADetailer の描き直し）
- pose → `pose`（ControlNet のポーズ）
- mydropdown-arrow → `chevron-down`

## 今のアプリのアイコンの整理
- 下向きの山形 4 種類（uiShell の chevD、sizeRatioUi の CHEVRON、loraSamples の down、タグ側の chevronDown）→ `chevron-down`
- loraSamples の prev・next・right → `chevron-left`・`chevron-right`
- タグ側の random → `dice`。タグ側の layers と lock → uiShell の形
- tagCapsuleChip の LINK_ICON → `link`（比率のチェーンと同じ形）
- loraSamples の relink → `reset`（↺ の形に描き直した）
- 線 1.8 で描いていた LoRA まわりのアイコンは、1.5 にそろえる。
- プロンプト行をつかむ取っ手は `grip`（6 つの点）として足した。

## 使う側が渡すもの
- 名前と大きさ。アイコン自体はラベルを持たないので、押せる場所に置くときは、ボタンの `aria-label` か見えるラベルで意味を伝える。

## 決まり
- アイコンの定義は 1 か所にまとめ、ファイルごとに SVG を書かない。
- `<img src="…svg">` やマスク画像では使わない。要素として埋め込み、`currentColor` を効かせる。
- 足りない形は、この決まり（16 単位、線 1.5、丸め）で描き足し、ここに加える。
