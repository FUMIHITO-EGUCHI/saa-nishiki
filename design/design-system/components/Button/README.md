# Button

ラベル付きのボタン。面の主操作 1 つと、それ以外の操作に使う。

## 種類
- `saa-btn`（通常）：高さ `saa-h-28`、面 `saa-bg-control`、縁 `saa-border-ctl`、角 `saa-radius-5`、文字 12px。ほとんどのボタンはこれ。
- `saa-btn is-primary`：その面の主操作 1 つ。高さ `saa-h-32`、面 `saa-accent`、白文字 600。
- `saa-btn is-run`：生成の実行だけ。Generate は `saa-run`、Batch は `saa-run-batch`、Batch (Last) は `saa-run-same`、Skip と Cancel は `saa-run-stop`。どれも `-hover` と `-disabled` を持つ。

## 使う側が渡すもの
- ラベル（動詞で始める。「Take samples」「Add (2)」）。
- 押せない間は `disabled`。理由は文で書かず、押せない見た目で伝える。

## 決まり
- 1 つの面に `is-primary` と `is-run` は合わせて 1 つまで。
- ダイアログの足元は左に Cancel、右に主ボタン（Dialog を参照）。
- 実行ボタンの色は今、renderer.js の setupButtons に rgb() で直書きされている。トークンを使う形に寄せる。

## まとめる対象（今あるクラス）
`.lora-button`、`.generate-batch-menu-button`、`.list-manager-button`、`.library-button`、`.prose-button`、`.pod-btn`、`.settings-action-button`、`.viewer-primary-button`、`.pod-btn-primary`、myButtons.js の inline style。

## 注意
- ダークの `is-primary` は白文字が `saa-accent` の上で 2.6:1 しかない（基準は 4.5:1）。
- Generate の白文字は `saa-run` の上で 3.6:1（13px 600）。どちらも今のアプリの値のまま載せている。
- `saa-legacy-blue`（#007bff）は myButtons.js の既定の色として残っている。`saa-accent` とは別の青なので、新しく作るものには使わない。myDialog.js のボタンは Dialog の足元のボタンにした。
