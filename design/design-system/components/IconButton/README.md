# IconButton

アイコン 1 つだけのボタン。普段は枠も面もなく、ホバーで面が出る。

## 大きさ
- `saa-icon-btn`：24px。行の道具、パネル内の小さな操作。
- `is-26`：26px。run bar の中（Seed の固定・ランダムなど）。
- `is-28`：28px、角 `saa-radius-6`、色 `saa-muted`。LoRA の行（名前の変更、検索、展開）。
- `is-framed`：枠と面がある型。ビューワーの道具。`has-label` で文字付き。
- 押下中（`aria-pressed="true"` か `is-active`）は色が `saa-accent`。枠付きは縁も `saa-accent`。

## 使う側が渡すもの
- `aria-label`（必須）。見えるラベルがないため。
- アイコンは Icons の SVG をそのまま入れる。色は `currentColor` で引き継ぐ。
- アプリでは `scripts/renderer/dom.js` の `iconButton(icon, label, { size, framed, className, onClick })` で作る。マークアップに書くときは `saa-icon-btn` と大きさのクラスを付ける。

## 決まり
- 色は休止 `saa-muted2`、ホバー `saa-text` と面 `saa-bg-hover`、無効は不透明度 0.32。
- フォーカスは `saa-accent` の 2px の線。
- 機能ごとに新しいアイコンボタンのクラスを作らない。

## まとめたもの
- 幅と高さが少しずつ違っていた 8 種類を `saa-icon-btn` にした。`.run-icon-button`、`.edit-history-button`、`.lora-slot-icon`、`.viewer-tool-button` はなくした。
- `.lora-rename`、`.lora-retake-search`、`.scene-menu-button`（行の ⋯）、`.run-ratio-chain`、スロット行の `.slot-action`、ビューワーの `.viewer-seed-button` は、スクリプトやテストが探す名前として残る。見た目は持たない。
- 大きさ：Seed の 2 つとチェーンは `is-26`、LoRA の行は `is-28`、ビューワーの道具は `is-framed`、ほかは 24px。
