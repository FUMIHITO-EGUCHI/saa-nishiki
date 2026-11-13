# シーケンスバッチ生成 MVP 実装計画書(改訂 v3.1)

- ステータス: 改訂 v3.1(2026-11-13)。v3 にシーン作りの要件詰めを反映
- 対象: SAA-Nishiki、branch `experimental`(worktree `SAA-regional`)
- 方針: 既存機能の組み合わせ優先。新生成エンジン・汎用ワークフロー基盤 作らない
- 文中 `file:行` は 00b7d37 時点
- 初期実装: Illustrious(model type `Checkpoint`)のみ。Anima(`Diffusion`)は Illustrious で動作確認後に展開(12 章)
- 実装者: Claude。UI モック(Design canvas `https://claude.ai/artifact/3Gb2KoyxgWn1kW3zYHWqu4`)先行

## 0. 変更履歴

### v3 → v3.1(シーン作りの要件詰め)

- 1 枚 1 キャラに制限(D21)。実行中はキャラスロット 2・3 を None 扱い
- 共通/シーン別の線引きを明記(D22): シーンが持つのはシーン欄 1 欄だけ。画風・LoRA 欄・Background 等は全シーン共通
- シーン LoRA 新設(D23): シーン欄の文に `<lora:名前:m:c>` タグで持つ。保存形式は文のまま
- 欄プリセットからシーンを写す機能 削除(D17)
- 編集モードの下書き層 削除(D18): シーン欄の文 = 編集中シーンの `text`。書いたら即反映
- Save to scene の役割変更(D19): サムネを付け、文をその絵のレシピの文に戻す
- ControlNet・IP-Adapter が効く状態では開始不可(D24)
- キャラ選択を 2 列式に変更(D2・D3 改訂): 左 = お気に入り一覧(検索・Add all・Random N)、右 = 選んだキャラの順序付きリスト(ドラッグで並べ替え・× で外す・Clear)。All / Random の二択は廃止
- A-2 ダイアログ作り直し(D26): シーン = サムネ主体のタイル格子、ドラッグで並べ替え(上下ボタン廃止)、文の抜粋は出さない、名前はクリックでその場入力、削除は確認を挟む。キャラは下の帯に要約だけ、押すとポップオーバー
- 編集モードの画面を整理(D25): キャラはプレビュー用 1 人だけ、Regional は隠す。編集中バー → Prompts の上の 1 行(シーケンス名・欄名・‹ 今のシーン ›)。今のシーンを押すと A-2 ダイアログ。Done ボタン廃止 → ダイアログの Back で終了

### v2 → v3(モックレビュー)

- シーケンス = 名前付きで保存できる単位に変更。保存先 = 既存プリセット機構(`settings/presets/sequence/<名前>.json`)
- シーン = 欄プリセットの名前参照 → シーケンス内に文を直接持つ形に変更。欄プリセットは「写して足す」元に格下げ
  - 「未解決シーンで開始不可」消滅 → 「空のシーンで開始不可」に置換
- シーン編集モード 新設: シーンをいつもの画面に読み込み、試し生成 → 気に入った絵を「Save to scene」でシーンに入れる。シーンの数・直す数だけ巡回
- いつもの画面に編集中バー(シーケンス名・欄名・シーン切替・Done)と対象欄の印を追加
- シーンにサムネ(採用した絵の縮小)を持たせる
- v2 の D16「プリセット化しない」撤回

### 初版 → v2

- 「キャラクターグループ」→ 実装に無し。母集団 = お気に入り(`fav_characters`)全体
- 「キャラごとの既存プロンプト・Parts」→ 実装に無し。キャラ情報 = キャラスロット 1 本分のタグ
- 「保存済みプロンプト = シーン」→ prompt プリセットはキャラ・共通・ネガ丸ごと含み結合が壊れる。シーン = 指定 1 欄のテキスト
- 「既存バッチ生成画面の拡張」→ 画面は無し。ダイアログ新設
- ジョブ展開 → UI 書き換え方式 禁止。既存の画像単位 override 機構(`beginImageOverride`)を拡張
- 抽選タイミング → 開始前プレビュー時(引き直し可)
- シード規則・既存 AI/Prose/重みプラン/Regional との関係・レシピ・保存先・上限確認 を追加
- 初期対象を Illustrious に限定、Anima 固有事項は 12 章
- 実装者 Codex → Claude

## 1. 目的

お気に入りキャラ群と、保存した順序付きシーン列(シーケンス)を組み合わせ、一連の画像を一括生成。
シーンはいつもの画面で試し生成しながら作り込み、気に入った絵の入力をそのままシーンに採用。

例:
- シーケンス「一日の流れ」: 起床 → 朝食 → 外出
- 対象: お気に入りからランダム 5 人
- 候補数: 3
- 合計: 5 × 3 × 3 = 45 枚

候補 = 同一入力を別シードで生成した余剰。展開違いではない。

## 2. 用語

- 母集団: `globalSettings.fav_characters`(名前文字列配列、`scripts/renderer/components/favoriteCharacters.js`)
- 対象キャラ: 母集団から確定した今回のキャラ列(順序あり)
- シーン欄: シーンテキストを流し込むプロンプト欄 1 つ(例: Action 等のカスタム欄、Background)。シーケンスごとに 1 欄
- シーン: `{ id, name, text, thumb }`。`text` = シーン欄に入れる文、`thumb` = 採用した絵の縮小(無くてもよい)
- シーケンス: 名前+シーン欄+シーン列。プリセットとして保存。同一シーン名の重複可、件数上限無し
- 編集モード: シーン 1 件をいつもの画面のシーン欄に読み込んで作り込む状態
- 候補数 K: 各キャラ×シーンで生成する枚数。全体共通
- 行(row): キャラ × シーン × 候補 1 組 = 画像 1 枚 = キュー 1 件
- 実行(run): 1 回の開始操作。`runId` = 開始時刻スタンプ `YYYYMMDD-HHmmss`

## 3. 決定事項

- D1 母集団: お気に入り全体。グループ機能は作らない
- D2 選出: 対象キャラ = 右のリスト(順序あり・重複なし)。左のお気に入り一覧から 1 人ずつクリックで足す、`Add all` で全員を足す、`Random` [N] で右のリストを N 人のランダムに置き換える(1 ≤ N ≤ 母集団数)。右のリストはドラッグで並べ替え、× で外す、`Clear` で空にする
- D3 抽選: Random ボタンでダイアログ上で実施、押すたびに引き直し。抽選後も手で足す・外す・並べ替えできる。開始時は右のリストをその順のまま使う。RNG = `crypto.getRandomValues` + Fisher–Yates。シード非依存
- D4 キャラ注入先: キャラスロット 1 のみ上書き(キー固定)。スロット 1 の重みは現状維持。スロット 2・3 は D21
- D5 シーン: シーケンス内の `text` をそのまま使う(名前参照しない)。シーン欄テキストは置換(追記ではない)
- D6 候補シード: 基準シード B、候補 c(0 始まり)のシード = `(B + c) mod 2^32`。全キャラ・全シーン共通 → 「候補 2 同士」比較可
  - シード欄 −1 → B を `generateRandomSeed()` で 1 回生成
  - シード欄固定値 → B = その値(固定でも候補ごとに別シード)
- D7 生成順: キャラ単位。A: 起床×K → 朝食×K → 外出×K → B: … キューは FIFO(Parts/LoRA サンプル割込みは既存仕様のまま)
- D8 AI Refine: シーケンス実行中は role = None 扱い(強制 OFF)。理由: 1 枚ごとの LLM 呼出、"Once" role が画像 #1 の結果を全行に再適用しシーン跨ぎで混入。編集モードの試し生成は既存どおり
- D9 model type: `Checkpoint`(Illustrious)のみ。`Diffusion`(Anima)選択時 開始不可
- D10 重みプラン展開(Expand weights per image): シーケンス実行中は無効。各行 1 枚、チップの重みそのまま
- D11 ワイルドカード・`{a|b}`・random 欄: 既存規則どおり行ごとのシードで解決(候補間で変化してよい)
- D12 Regional ON: 開始不可(ボタン無効)。MVP 対象外。編集モード中は Regional の行を隠す(D25)
- D13 バックエンド: ComfyUI のみ。WebUI 選択時 開始不可
- D14 結果識別: レシピ(`saa_recipe`)に sequence 情報追加+保存先を実行ごとのフォルダに分ける。新ギャラリー作らない
- D15 合計がしきい値以上 → 開始時に確認ダイアログ(`myDialog`)。しきい値は Settings › Generation で変更可(`sequence_confirm_threshold`、既定 100、0 = 確認しない)。上限は設けない
- D16 保存単位:
  - 設定セクション `sequence` を新設。キー = `sequence_field`、`sequence_scenes`。現在値は state.json、名前付き保存は `settings/presets/sequence/<名前>.json`(既存 `settingsStore` の `savePreset` / `loadPreset` / `deletePreset`)
  - 保存は明示操作のみ(ダイアログの保存ボタン)。既存 Prompts の Preset 行と同じ挙動
  - 保存するのはシーンの流れ(シーン欄・シーン列)だけ。対象キャラはシーケンスにも設定にも保存しない(アプリ起動中だけメモリに保持、起動直後は空)
  - Random の人数・候補数は app の `sequence_batch { count, candidates }` に保持し次回復元
- D17 シーンの作り方: ダイアログの「New scene」(空)のみ。欄プリセットからは写さない(試し生成 → Save to scene で足りる)
- D18 編集モード:
  - 入口: ダイアログのシーン行 ✎ → ダイアログを閉じ、シーン欄にそのシーンの `text` を読み込む
  - 入る前のシーン欄テキストを退避。終了(Back)で戻す(いつもの作業内容を壊さない)
  - モード中はシーン欄の文 = 編集中シーンの `text`。欄を書き換えたら即シーンに反映(下書き層なし)
  - シーン切替(帯の ‹ ›、またはダイアログでシーン行の ✎)= 切替先シーンの `text` をシーン欄に読み込むだけ
  - モード中も生成・バッチ・他欄の編集は全部いつもどおり。共通設定(モデル・LoRA・サイズ等)もこの画面で触る
  - 帯の今のシーンボタン → A-2 ダイアログを開く(モード中のまま)。編集中のシーン行をアクセント色で強調
    - 行の ✎ → そのシーンに切り替えてダイアログを閉じる。× → 何も変えず閉じる(編集に戻る)
    - フッター左 `Back`(通常時は Cancel)→ 編集モード終了。シーン欄・キャラ欄・Regional を入る前に戻し、ダイアログは開いたまま(保存ボタンへ)
    - シーンの追加・並べ替え・名前変更・保存はモード中もダイアログで行える
  - Done ボタンは置かない(終了はダイアログの Back のみ)
  - 編集モード自体は永続化しない。アプリ再起動で編集モードは終わる。シーンの文は state に入っているので失われない(シーン欄は退避値に戻らない → 要確認 10 章)
- D19 Save to scene:
  - ビューワーに表示中の絵の `thumb` を編集中シーンに付ける
  - 同時に `text` をその絵のレシピのシーン欄テキストに戻す。画面のシーン欄も同じ文に書き換える(絵を作った後に欄をいじっていても、シーン = 絵を作った文、欄 = シーンの関係を保つ)
  - `thumb` の形式: 絵を縦 128px 程度の JPEG に縮小し data URL でシーンに持つ(元画像の削除・移動に影響されない)
  - 対象はボタン表記で明示: `Save to <NN> <シーン名>`
  - レシピに無い・シーン欄が無い絵 → ボタン無効
  - 反映先は現在のシーケンス状態(state)。プリセットファイルへの保存はダイアログの保存ボタン
- D20 シーン名: タイルの名前をクリック → その場で入力欄に変わる。Enter・フォーカス外しで確定、Esc で取消、空なら元の名前。New scene の初期名 `Scene <N>`(追加直後は名前が入力状態)
- D21 1 枚 1 キャラ: シーケンス実行中はキャラスロット 2・3 を None 扱い(UI の値は触らない)。Regional を使わない前提(D12)。編集モード中はキャラ欄をプレビュー用 1 人にする(D25)
- D22 共通とシーン別:
  - シーン別 = シーン欄 1 欄の文だけ。場所・服・行動・表情はシーン欄に書く
  - 全シーン共通 = それ以外すべて: モデル、Common・Style・Artist・Background 等の他の欄、Negative、LoRA 欄、サイズ、Hires・Refiner・ADetailer
  - 共通の欄にシーン依存の語(例: Background の `cherry blossoms`)が残ると全シーンに入る。警告は出さない(使い方で対応)
- D23 シーン LoRA:
  - シーン欄の文に `<lora:名前:m:c>` タグで持つ。保存形式は文のまま(新しい項目なし)
  - ComfyUI 経路の LoRAfromText は positive の `<lora:…>` タグを読む(`scripts/shared/loraStageModels.js`)→ 既存経路で効く想定(要確認 10 章)
  - 値は 2 つの形(`m:c`)で入れる。1 つ(`<lora:x:0.8>`)だと Hires で 1.0 になる
  - 編集モード中だけ、シーン欄の + Tag の隣に + LoRA。既存の LoRA ピッカーで選ぶと `<lora:名前:m:c>` を挿す(m・c はピッカー/カタログの既定値)
- D25 編集モードの画面:
  - Characters カード: 枠 1 だけ残し、ラベルを `Preview character` に。枠 2・3 と +/− は隠す。試し生成はこの 1 人で行う
  - 入る前の枠 2・3 の値・枠数は触らない(隠すだけ)。Back で表示を戻す
  - Prompts の Regional の行・Characters カードの Regional 部分は隠す。入る前に Regional ON なら、モード中は OFF として生成(UI 値は戻す)→ 要確認 10 章
  - Preview character の候補 = 既存のキャラ選択と同じ(お気に入りに限らない)
- D24 ControlNet・IP-Adapter: 実際に送られる行が 1 つでもあれば開始不可。同じポーズ・参照画像が全シーンに掛かるため
  - 判定 = `createControlNet()`(`generate.js:857`)が空でない。`api_controlnet_enable` OFF、全行 Off、モデル none の行だけ、なら開始可
  - IP-Adapter は ControlNet 欄の 1 行(前処理 `ip-adapter*`)なので同じ判定に入る
  - 編集モードの試し生成は制限しない

## 4. 機能範囲

### 4.1 キャラ

- 母集団 = `fav_characters`。キー解決できない名前(リスト側で削除・非表示)は母集団から除外し、件数に反映
- OC(`oc:` キー)の扱い: お気に入りに入るなら同様に扱う(要確認 10 章)
- キャラ情報 = 既存のスロット解決結果そのもの: タグ、タグ内ネガ(`splitTagNegativePrompt`)、Tag Assist、サムネ、表示名(`createCharacters` `scripts/renderer/generate.js:228`)
- 新キャラ定義・キャラ別プロンプト・キャラ別 Parts 作らない
- 注意: Random スロットは `seed % リスト長` でキャラ決定(`getRandomIndex` `generate.js:323`)。スロット 1 はキー固定上書きで回避。スロット 2・3 は実行中 None(D21)

### 4.2 シーケンスとシーン

- シーケンス選択・保存・削除: ダイアログ上部(Prompts の Preset 行と同じ形)
- シーン欄の選択: 欄プリセットを持てる欄(Background / Style / カスタム欄)から 1 つ
- シーン追加: New scene のみ
- 並べ替え: タイルをドラッグ(Prompts の欄と同じ操作感)。落とす位置の前にアクセント色の縦線。上下ボタンは置かない
- 削除: タイルの削除ボタン → 確認ダイアログ(サムネ+番号+名前、Cancel / Delete)→ 消す
- 重複追加・名前変更(D20)
- シーン内容の編集: 編集モード(D18)と Save to scene(D19)のみ。ダイアログ内に文の直接編集欄は置かない
- 開始条件: 空のシーン無し / シーン欄が現在の欄構成に存在 / シーン欄が mute でない(`readPromptValue` は mute 判定が override より先 `scripts/renderer/tools/promptBatchExpansion.js:20`)

### 4.3 編集モード(いつもの画面)

- 編集中の帯(モック `SeqOptionB` / `SeqOptionBDialog`): 右の列、Characters カードと Prompts カードの間に 1 行(高さ 42px、アクセント色の枠)。左から ✎ アイコン、シーケンス名(120px で省略)、シーン欄名、‹、今のシーンボタン、›
  - 今のシーンボタン: 番号+名前+`NN / 全数`+ダイアログのアイコン。残り幅いっぱい、名前は省略記号で切る。サムネは出さない
  - 押すと A-2 ダイアログ(D18)。ドロップダウンは作らない
  - ‹ › = 前後のシーン。端で無効
  - Done・サムネ列は置かない
  - シーン数・名前の長さでバーの幅は変わらない
- 対象欄の印: シーン欄の本体をアクセント色の枠、見出し横に `<NN> <シーン名>` のピル、+ LoRA ボタン(D23)
- ビューワー: 表示中の絵の上に Save to scene ボタン。下のサムネ列に、編集モード中に生成した絵のシーン番号(メモリ上の対応、レシピには書かない)
- 説明文・ヒント文は足さない

### 4.4 プロンプト結合

- 結合は既存 `createPrompt` → `getPrompts` / `composeNegativeChain` をそのまま通す。欄順(`prompt_positive_order`)・Exclude・LoRA 行・ネガ規則すべて既存
- 行ごとの差分は 2 点のみ: スロット 1 キー、シーン欄テキスト
- それ以外の欄テキストはクリック時スナップショットで固定(既存 `baseFields` = `snapshotFieldsForPromptOverride(refineSnapshot)` を利用、`generate.js:1224`)
- 編集モード中に開始した場合も、シーン欄以外はその時点の画面のまま(シーン欄は各行の `text` で置換)
- スロット 2・3 は None で結合(D21)
- 自動書き換え・LLM 補完・新競合解決 無し

### 4.5 生成

- 行ごと独立生成。前シーン画像の入力無し
- モデル・解像度・CFG・Steps・Hires・Refiner・ADetailer・LoRA 欄 = クリック時の既存設定。ControlNet・IP-Adapter は使わない(D24)。シーン LoRA はシーン欄のタグとして追加で効く(D23)
- Hires シードは既存どおり別乱数(`createHiFix`)。比較対象は主サンプラーのシードのみ

### 4.6 結果管理

- レシピ(`queuedRecipe` `scripts/renderer/imageRecipe.js:20`):
  - `sections.prompt` を行の実入力に差し替え: `character_slots[0].key`、シーン欄テキスト(カスタム欄なら `prompt_custom_fields[].text`、Background なら `prompt_background`)
  - 差し替え無しだと Library の「Use settings…」・再生成が UI 状態を再現し別画像になる
  - `run.sequence` 追加: `{ runId, sequenceName, characterKey, characterIndex, sceneIndex, sceneName, candidate, candidates, total }`(`scripts/shared/recipe.js` の `cleanRun` に項目追加)
- 保存先(`getImageSavePrefix` `generate.js:1079` の分岐追加):
  - `seq-<runId>/<キャラ>_s<NN>-<シーン名>_c<K>`(NN・K は 1 始まり 2 桁/1 桁)
  - キャラ名・シーン名は Windows 禁止文字 `\ / : * ? " < > |` と制御文字を `_` に置換、長さ 40 字で切る
  - Library はフォルダ単位表示 → 実行ごとに 1 フォルダ
- キュー表示名: `[Seq] <キャラ> / <シーン> #c` 形式
- 中断: Cancel = 既存どおりキュー全消去、Skip = 残り破棄。生成済み画像はフォルダに残る。再開・未完分再投入は作らない

## 5. UI

- 見た目・部品は design system に従う(`design/design-system`、`AGENTS.md`)。説明文・ヒント文は足さない
- 入口: Run bar の Batch ▾ メニューに「Sequence…」追加 → ダイアログ(`dialogShell` / `myDialog`)
- ダイアログ構成: 2 ページ(大きさ 920×680)。保存する「シーンの流れ」と保存しない「実行の設定」をページで分ける
  - ページ 1 `Sequence`(A-2、保存する側、モック `Main.dc.html`):
    - 上の行: Sequence 選択+保存+削除、Field 選択、右端にシーン数
    - シーンのタイル格子、6 列、縦スクロール
      - タイル = サムネ(3:4)+左上に番号+下に名前。サムネ無しは点線枠、空のシーンは赤い点線+`Empty`
      - ホバーで右上に ✎(編集モードへ)と削除。編集モード中のシーンはアクセント色の枠+`Editing`
      - 最後に `+ Scene` の点線タイル
      - シーン文(プロンプト)は出さない
    - フッター: Cancel(編集モード中は Back)/ `Next`
  - ページ 2 `Sequence › Run`(B、保存しない側、モック `CharactersOpen.dc.html` / `RunEmpty.dc.html` / `Blocked.dc.html`):
    - 見出し行: `Characters`、右端に今のシーケンス名とシーン数(例 `一日の流れ · 6 scenes`)
    - キャラ選択の 2 列をページいっぱいに直接出す(ポップオーバーにしない)
      - 左: 検索欄、お気に入り一覧(行 = 頭像+名前+`+`、選択済みは薄く `✓`、検索に合わない行は薄く)、下に `Add all` と `Random` [N]
      - 右: `Selected` と人数、選んだキャラの行(つまみ+番号+頭像+名前+×)、ドラッグで並べ替え、下に `Clear`
    - フッター: `← Scenes` / 開始不可理由のピル(`Empty scene`・`No characters`・`Regional on` 等)、Candidates、`Generate (N)`(N = 総枚数。計算式は出さない)
  - 開くページ: Batch ▾ → Sequence… は前回閉じたときのページ(初回は Scenes)。編集中の帯の今のシーンからは Scenes
  - ページの行き来はフッターの `Next` / `← Scenes` だけ(タブは置かない)
- 編集モード(モック `Editing.dc.html`): 4.3
- 確認(モック `Confirm.dc.html`): 合計 ≥ しきい値のとき `Queue N images?`
- 設定(モック `Settings.dc.html`): Settings › Generation に `sequence_confirm_threshold`
- 開始不可条件(ボタン無効): 対象キャラ 0、シーン 0、空のシーン有り、シーン欄が欄構成に無い、シーン欄 mute、Regional ON、ControlNet・IP-Adapter が効く(D24)、WebUI、model type Diffusion、生成ボタン非活性中
- 進捗・停止: 既存キュー・Cancel・Skip

## 6. 処理フロー

モック `Flow.dc.html` の番号に対応。

### A. ページ 1 Sequence: シーンを作る・保存する(初回・直すとき)

1. A-1 お気に入りにキャラを登録(初回だけ)
2. A-2 Batch ▾ → Sequence…、シーケンスを選ぶ / 新規、シーン欄を選び、シーンを足す・並べる
3. A-3 シーン行 ✎ → 編集モード。いつもの画面でシーン欄と共通設定を調整
4. A-4 Create Image で試し生成
5. A-5 気に入らない → A-3 に戻って直す
6. A-6 気に入った絵で Save to scene(サムネ+文を絵の文に戻す)
7. A-7 次のシーン・直すシーンがあれば A-2(または帯のシーン切替で直接 A-3)。終われば帯の今のシーン → ダイアログで Back → 保存ボタン

### B. ページ 2 Run: 実行の設定(保存しない)

1. B-1 ページ 1 で保存済みシーケンスを選び、Next でページ 2 へ
2. B-2 Next → Run ページでキャラを決める(左から足す / Add all / Random、右で並べ替え・外す)
3. B-3 候補数を決める(Generate の隣の Candidates)
4. B-4 開始可否判定 → 不可なら B-5 直してから Generate

### C. 生成と結果

1. C-1 Generate (N) → 合計がしきい値以上なら確認
2. クリック時スナップショット確定: recipe sections、`baseFields`、基準シード B、`runId`
3. 行展開(純粋関数): キャラ順 × シーン順 × 候補 → `[{ characterKey, sceneIndex, sceneName, sceneText, candidate, seed }]`
4. C-2 既存 `generateImage` のループを行列で回す。行ごとに override 開始 → `createPrompt` → generateData 構築 → `queueManager.attach` → override 終了。既存キューが実行(auto start も既存どおり)
5. 各 PNG に `saa_recipe`(sequence 付き)、`seq-<runId>/` に保存
6. C-3 Library で候補を比べる → C-4 選んだ 1 枚を Use settings… で再現・調整

## 7. 実装方針

### Phase 1: 確認(変更前)

10 章の要確認項目を潰す。結果次第で本書を更新してから着手。

### Phase 2: 純粋ロジック

新規 `scripts/shared/sequenceBatch.js`(DOM・Electron 無し):

- `pickRandomCharacters(pool, count, rng)`: Random ボタン用。重複なし N 人
- `expandSequenceRows({ characters, scenes, candidates, baseSeed })`
- `sequenceSavePrefix({ runId, characterName, sceneIndex, sceneName, candidate })`、`sanitizeName()`
- `patchRecipeSections(sections, row, sceneFieldKey)`
- `normalizeScenes(list)`: id 付与・name/text の型そろえ・thumb の data URL 以外を捨てる
- `sequenceStartBlockers({ characters, scenes, field, fieldExists, fieldMuted, regional, controlNet, backend, modelType })`(`controlNet` = 送られる ControlNet 行数) → 理由の配列
- `readSceneText(recipeSections, sceneFieldKey)`: Save to scene 用。レシピからシーン欄テキストを取り出す(無ければ null)

### Phase 3: 設定・生成経路

- `scripts/shared/settingsSections.js`: セクション `sequence`(`sequence_field`、`sequence_scenes`)と既定値、app に `sequence_batch`・`sequence_confirm_threshold`
- `scripts/renderer/tools/promptBatchExpansion.js`: override に `characters`(スロット番号 → キー)を追加。シーケンス行用の開始関数(fields = baseFields + シーン欄、seed = 行シード)
- `scripts/renderer/generate.js`:
  - `createCharacters`: override の `characters[index]` があればそれを `globalThis.characterList.getKey()[index]` の代わりに使う
  - `generateImage`: `dataPack.sequence` 時は `planBatchExpansion` を使わず行列でループ、AI role None 扱い、prefix・recipe・キュー表示名を sequence 用に
  - `getImageSavePrefix`: sequence prefix 分岐
- `scripts/shared/recipe.js`: `cleanRun` に `sequence`
- 通常生成経路(`dataPack.sequence` 無し)の挙動は不変

### Phase 4: UI

- ダイアログ 1 ファイル(`scripts/renderer/` 配下)、Batch ▾ メニューに項目、言語ファイルに文言
- シーケンス保存・読込・削除: 既存プリセット IPC(`preload.js` の sectioned settings)を `sequence` セクションで使う
- 編集モード 1 ファイル: 編集中バー、シーン欄の退避・読込・即反映・復元、対象欄の印(`promptFieldManager.js` の欄行にクラスとピル)、+ LoRA ボタン(既存 LoRA ピッカー再利用)、ビューワーの Save to scene ボタン
- サムネ縮小: renderer の canvas で縮小 → `toDataURL('image/jpeg')`

### Phase 5: 検証

8 章。実アプリ確認は CDP(`npx electron . --saa-cdp-port=9333`)。

## 8. 検証項目

ユニット(`node --test`、`tests/sequence-batch.test.mjs`):

- 展開: 行数 = 人数 × シーン数 × 候補数、順序 = キャラ → シーン → 候補
- シード: 候補 c = B + c、キャラ・シーン間で一致、2^32 で折り返し
- 抽選: 重複なし、N = 母集団数で全件、注入 RNG で決定的
- 保存名: 禁止文字置換、長さ制限
- レシピ差し替え: スロット 1 キーとシーン欄テキストのみ変化
- 開始不可理由: 各条件で該当理由のみ返る(ControlNet 行数 0 なら ControlNet 理由なし)
- `readSceneText`: カスタム欄・Background の両方、欄無しで null
- `normalizeScenes`: 欠けた id 付与、不正 thumb 除去
- 設定: `sequence` セクションの normalize、プリセット保存→読込で同値

E2E(`tests/e2e/sequence-batch.e2e.mjs`、実 Electron+実 ComfyUI、既存 `harness.mjs`):

- 2 人 × 2 シーン × 2 候補 = 8 枚生成
- 各 PNG のレシピ: sequence 情報、シード、キャラキー、シーン欄テキスト、positive にキャラタグとシーンテキスト
- 保存先 `seq-<runId>/` に 8 枚
- 編集モード: ✎ で入る → シーン欄にシーン文 → 欄を書き換えるとシーン文も変わる → 1 枚生成 → 欄をさらに書き換え → Save to scene でサムネ付与・シーン文と欄が絵の文に戻る → 帯からダイアログを開いて Back でシーン欄が入る前の文に戻る
- 1 枚 1 キャラ: スロット 2 にキャラを入れた状態で実行 → 各 PNG の positive にスロット 2 のタグ無し
- シーン LoRA: シーン欄に `<lora:…:m:c>` を持つシーンだけ、レシピ・送信ワークフローにその LoRA
- 既存 E2E(`generation.e2e.mjs`・`recipe.e2e.mjs`・`generation-reproducibility.e2e.mjs`)通過 = 通常生成不変

実機(CDP):

- ダイアログ操作(追加・ドラッグ並べ替え・削除確認・クリック名前変更・Next / ← Scenes のページ移動・左から追加・Add all・Random・右のドラッグ並べ替え・× ・Clear・保存・読込・削除・復元)
- ControlNet ON+行あり → 開始不可のピル、全行 Off → 開始可
- 編集モード: ‹ › とダイアログの ✎ でシーン切替、各シーンの文が出る、Characters がプレビュー 1 人・Regional が隠れる、Back で両方戻る、× で編集に戻る、他欄の編集・バッチ生成が普通に動く、対象欄の印とピル、+ LoRA でタグが挿さる
- 生成中 Cancel / Skip 後の状態、ボタン復帰
- Library で実行フォルダ表示、1 枚から「Use settings…」で同じ入力が戻る

## 9. 非対象

- LLM のストーリー作成・プロンプト生成/修正
- VLM 評価、自動ベストショット選択
- 画像参照によるキャラ一貫性、シーン間の衣装・持ち物・状態継承
- ストーリー分岐、シーンごとの個別生成設定(シーンが持つのはシーン欄 1 欄の文だけ。LoRA はその文のタグとして持つ)、複数欄のシーン
- 1 枚に複数キャラ
- キャラグループ機能、対象キャラ・候補数のプリセット化
- ダイアログ内でのシーン文の直接編集、Library からの Save to scene
- 専用ギャラリー、中断再開
- Regional・WebUI 対応
- Anima(Diffusion)対応(12 章、初期版の後)

先行実装・過剰抽象化 禁止。

## 10. 要確認(Phase 1)

- お気に入りに OC(`oc:` キー)が入るか、`fav_characters` の値はキーか表示名か(`characterSelectionModal.js:108` 付近)
- 欄プリセットのキー: カスタム欄は `cf_xxx` id か、Background / Style は何か。シーン欄候補の列挙方法
- `createCharacters` 上書きでサムネ・表示名・`characterKeys` が追従するか
- `baseFields` スナップショットにシーン欄を差し込んだとき mute・無効タグ `~tag`・`parts:` 展開が既存どおり効くか
- Library が `seq-<runId>/` を 1 フォルダとして出すか(`scripts/main/libraryIndex.js` `folders`)
- Pod 経路(`podSshTransport.js`、flat フォルダ)で prefix のサブフォルダが効くか。効かなければファイル名のみで識別
- `image_save_embed_character_name` / `image_save_path_comfyui` 設定との合成規則(sequence 時は上書きでよいか)
- 生成時間の推定に既存 `runTiming` が使えるか(使えなければ表示しない)
- セクション新設の影響: `SECTION_KEYS` に `sequence` を足すと state.json・`preset_current`・Undo トランザクション(`runEditTransaction`)・設定ウィザード・設定ディレクトリ移行に何が起きるか。プリセット UI がセクション一覧を総なめしていないか
- シーン欄へのテキスト読込方法: チップ欄の値を丸ごと差し替える既存 API(欄プリセット適用と同じ経路)があるか。差し替えが Undo 履歴に積まれるか(積まれるなら編集モードの出入りを 1 トランザクションにまとめる)
- 編集モード中にアプリ終了したとき: シーン欄にシーンの文が入ったまま state.json に保存される。起動時に退避値へ戻すか、そのまま残すか
- シーン LoRA(D23): カスタム欄・Background に書いた `<lora:…>` が結合後の positive にそのまま残り LoRAfromText に届くか。チップ表示(2026-11-13 実機: カプセル表示では `<lora:…>` が生の文字のまま 1 チップで出る)・`tagLint`・ADetailer 側プロンプトでの扱い。レシピ取込(`recipe.js` の `<lora:…>` を LoRA 行にする処理)と二重にならないか
- シーンごとに LoRA タグが違うときの切替コスト(ComfyUI v0.40 pinned memory 下で実測)。キャラ単位の生成順(D7)だと毎枚切り替わる → 遅ければ D7 をシーン単位に変える
- 編集モード中の Regional: 入る前に ON のとき、試し生成を OFF 扱いにする経路(override か一時的な設定差し替えか)。Undo・state.json に残さない方法
- スロット 2・3 を None 扱いにする経路: override の `characters` で 2・3 を `None` にすれば足りるか
- ビューワーの表示中の絵からレシピを取る経路(`imageInfo.js` / `openImage` 周辺)と、絵の縮小に使える画像 URL
- サムネ data URL のサイズ: シーン数 × 数 KB でプリセットファイル・state.json が肥大しないか(目安 1 シーン 10KB 以下)

## 11. 実装者(Claude)への指示

- UI モック(Design canvas)で画面を確定してから実装
- 実装は worktree を切ってから(experimental から分岐)
- 着手前に 10 章を確認し、本書と食い違えば本書を先に直す
- 既存の設計・命名・UI 規則・design system に従う
- 新しい生成基盤・汎用ワークフローエンジン 作らない
- 変更は 7 章の箇所に限定。通常生成経路の挙動を変えない
- 想定外例外への過剰防御 不要。ただし 5 章の開始不可条件と D18 の退避・復元は実装
- 実装後は 8 章を実行し、E2E と実機確認の結果を報告
- 本書に無い拡張 実装しない

## 12. Anima(Diffusion)展開時の課題

Illustrious 版の動作確認後に着手。初期版では作らない。

- Prose(英文化): 既存設定を継承するか。ON なら 1 枚ごと LLM 呼出 → 総枚数横に表示、所要時間に影響
- キャスト欄 `cf_cast1`(`scripts/shared/castMembers.js`): テキストは全キャラ共通で送られる → キャラ固有の記述が全員に混入。キャスト別名がスロット上書きに追従するか確認
- シーン欄の第一候補が Action 欄(`@alias` 参照)になる → シーン欄の候補に Action 欄が入るか確認
- `model_type_prompts`(型切替でプロンプト差し替え)との関係: シーケンスのシーン欄 ID が型ごとに変わるか。Illustrious 用と Anima 用でシーケンスを分けるか
- 編集モードの試し生成が Prose を通る場合、Save to scene が取るのは英文化前の欄テキスト(レシピの欄値)でよいか
- E2E: `prose-student.e2e.mjs`・`regional-diffusion.e2e.mjs` 相当の Diffusion 版を 1 本
