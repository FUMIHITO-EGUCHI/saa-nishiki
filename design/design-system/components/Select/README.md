# Select

一覧から 1 つ選ぶドロップダウン。

## 使う側が渡すもの
- 選択肢と今の値、`aria-label`。

## 決まり
- run bar の中では高さ `saa-h-26`、文字 12px、右に 22px の矢印の余白。

## 注意
- 色は基本トークン（面 `saa-bg-control`、縁 `saa-border`、文字 `saa-text`）。縁は、隣の数値欄の `saa-border-ctl` より薄い。
- 本体は mydropdown.js（もとのアプリから引き継いだ部品）。矢印は `mydropdown-arrow.svg`（Legacy グループ）。

## まとめる対象（今あるクラス）
`.run-select .mydropdown-*`、`.preset-select`、`.model-select`。
