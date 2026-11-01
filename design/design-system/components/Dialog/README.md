# Dialog

画面を覆う確認・選択の窓。タグ選択、Use settings…、Pod の設定で使う。

## つくり
- 枠：2px の `saa-border-strong`、角 `saa-radius-9`、影 `saa-shadow-popover`、本体の面 `saa-bg-app`。
- 見出しと足元：面 `saa-bg-panel`、区切り線 `saa-border-ctl`。題は 16px 700、右上に ×。
- 足元のボタン：最小 78×30、角 `saa-radius-5`。主ボタンは `saa-bg-selected`、ホバーは `saa-bg-hover`。後ろの暗幕は `saa-backdrop`。

## 決まり
- 足元は左に Cancel、右に主ボタン。
- Esc で閉じ、閉じたら開いたボタンにフォーカスを戻す（dialogShell.js）。
- 上に別のダイアログが開いたら、キー操作はそちらに譲る。
- 重なり順は `saa-z-modal`（11000）。同じ層の中では DOM の後ろにあるものが上に来る。

## 注意
- myDialog.js（確認・入力・お知らせ・選択）も同じ枠と足元のボタンを使う。Esc は Cancel か No（OK しかなければ OK）で、閉じたら開く前の場所にフォーカスを戻す。下にある面の Esc より先に受ける。

## まとめる対象（今あるクラス）
`.selection-modal-*`（dialogShell.js も同じクラスを使う）、myDialog.js（枠とボタンはまとめ済み、見出しはない）、`.list-manager-overlay`、`.lora-viewer`、`.lora-retake`。
