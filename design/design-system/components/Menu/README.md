# Menu

⋯ や右クリックで開く操作の一覧。

## つくり
- 外枠：面 `saa-bg-panel`、縁 `saa-border`、角 `saa-radius-6`、内側 4px、影 `saa-shadow-menu`、最小幅 180px。
- 項目：高さ `saa-h-24`、角 `saa-radius-4`、文字 11.5px、左寄せ。危ない操作は `is-danger`（`saa-danger`）で最後に置く。

## 使う側が渡すもの
- 項目のラベル（動詞か、開く先の名前。「Make negative」「Presets…」）。
- 押せない項目は `disabled`（不透明度 0.4）。

## 決まり
- 行や部品に見えている操作は、メニューに重ねない。
- 説明文は書かない。

## まとめる対象（今あるクラス）
`.scene-row-menu`、`.generate-batch-menu-list`、`.right-click-menu`（もとのアプリから引き継いだ部品。色は #999・#444・#888 の直書き）、`.lora-popover-option`。
