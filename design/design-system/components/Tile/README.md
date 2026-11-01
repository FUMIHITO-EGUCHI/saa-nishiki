# Tile

一覧から選ぶタイル。画像付きの大きい型と、比率の選択のような小さい型がある。

## 種類
- `saa-tile`：内側 4px、縁 `saa-border`、角 `saa-radius-6`、面 `saa-bg-control`。上にサンプル画像、下に名前と分類。
- 選択中（`aria-selected="true"`）：縁 2px の `saa-accent`、左上に ✓ の丸印。
- `is-compact`：比率の選択。形・名前・px を縦に並べる。押下中は縁 `saa-accent` と、アクセントを 14% 混ぜた面。

## 決まり
- タイルを押した時点で選ぶ。別に Select ボタンは置かない。
- 形や画像で違いを見せ、説明文は添えない。

## まとめる対象（今あるクラス）
`.selection-modal-tile`、`.run-ratio-tile`、`.parts-tile`、`.cg-preview-tile`、`.lora-cell`。
