# Popover

ボタンから開く小さな浮き面。選ぶとその場で反映され、閉じる。

## つくり
- 面 `saa-bg-panel`、縁 `saa-border-strong`、角 `saa-radius-8`、内側 `saa-space-10`、影 `saa-shadow-popover`。
- run bar から開くものは上向き（`bottom: calc(100% + 6px)`）、重なり順 `saa-z-popover`。

## 使う側が渡すもの
- 開いたボタン（`aria-expanded`、`aria-controls`）。閉じたらそこへフォーカスを戻す。
- 中身（比率のタイル、LoRA の強さの選択肢など）。

## 決まり
- 外側のクリックと Esc で閉じる。
- 選んだ時点で反映し、適用ボタンは置かない。

## まとめる対象（今あるクラス）
`.run-ratio-popover`、`.lora-popover`、`.selection-modal-selected-popover`、`.prompt-preset-panel`。
