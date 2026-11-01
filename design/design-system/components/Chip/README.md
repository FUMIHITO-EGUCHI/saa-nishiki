# Chip

タグ 1 つを表すチップ。プロンプト欄とタグ選択の中で使う。

## つくり
- 左端のトグル（`saa-chip-toggle`、幅 24px、面 `saa-accent`、check は `saa-chip-toggle-check`。オフは minus と `saa-chip-off-toggle`）。
- 名前（`saa-chip-name`、長いと省略）。
- 重みがあるときは右端に重みの区画（`saa-chip-weight`、等幅 11px）。
- 高さ `saa-h-24`、角は高さの半分（12px）、面 `saa-bg-control`、縁 `saa-border-ctl`、文字 `saa-text`（ほかの操作部品と同じ）。

## 状態
- `is-off`：タグは残したまま生成から外す。
- `is-selected`：ドラッグや編集の対象。面 `saa-chip-selected`、縁取りは 2px の `saa-accent`。
- LoRA を読み込むタグには `saa-chip-lora`（紫の小札）。LoRA が持ち込んだ語は `is-from-lora` と link アイコン。

## LoRA の行のトリガー語
- `is-word`：入っている語。縁 `saa-accent`、面はアクセントを 16% 混ぜた色、× で外す。
- `is-offer`：足せる語。点線の縁 `saa-border-strong`。

## 注意
- チップ自身の色（`saa-chip-*`）は状態の分だけ（オフ、除外、お気に入り、選択、重みの数字）。ホバーは `saa-bg-hover`。
- LoRA の色（`saa-lora-*`）はライト用の値も持つ。Parts のチップと parts: の頭文字は `saa-part-*`。

## まとめる対象（今あるクラス）
`.tag-capsule-chip`、`.lora-word`、`.lora-word-offer`、`.selection-modal-chip`、`.recipe-chip`、`.lora-retake-chip`、`.pod-chip`、`.prompt-action-cast-chip`。
