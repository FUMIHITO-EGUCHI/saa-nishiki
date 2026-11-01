# PromptRow

プロンプトの 1 行。左端の 3px の帯の色で行の役割を表す。SAA の見た目の核になる部品。

## つくり
- 見出し：● 点（帯と同じ色）、行の名前、右端に ⋯。グリップと折りたたみの矢印もここに並ぶ。
- 本体：面 `saa-bg-field`、縁 `saa-border`、角 `saa-radius-6`、左に `inset 3px 0 0 0` の帯。中身はテキストかチップの並び。

## 帯の色
- Common `saa-stripe-common`、View `saa-stripe-view`、Positive `saa-stripe-positive`、Negative `saa-stripe-negative`、AI `saa-stripe-ai`、Exclude `saa-stripe-exclude`。
- 行の要素に `data-stripe` を付けると、`--saa-stripe` がその色になる。

## 決まり
- 1 つの操作に置き場所は 1 つ。行に見えている操作（● で無効化、グリップで移動）は ⋯ メニューに重ねない。メニューにある操作（Parts、正負の切り替え、削除）には行のボタンを置かない。
- 帯以外に役割を表す装飾を足さない。

## まとめる対象（今あるクラス）
`.prompts-card .prompt-field`、`.tag-field-header`、`.tag-field-tools`、`.scene-menu-button`。
