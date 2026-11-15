# シーケンスバッチ生成 MVP 実装計画書(改訂 v3.3)

- ステータス: 改訂 v3.3(2026-11-14)。シーン = プロンプト全欄+LoRA+生成設定の丸ごと(D29)。シーン欄の選択(D22・D27)は廃止
- 対象: SAA-Nishiki、branch `experimental`(worktree `SAA-regional`)
- 方針: 既存機能の組み合わせ優先。新生成エンジン・汎用ワークフロー基盤 作らない
- 文中 `file:行` は 00b7d37 時点
- 初期実装: Illustrious(model type `Checkpoint`)のみ。Anima(`Diffusion`)は Illustrious で動作確認後に展開(12 章)
- 実装者: Claude。UI モック(Design canvas `https://claude.ai/artifact/3Gb2KoyxgWn1kW3zYHWqu4`)先行

## 0. 変更履歴

### v3.2 → v3.3(シーンの中身を丸ごとに、実機レビュー)

- シーン欄という考えを廃止(D22・D27 は無効)。シーンが持つのは Prompts カードの全欄(カスタム欄の有無・並び順・mute 含む)、LoRA 欄、生成設定(サイズ・Steps・CFG・サンプラー・Hires)。キャラ・モデル・ADetailer・ControlNet・Regional・AI/Prose・シード・バッチ数は画面のまま(D29)
- ダイアログの Fields 選択と、欄ごとのピル・+ LoRA ボタンを撤去(LoRA はいつもの LoRA カードがシーンごとになる)
- 並び順をシーン → キャラ → 候補に変更(D7 改訂)。シーンの設定を画面へ載せるのがシーンごとに 1 回で済み、LoRA の切替も減る
- + Scene = 今の画面をそのまま写したシーン
- タグのコピー・切り取り・貼り付け(D30): チップ欄で Ctrl+C / Ctrl+X / Ctrl+V、右クリックの Cut / Copy / Paste。OS のクリップボード経由なので欄をまたいでも、シーンを切り替えても貼れる

### v3.1 → v3.2(シーン欄の複数選択、実装後)

- シーン欄を複数選べるように変更(D27)。D22 の「シーン欄 1 欄だけ」を「選んだシーン欄だけ」に置き換え。シーンは欄ごとの文 `texts: { <欄キー>: 文 }` を持つ
- 実機レビュー反映(D28): 採用した絵があるシーンは欄が空でも Empty にしない / タイルの絵を押すと編集モード(✎ ボタン廃止)/ Save to は押すと一瞬 Done / サムネを 384px 高に、採用画像のファイルがあれば Library のサムネを使う / 編集モード中のビューワー = 今のシーンの画像だけ(シーンを替えると採用画像を表示)
- 不具合修正: 編集モード中は欄の選択が無効になっていたため、編集中に選んでいたカスタム欄を消すと、どの欄も選べなくなっていた → 編集モード中でも欄を選べるようにし、画面から消えた欄はメニューに「missing」として残して外せるようにした

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
- D4 キャラ注入先: キャラスロット 1 のみ上書き(キー固定)。スロット 1 の重みは現状維持。スロット 2・3 は D21。`createCharacters` はキー(`getKey()[i]`)と Info 表示用の値(`getValue()[i]`)の両方を override から読む
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
- D15 合計がしきい値以上 → 開始時に確認ダイアログ(`myDialog`)。しきい値は Settings › General で変更可(`sequence_confirm_threshold`、既定 100、0 = 確認しない)。上限は設けない
- D16 保存単位:
  - 設定セクションは新設しない(Phase 1 で変更、10 章)。Parts と同じ形の専用ストア `settings/sequences.json`(`makeEnvelope('sequences', …)`、main 側 `sequencesStore.js`)に `{ sequences: { <名前>: { field, scenes } }, current: { name, field, scenes }, editBackup }` を持つ
  - `current` = ダイアログで開いているシーケンス(未保存の変更込み)。名前付き保存 = `sequences[<名前>]` に写す
  - 保存は明示操作のみ(ダイアログの保存ボタン)。既存 Prompts の Preset 行と同じ見た目・確認(上書き確認・削除確認は `myDialog`)
  - 保存するのはシーンの流れ(シーン欄・シーン列)だけ。対象キャラはシーケンスにも設定にも保存しない(アプリ起動中だけメモリに保持、起動直後は空)
  - Random の人数・候補数は app の `sequence_run { count, candidates }` に保持し次回復元
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
- D27 シーン欄の複数選択(v3.2):
  - シーケンスは `fields`(欄キーの配列)を持つ。ダイアログのツールバー `Fields` ボタン = 選んだ欄名の列挙、押すとチェック付きメニュー(View / Background / Style / Positive / positive のカスタム欄。Positive は設定 `api_prompt`、選ぶとシーンの文で丸ごと置き換わる)。新規シーケンスの初期値は最初のカスタム欄(無ければ Background)
  - シーン = `{ id, name, texts: { <欄キー>: 文 }, thumb }`。実行時は選んだ欄すべてを各シーンの文で置換(シーンにその欄の文が無ければ空文)。外した欄の文もシーンに残し、選び直せば戻る
  - 空のシーン = 選んだ欄がすべて空のシーン。開始不可条件の「シーン欄が無い」= 欄 0 個、または選んだ欄が画面に無い。「mute」= 選んだ欄のどれかが mute
  - 編集モード中も欄を選べる。足した欄はその時点の文を退避してシーンの文を入れ、外した欄は退避した文に戻す。欄が 0 個になったら編集モード終了。画面から消えた欄はメニューに missing として残り、外せる(戻す文は無い)
  - 退避は `editBackup: { texts: { <欄キー>: 文 } }`。Save to scene は選んだ欄のうちレシピにある欄の文をすべて取る。+ LoRA は欄ごと(押した欄の文に入る)
  - Positive も選べる(設定 `api_prompt`)
- D29 シーンの中身(v3.3、D22・D27 を置き換え):
  - シーン = `{ id, name, settings, thumb, image, history }`。`settings` = `{ prompt, generation, lora }` のうちシーンが持つキーだけ(`SCENE_KEYS`、`scripts/shared/sequenceBatch.js`)
    - prompt: Artist 欄、View 系、Common・Positive・Negative 系、Background・Style・Exclude、カスタム欄(文・有無・名前)、正/負の並び順、mute
    - generation: サイズ(幅・高さ・向き・比率)、Steps、CFG、サンプラー、スケジューラ、Hires 一式
    - lora: LoRA 欄の行
    - 持たない: キャラ欄(実行時に選んだキャラ)、モデル・VAE・Refiner、ADetailer、ControlNet、Regional、AI/Prose、シード、バッチ数、欄プリセット集・折り畳み状態
  - 画面への出し入れは undo/redo と同じ経路(`collectSection` / `applySectionsData(..., { mergeLayout: false })`)
  - 実行: 行はシーン → キャラ → 候補の順。シーンが替わる行で、そのシーンの設定を画面に載せてから行を組み、全行を組み終えたら画面の設定を戻す(組む間だけ。生成待ちの間は画面はいつもどおり)。レシピの `sections` はそのシーンのもの(キャラはスロット 1 に差し替え)
  - 編集モード: 入ると画面の設定(シーンの分)を退避し、シーンの設定を載せる。画面の変更(文字・チップ・LoRA 行・サイズ・Undo 等)は 0.3 秒後にシーンへ入る。シーン切替・Save to・終了のたびに、そのセクションの Undo 履歴を消す(別シーンの値が Undo で混ざるのを防ぐ)
  - Save to = 表示中の絵のレシピからシーンの設定を取り、画面にも載せる(+ サムネ・採用画像)
  - + Scene = 今の画面の設定を写したシーン。設定の無いシーン(旧形式の読み替え前)だけが空のシーン扱い
  - 編集モードのままアプリを閉じたら、次の起動で同じシーンの編集モードに戻る。退避は `editBackup: { settings, sceneId }`。画面の設定(閉じる時に保存済み)をそのシーンの最新とみなしてシーンへ入れる。閉じる時はシーンへの反映とストア書き込みを待たずに即実行。退避のシーンが今のシーケンスに無ければ、従来どおり画面の設定を戻して終える
  - 旧形式(欄の文だけのシーン)は起動時に一度だけ「その時の画面の設定+そのシーンの欄の文」に読み替える。旧形式の編集退避(欄の文)も起動時に戻す
- D30 タグのコピー・切り取り・貼り付け(v3.3、全チップ欄共通、`tagCapsuleField.js`):
  - Ctrl+C / Ctrl+X = フォーカスしたチップ(選択中ならその選択全部)をプロンプト文(`a, (b:1.20), ~c`)としてクリップボードへ。Ctrl+X は欄から外す
  - Ctrl+V = クリップボードのタグをフォーカスしたチップの後ろへ(+ Tag 上なら末尾)。欄に既にあるタグは足さない。貼ったチップは選択状態
  - 直前のコピーはアプリ内にも丸ごと持ち、同じ文を貼るときは重みプラン(画像ごとの重み)も保つ。クリップボードへの書き込みに失敗したときはアプリ内のコピーを貼る
  - 右クリック: チップに Cut / Copy / Paste、欄の余白に Paste。既存の Move to / Copy to(画面内の欄どうし)はそのまま
  - 文字表示(Text)の欄は既存の文字の C&P のまま
- D28 シーンの絵と履歴(v3.2、実機レビュー):
  - シーン = `{ id, name, texts, thumb, image, history }`。`image` = 採用した絵の保存ファイル、`history` = そのシーンの編集モードで作った絵の保存ファイル(古い順、重複なし、新しい 60 件)
  - 編集モードの試し生成はレシピの `run.sequenceScene` にシーン ID を持つ。届いた絵はそのシーンの `history` に入る(保存ファイルが無い絵は入らない)
  - 編集モード中のビューワー(下の履歴の列を含む)= 今のシーンの `history` だけ。採用画像は列で ✓ 印、シーンを開いた時・替えた時に表示。シーン外の絵(シーケンス実行など)は表示しないが、編集モードを抜けるといつもの画像の後ろに並ぶ
  - 絵はギャラリーの手持ちを使い、無ければファイルから読む(`libraryImage`)。アプリを再起動しても履歴は残る
  - Save to = 表示中の絵を採用: 文・サムネ・`image` を更新、ボタンは 1.4 秒 Done
  - 空のシーン = 採用した絵も無く、選んだ欄がすべて空のシーン(欄が空のまま作った絵を採用したシーンは、その欄に何も足さないシーンとして走る)
  - タイルの絵を押すと編集モード。✎ ボタンは置かない
  - 旧形式(`field` 1 つ・シーンの `text`)は読み込み時に `fields: [field]`・`texts: { [field]: text }` に読み替える。レシピの `run.sequence.fields` は欄キーのカンマ区切り
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
  - `seq-<runId>/<キャラ>_p<NN>_s<NN>-<シーン名>`(p = 候補(パターン)、s = シーン、どちらも 1 始まり 2 桁)。名前順でキャラ → パターン → シーンに並ぶ(1 つのパターンのシーンが続けて読める)。Library は `seq-YYYYMMDD-HHmmss` のフォルダだけ、日時順ではなくこの名前順で並べる(D31、2026-11-14)
- Run bar のモードと Generate(D32、2026-11-15、モック `RunModes.dc.html` / `RunModesAll.dc.html`):
  - Generate の左に `[Single | Batch | Sequence]` の切り替え、Sequence のときだけその左に `Sequence…`(ダイアログを開く)。Batch ▾ メニュー(Batch (Random) / Batch (Last) / Expand weights per image… / Sequence…)は廃止
  - ボタンは 1 つで名前は `Generate`。Batch は `Generate (枚数)`、Sequence は `Generate (総数)`。Sequence が始められないとき(キャラ 0 人・Regional など)はボタンを押せなくし、理由をツールチップに出す。Run bar に警告やシーン数は出さない
  - 数の欄は Batch では枚数、Sequence では `Pattern`(キャラ × シーンごとの候補数)。値は別々に保存し、モードで表示を切り替える。Single では薄く表示
  - モードは設定 `run_mode` に保存。選んだキャラも `sequence_run.characters` に保存し、再起動しても残す
  - (D34 で置き換え)シーンの編集モード中は Sequence を押せなくし、Generate は試し撮り(Single / Batch)
  - ダイアログの下は `Done`(編集モード中は `Back` も)だけ。候補数と Generate はダイアログから Run bar に移った
  - Batch (Last) は廃止し、要素ごとの鍵(D33)で置き換える。ブラウザ版はシーケンスなし(Sequence の選択肢を隠すだけで、それ以上は考えない)
- 乱数源の鍵(D33、2026-11-15、モック `LocksLive`、`scripts/shared/promptLocks.js` / `scripts/renderer/promptLocks.js` / `promptLocksUi.js`):
  - 乱数源 = キャラ枠の `Random`、行全体が `random` の Background / Style、行の中の `__wildcard__` と `{a|b}`、AI プロンプトの答え。Prose(Anima)は対象外(Illustrious 系だけを考える)
  - 鍵の場所: Random のキャラ枠は重みの右、乱数源のある行(Positive 側の行だけ)は ⋯ の左、AI カードはモードが Expand / Refine のとき役割の右。引いた値は行の「+ Tag」の右(文字表示のときは入力欄の右下)、キャラ枠は名前の右に `→ 値`。鍵がかかっていれば保持している値、外れていれば最後に引いた値を薄く出す
  - 鍵をかけると、その時点で最後に引いた値を保持する。まだ引いていなければ「次に引いた値」を保持する。保持した値はシードと切り離して使う(鍵のない乱数源は今までどおりシードやその場の乱数で引く)
  - 行の値は乱数源ごとに持つ(ワイルドカードは名前、`{a|b}` は中身と出てくる順、`random` は `list`)。固定タグの編集では鍵も値もそのまま。乱数源を足したり書き換えたりすると、その乱数源だけ次に引いた値を保持する。乱数源を全部消すと値は空になるが鍵は残る。鍵が勝手に外れることはない
  - そのため行のワイルドカードと `{a|b}` は、行ごとに先に引いてから組み立てる(Exclude はその後にかかるので、ワイルドカードが出したタグも Exclude で消せるようになった)。キャラのタグと JSON 枠の分は今までどおり最後にまとめて引く
  - Regional は左右で別の値を持つ(`part` = `left` / `right`。通常の生成は `left`)。両側に入る行も左右で別に引いて別に保持する。キャラは、その側に割り当てたキャラ枠の鍵を使う
  - キャラ枠の鍵は枠の番号に付く。枠を減らすと、なくなった枠の鍵も消える。シーケンス中はキャラをシーケンスが決めるので効かない
  - 保存先は prompt セクションの `prompt_locks`(行)・`character_locks`(キャラ枠)・`ai_prompt_lock`(AI)。プリセットにも入り、`prompt_locks` はシーンにも入る(`SCENE_KEYS`)。モデル種別ごとのプロンプト切り替えにも付いていく。生成中に値を保持する書き込みは元に戻す履歴に入れない(鍵の切り替えは入る)
  - レシピ: 画像ごとに行の引いた値を `run.draws` に記録。「Use settings…」で戻すと、引いた行はすべてその値で鍵がかかった状態になり、AI はその画像の答えで鍵がかかる。記録のない古い画像は、行は鍵なし(引き直し)、キャラは今までどおり Random を引いたキャラに置き換える
  - 「シード固定で全部同じ画像になる」確認(confirmBatchSeed)は、重みの展開がなく、鍵のない `{a|b}`(Wildcard seed オンならワイルドカードも)がなく、AI が毎回答える設定でもないときに出す
  - Batch (Last) の経路(`runSame`、`lastPos` 以外の `last*`)は generate.js / generate_regional.js から削除。Prose・remoteAI・refineRunState の `runSame` 引数は既定値 false のまま残した
- Sequence モード = 編集モード、Generate の縦割り(D34、2026-11-15、モック `SafeRunSplit.dc.html` / `SafeRunAll.dc.html`):
  - 編集モードを Sequence モードに一本化する。Run bar で Sequence を選ぶと、最後に使ったシーケンスの最後に触ったシーンを読み込んで編集モードに入る(帯が出る)。Single / Batch を選ぶと編集モードを抜け、退避した画面の設定が戻る(今の Back と同じ)
  - シーケンスが 1 つも無いとき、Sequence を選ぶとダイアログが開く(作るまで帯は出ない)
  - 帯の `Back`、ダイアログの `Back`、Run bar の `Sequence…` ボタンは無くす。ダイアログは帯の今のシーンを押して開く。ダイアログのタイルを押すと、そのシーンの編集に切り替わる
  - Generate は位置と外形(幅)を変えず、Sequence のときだけ縦に 2 つに割る(既定 60:40)。割っても 1 つのカプセルに見せる(外側だけ角丸、間は細い線 1 本、2026-11-15 に隙間 2px から変更)。Single / Batch は今のオレンジの `Generate` / `Generate (枚数)`。幅は 3 モードで同じにして、切り替えてもボタンの位置がずれないようにする
    - 左(広い方)= `Sample`。今のシーンを 1 枚だけ生成する(Batch の枚数は使わない)。色は帯と同じ青(#1d6fd1)。シーン番号は出さない
    - 右(狭い方)= `Run (総数)`。シーケンス全体を回す。赤(`--saa-run-batch` #b91c1c)に白い録画の点。Run bar のモード切り替えの `Sequence` には点を付けない(2026-11-15 に外した)
    - いつもの位置(ボタンの中ほど)を押すと左に当たるので、押し間違えて損をするのは右を狙って外したときだけになる
  - 数の欄は Sequence では `Pattern` のまま(Run の総数にだけ効く)
  - 不採用: Sequence の長押し開始(何が起きるか分からない、普段使いでは面倒)、Sample の Batch(鍵をかければ Sample を何度か押すのと同じ)、ボタン内のシーン番号、編集モードと Sequence モードを別の状態にすること
  - 実装(2026-11-15、`runModes.js` / `sequenceEdit.js` / `sequenceBatchUi.js`):
    - 最後に触ったシーンは `sequence_run.scene`(設定)に持つ。そのシーンが無ければ先頭のシーン
    - Generate は幅 200px の箱 `#run-generate`。Sample は今の Generate ボタンそのもの(色だけ `--saa-run-sample` 系に替える)、Run は箱の中の別ボタン `#run-sequence-go`
    - 開始できない理由(キャラ未選択など)は Run だけを止める。Sample が止まるのは、Sequence なのにシーンが画面に無いときだけ
    - 編集中のシーンを消すと、そのシーンがあった位置のシーンへ移る(最後のシーンなら 1 つ前)。シーンが 0 になると編集モードを抜ける(Sequence のまま、帯は出ない)
    - 別のシーケンスを読み込むと、その先頭のシーンへ移る。同じ id のシーンがあっても、前の画面の内容は書き込まない
    - Run の画像は届いた順にビューアーに出る(シーンの履歴には入れない)。Single / Batch に戻ると、ビューアー本来の画像と一緒に残る
    - 編集モードのまま閉じたアプリは、次の起動で Sequence モードのまま戻る(D34 より前に編集モードで閉じた分も含む)
  - キャラ名・シーン名は Windows 禁止文字 `\ / : * ? " < > |` と制御文字を `_` に置換、長さ 40 字で切る
  - Library はフォルダ単位表示 → 実行ごとに 1 フォルダ
- キュー表示名: `[Seq] <キャラ> / <シーン> #c` 形式
- 中断: Cancel = 既存どおりキュー全消去、Skip = 残り破棄。生成済み画像はフォルダに残る。再開・未完分再投入は作らない

## 5. UI

- 見た目・部品は design system に従う(`design/design-system`、`AGENTS.md`)。説明文・ヒント文は足さない
- 入口: Run bar で Sequence を選ぶと編集モードに入る。ダイアログ(`dialogShell` / `myDialog`)は帯の今のシーンから開く(D34)
- ダイアログ構成: 2 タブ(大きさ 920×680、2026-11-14 にページ送りからタブへ変更、モック `Tabs.dc.html` / `TabsChars.dc.html` / `TabsNoChars.dc.html`)。保存する「シーンの流れ」と保存しない「実行の設定」をタブで分ける
  - タブ行(見出しのすぐ下): `Scenes` と `Characters`、それぞれ件数のバッジ付き(0 件は赤枠)。右端に `シーン数 × キャラ数 × 候補数` の式。← → キーでタブを切り替えられる
  - `Scenes` タブ(A-2、保存する側):
    - 上の行: Sequence 選択+保存+削除(シーン数はタブのバッジに移した)
    - シーンのタイル格子、6 列、縦スクロール
      - タイル = サムネ(3:4)+左上に番号+下に名前。サムネ無しは点線枠、空のシーンは赤い点線+`Empty`
      - タイルの画像をクリックで編集モードへ、ホバーで右上に削除。編集モード中のシーンはアクセント色の枠+`Editing`
      - 最後に `+ Scene` の点線タイル
      - シーン文(プロンプト)は出さない
  - `Characters` タブ(B、保存しない側):
    - キャラ選択の 2 列をタブいっぱいに直接出す(ポップオーバーにしない)
      - 左: 検索欄、お気に入り一覧(行 = 頭像+名前+`+`、選択済みは薄く `✓`、検索に合わない行は薄く)、下に `Add all` と `Random` [N]
      - 右: `Selected` と人数、選んだキャラの行(つまみ+番号+頭像+名前+×)、ドラッグで並べ替え、下に `Clear`
  - フッター(どちらのタブでも同じ): `Done` だけ(`Back` は D34 で廃止)。候補数・開始不可の理由・`Generate (N)` は Run bar に移した(D32)
    - 直す場所がタブにあるピル(`No characters` → Characters、`No scenes`・`Empty scene` → Scenes)はボタンで、押すとそのタブを開く
  - 開くタブ: Batch ▾ → Sequence… は前回閉じたときのタブ(初回は Scenes)。編集中の帯の今のシーンからは Scenes
- 編集モード(モック `Editing.dc.html`): 4.3
- 確認(モック `Confirm.dc.html`): 合計 ≥ しきい値のとき `Queue N images?`
- 設定(モック `Settings.dc.html`): Settings › General に `sequence_confirm_threshold`
- 開始不可条件(ボタン無効): 対象キャラ 0、シーン 0、空のシーン有り、シーン欄が欄構成に無い、シーン欄 mute、Regional ON、ControlNet・IP-Adapter が効く(D24)、WebUI、model type Diffusion、生成ボタン非活性中
- 進捗・停止: 既存キュー・Cancel・Skip

## 6. 処理フロー

モック `Flow.dc.html` の番号に対応。

### A. Scenes タブ: シーンを作る・保存する(初回・直すとき)

1. A-1 お気に入りにキャラを登録(初回だけ)
2. A-2 Batch ▾ → Sequence…、シーケンスを選ぶ / 新規、シーン欄を選び、シーンを足す・並べる
3. A-3 シーン行 ✎ → 編集モード。いつもの画面でシーン欄と共通設定を調整
4. A-4 Create Image で試し生成
5. A-5 気に入らない → A-3 に戻って直す
6. A-6 気に入った絵で Save to scene(サムネ+文を絵の文に戻す)
7. A-7 次のシーン・直すシーンがあれば A-2(または帯のシーン切替で直接 A-3)。終われば帯の今のシーン → ダイアログで Back → 保存ボタン

### B. Characters タブ: 実行の設定(保存しない)

1. B-1 Scenes タブで保存済みシーケンスを選び、Characters タブへ
2. B-2 Characters タブでキャラを決める(左から足す / Add all / Random、右で並べ替え・外す)
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

- `scripts/main/sequencesStore.js` + IPC(`partsStore.js` / `parts_backend.js` と同じ形): 読込・保存・削除・`current` 書込
- `scripts/shared/settingsSections.js`: app に `sequence_run { count, candidates }`・`sequence_confirm_threshold` だけ足す
- `scripts/renderer/tools/promptBatchExpansion.js`: override に `characters`(スロット番号 → キー)を追加。シーケンス行用の開始関数(fields = baseFields + シーン欄のキー(views / background / style / `cf_…`)、seed = 行シード)
- `scripts/renderer/generate.js`:
  - `createCharacters`: override の `characters[index]` があればそれを `getKey()[index]` と Info 用の `getValue()[index]` の代わりに使う。スロット 1 以外は `None`
  - `generateImage`: `dataPack.sequence` 時は `planBatchExpansion` を使わず行列でループ、AI role None 扱い、prefix・recipe・キュー表示名を sequence 用に
  - `getImageSavePrefix`: sequence prefix 分岐
- `scripts/renderer/loraUi.js` `partLorasForPrompt`: override 中は画面の欄ではなく override の文から `parts:` の LoRA を拾う
- `scripts/renderer/callbacks.js:435`: 編集モード中は Regional ON でも `generateImage` に回す
- `scripts/shared/recipe.js`: `cleanRun` に `sequence`
- 通常生成経路(`dataPack.sequence` 無し)の挙動は不変

### Phase 4: UI

- ダイアログ 1 ファイル(`scripts/renderer/` 配下)、Batch ▾ メニューに項目、言語ファイルに文言
- シーケンス保存・読込・削除: `sequencesStore` の IPC
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

- ダイアログ操作(追加・ドラッグ並べ替え・削除確認・クリック名前変更・タブの切り替えとピルからのタブ移動・左から追加・Add all・Random・右のドラッグ並べ替え・× ・Clear・保存・読込・削除・復元)
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
- Pod 経路での実行ごとのフォルダ分け
- Anima(Diffusion)対応(12 章、初期版の後)

先行実装・過剰抽象化 禁止。

## 10. Phase 1 の確認結果(2026-11-14、00b7d37 時点のコード)

### キャラ

- お気に入り: `fav_characters` = キャラ選択モーダルの option の `key` をそのまま保存(`characterSelectionModal.js:118`)。OC は `oc:<名前>` キーで入る。Random / None は入らない
  - 古い値は大小文字・`_` が違うことがある → 突き合わせは `normalizeSelectionKey`(`selectionModalLogic.js:22`)。どの option にも当たらない値(リストから消えたキャラ)は一覧から外す
  - 並び順は `localeCompare` のアルファベット順(`favoriteCharacters.js:5`)。左の一覧はこの順
- `createCharacters`(`generate.js:228`): キーは `characterList.getKey()[index]`、Info 表示の値は `getValue()[index]`、重みは `getTextValue(index)`。サムネ(`decodeThumb(key)`)・タグ・表示名・`characterKey`(レシピ)はキーに付いてくる
  - → override に `characters`(スロット番号 → キー)を足し、キーと Info 値の 2 か所で読む。重みは UI のスロット 1 のまま(D4)
- スロット 2・3: override で `None` を渡せば `createCharacters` 冒頭で空になる(`generate.js:234`)。スロットは 3 個とは限らない(`getSlotCount()`、+/− で増減)→ 1 以外は全部 `None`

### 欄

- シーン欄の候補: `PRESETABLE_BUILTINS`(`promptFieldManager.js:64`)の views / background / style と、カスタム欄(`prompt_custom_fields[].id`、`cf_…`)。ただし Checkpoint ではキャスト欄と `cf_action`(Diffusion 専用、`castMembers.js:47`)を除く
  - レシピ上の場所: views → `view_tags`、background → `prompt_background`、style → `prompt_style`、カスタム欄 → `prompt_custom_fields[id].text`
  - 名前が "Action" の欄は文章扱い(カプセル表示にならない、`isActionNamed`)。シーン欄に使える
- 文字の読み出し: `readPromptValue(key)`(`promptBatchExpansion.js:19`)が mute → override → `stripDisabledTags`(`~tag`)→ `expandParts`(`parts:`)の順に処理。override の `fields[key]` にシーン文を入れれば、mute・`~tag`・`parts:` は既存どおり効く
  - カスタム欄は `readCustomFieldValue`(`generate.js:208`)経由。欄の UI が無いとき(非表示の Diffusion 欄)は override を見ない → シーン欄の候補から外すので問題なし
  - 注意: `baseFields`(`snapshotFieldsForPromptOverride`)は common / positive / negative 系しか持たない。シーン欄は baseFields に足すのではなく、行ごとの override に別キーで入れる
- 欄の文字の差し替え: 欄プリセットの適用と同じく `globalThis.prompt[id].setValue(text)` + 設定への書込(カスタム欄 = `setFieldText`、組込み欄 = `SETTINGS[prompt_background 等]`)。`setValue` は入力コールバックを呼ばない
- Undo: prompt セクションへの書込は全部 Undo 履歴に積まれる(`settingsPersistence.js:56`、キー単位でまとめる)。→ 編集モードの入る・出る・シーン切替・Save to scene は `runEditTransaction({ source: 'sequence-edit', sections: ['prompt'] })` で 1 手にまとめる。編集中の手入力は普段どおり Undo できる
  - Undo で編集モード中のシーン欄が戻ると、欄 = シーンの関係が崩れる → 欄の変更を監視してシーンに書き戻す(D18 の即反映と同じ経路)ので、Undo も即反映される

### LoRA・Regional・レシピ

- シーン LoRA: バックエンドは positive 全体から `<lora:…>` を拾う(`generate_backend_comfyui.js:1302` の `splitLoraText(positive)`)。カスタム欄・Background の文に入ったタグも LoRAfromText に届く
  - スロット由来のタグは `<lora:<ファイル名(.safetensors 付き)>:m:c>`(`generate.js:612`)。+ LoRA で挿すタグも同じ形にする(ファイル名・値 2 つ)
  - `tagLint` は `<…>` を飛ばす(`tagLint.js:44`)。ADetailer は LoRAfromText の出力から描くので LoRA は効く(`loraStageModels.js`)
  - レシピ取込で `<lora:…>` を LoRA 行にするのは外部(A1111)の文字列を読むときだけ(`recipe.js:214`)。SAA のレシピは sections を持つので二重にならない
  - 見つかった問題: `parts:` が持つ LoRA(`partLorasForPrompt`、`loraUi.js:525`)は override ではなく画面の欄を読む。シーン文に `parts:` を書くと、その Parts の LoRA が付かない(画面の欄の Parts の LoRA が付く)→ override を読むよう直す(Phase 3 に追加)
- Regional: 生成経路の切替は `callbacks.js:435`(`regional_condition` なら `generateRegionalImage`)。編集モード中はここで通常の `generateImage` に回す。設定値は触らないので Undo・state.json に残らない
- ビューワーのレシピ: `globalThis.mainGallery.currentEntry()`(`customGallery.js:279`)→ `{ image, record: { recipe, timing, path } }`。`record.recipe.sections.prompt` にクリック時の欄の文が入っている → Save to scene はここから読む。`image` は data URL → canvas で縮小できる
  - WebUI の絵は record が無い(`generate_backend.js:9`)→ Save to scene は無効

### 保存先・Library・Pod・時間

- 保存先: ComfyUI の `filename_prefix` に `getImageSavePrefix`(`generate.js:1079`)の値が入る。既定 `%date`。サブフォルダ付き prefix は Parts サンプル(`parts-samples/%date`)で実績あり → `seq-<runId>/<…>` は使える
  - sequence 時は `image_save_embed_character_name` / `image_save_path_comfyui` を使わず上書き(キャラ名はファイル名に入る)
- Library: ComfyUI 出力の直下のフォルダが 1 件ずつ出る(`libraryIndex.js:154`)→ `seq-<runId>` は 1 フォルダとして出る
- Pod 経路: 絵は `pod_image_save_dir` に `SAA_<日時>_<seed>.png` で平置き(`generate_backend_comfyui.js:2616`)、prefix は使われない → Pod では実行ごとのフォルダ分けは無し。識別はレシピの `run.sequence` だけ(初期版はこのまま、9 章に追加)
- 生成時間の見積もり: `runTiming` は 1 枚ごとの記録だけで見積もり機能は無い → 表示しない(Generate の総枚数だけ)

### 設定・保存

- 設定セクション新設の影響: `SECTION_KEYS` に足すと PRESET / STATE / 編集可能セクションに自動で入り、state.json に載る・Undo 履歴に積まれる・プリセット行の置き場(`data-preset-host`)が無いと警告が出る(`settingsPersistence.js:191`)→ 新設しない。Parts と同じ専用ストアにする(D16 を変更)
- 編集モード中のアプリ終了: シーン欄にシーンの文が入ったまま state.json に保存される → 入るときの退避値を `sequences.json` の `editBackup { fieldKey, text }` にも書き、起動時に残っていたら欄へ戻して消す
- サムネの大きさ: 128px 高の JPEG(品質 0.8)で data URL 4〜7KB の見込み → 実装時に実測。10KB を超えたら品質を下げる

### 実測(2026-11-14、実装後)

- シーンごとに LoRA タグが違うときの切替コスト(ComfyUI 0.40、512×512・4 steps、キャラ単位の順 = 毎枚切り替わる)
  - LoRA 無しのシーンだけ: 1 枚 約 1.0 秒
  - LoRA 付きのシーン: 初回 8.2 秒(LoRA ファイルの初読込)、以後 2.6〜3.1 秒。直後の LoRA 無しのシーン: 約 1.4 秒
  - 切替 1 回の上乗せ = 約 2 秒。普段の 28 steps・Hires 付き(1 枚 20〜30 秒)なら 1 割未満 → D7(キャラ単位)のまま

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
