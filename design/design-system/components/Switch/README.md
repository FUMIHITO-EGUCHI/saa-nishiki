# Switch

オンとオフを切り替えるスイッチ。押した時点で反映され、適用ボタンは置かない。

## 大きさ
- `saa-switch`：34×20。オンは `saa-accent`。LoRA の行の有効・無効。
- `saa-switch is-sm`：30×16。オンは `saa-bg-selected`。設定と Pipeline の行（ui-switch）。

## 使う側が渡すもの
- `role="switch"` と `aria-checked`。
- 何を切り替えるかが分かる名前（隣のラベルか `aria-label`）。

## 決まり
- 切った状態の値は消さずに残す（LoRA の行は強さを保ったまま OFF になる）。
- 切り替えで連動して変わるもの（トリガー語など）は、同じ操作 1 回で戻せるようにする。

## まとめる対象（今あるクラス）
`.lora-slot-switch`、`.ui-switch`（myCheckbox の input を appearance:none で描き直している）。大きさとオンの色が 2 系統ある。
