# Tabs

同じ窓の中で中身を切り替えるタブ。

## つくり
- 高さ `saa-h-30`、横の余白 `saa-space-14`、文字 12.5px、色 `saa-muted2`。
- 選択中は縁 `saa-border-strong`、下辺は本体の面と同じ色で消し、文字 `saa-text` 600。

## 使う側が渡すもの
- `role="tablist"`・`role="tab"`・`aria-selected`。タブが 1 つだけならタブ列を出さない。

## まとめる対象（今あるクラス）
`.selection-modal-tab`、`.parts-tab`、`.info-tab`。

## 注意
- `.selection-modal-tab` のフォーカス線は #4da3ff の直書き。ライトでは `saa-accent` と違う色になる。
