# NumberField

数値を直接打つ欄。

## 種類
- `saa-number`：46×26、等幅 12px、右寄せ、面 `saa-bg-control`。run bar の W・H・Steps・CFG・Seed。
- `saa-number is-lg`：60×28、比例幅の数字 13px、面 `saa-bg-field`。LoRA の重みと範囲。
- `is-over`：範囲を超えた値。縁が `saa-danger`。

## 使う側が渡すもの
- `aria-label`、`step`、範囲（min・max）。
- 範囲外の値を打たれたときの扱い（切り詰めて点滅させるか、赤枠のまま待つか）。

## 決まり
- スピンボタンは出さない。
- フォーカス中はホイールで増減する（LoRA の重み：1 目盛り 0.05、Shift で 0.25）。
- 数字は `font-variant-numeric: tabular-nums` か等幅で揃える。

## まとめる対象（今あるクラス）
`.run-number` の mySlider 値欄、`.lora-slot-value`、`.lora-range-input`、`.mydropdown-number-input`。
