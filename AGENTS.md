# AGENTS.md

## UI のデザイン

- UI を作る・直すときは、まず `design/design-system/README.md` を読む。言葉づかい、色、文字、間隔・高さ・角、影と重なり、状態の見せ方、アイコン、テーマの決まりが書いてある。
- 部品ごとの決まりは `design/design-system/components/<部品名>/README.md`。見本は同じフォルダの `preview.html`、クラスの定義は `design/design-system/components/bundle.css`。
- 色などのトークンの元は `design/tokens.json`。値を変えるときはここを直して `node scripts/buildThemeTokens.mjs` を流す。テーマファイル（`html/index_dark.css`・`html/index_light.css`）のトークン部分は手で直さない。
- アイコンの定義は `scripts/shared/iconSet.js`、要素とアイコンボタンを作る関数は `scripts/renderer/dom.js` にある。

`design/design-system/` は claude.ai の Design System artifact（https://claude.ai/artifact/9mq3zkMp3vYWUnNt6FhN7c 、2026-11-01 時点）の写し。artifact が更新されたら Claude Code で書き出し直す。`design/design-system/tokens.json` も写しなので、ここは直さない。
