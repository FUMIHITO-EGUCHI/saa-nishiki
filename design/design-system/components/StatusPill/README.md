# StatusPill

ヘッダーの状態表示。点の色で状態を、文字で対象を示す。押すと関係する設定が開く。

## 状態
- 既定（点 `saa-ok`）、`is-busy`（`saa-busy`）、`is-warn`（`saa-warn`）、`is-bad`（`saa-danger`、縁も赤）、`is-off`（`saa-muted`）。
- `is-on`：点なしの切り替え（Fast、GPU の Pod）。縁 `saa-accent`、600。

## 決まり
- 高さ `saa-h-22`、角は高さの半分（11px）、文字 11px。
- 色だけに頼らない。文字で何の状態かを書く（ComfyUI、Generating）。
- ライトの `saa-ok`・`saa-warn` は 3:1 前後なので、点にだけ使い、文字には使わない。

## まとめる対象（今あるクラス）
`.status-pill`、`.run-error-pill`、`.gpu-toggle`、`.fast-toggle`。
