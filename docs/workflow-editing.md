# デスクトップ版：実行履歴と部分編集

## 操作

「ライブラリ」で画像を選び、「ビュワーで開く」→「部分編集」で、表示中の画像に直接マスクを描く。画像のダブルクリックでもビュワーを開ける。ギャラリー上部の部分編集、実行履歴の「この画像を部分編集」、ライブラリの「PNGを開く」も同じビュワーにつながる。

ライブラリ左側の「編集した画像」からプロジェクトを開き直せる。元のファイルを再び部分編集した場合も、同じ場所・同じ画素の画像なら既存プロジェクトの現在版から再開する。別の場所へコピーした画像や、内容が変わったファイルは別プロジェクトになる。一覧は100件ずつ移動できる。

「画像」と「部分編集」を切り替えても、一覧に戻って同じプロジェクトを開いても、作業中のマスクと設定は維持する。ライブラリを閉じて開き直した場合も同様。別の画像への切り替え時には未保存内容の破棄を確認する。未生成のマスクと設定はアプリ再起動をまたいで保存しない。

1. 親画像上で編集範囲とLockを描く。同じ寸法のPNGマスクも読み込める。
2. 指示、Checkpoint、Seed、Steps、CFG、Sampler、Scheduler、Denoiseを指定する。Fast設定は部分編集には自動適用しない。
3. 「変わる範囲を確認」で合成許可範囲を確認してから候補を生成する。
4. 親画像・生成候補・合成結果を同じ座標で比較し、採用または破棄する。候補作成だけでは現在版は変わらない。同じ親から複数候補を作れる。
5. 次の編集では必要なLockを明示的に解除する。「直前の編集範囲をLock」で前の編集を保護できる。
6. 採用済みの版から戻る先を選べる。編集記録から、その編集の親・マスク・Lock・設定も復元できる。過去の分岐は削除しない。

生成候補を表示中は描画を止め、親画像に戻すと描画を再開する。現在版と別の親を持つ候補は比較専用。実行中の画面操作と通常生成は排他制御する。

## 画素保持と保存

- 親画像は8-bit RGB/RGBA・無ICC・未回転・非アニメーションPNG。16,777,216画素まで。互換性を確認できない画像は理由を表示して拒否する。
- マスクの赤チャンネルが編集係数。Lockは0以外を保護扱いとする。編集範囲とLockが重なればLockが優先される。
- フェザーは編集範囲内だけに制限する。cropの余白は参照用であり、変更許可ではない。生成用マスクと最終合成alphaを別に保存する。
- 親の全体リサイズや色変換を行わず、候補が元のcrop寸法で戻ったことを確認して合成する。保存したPNGを再decodeし、alpha=0またはLock内の全チャンネル差が0でなければ候補登録しない。
- 原画・マスク・候補・合成PNGは新しい名前で保存し、既存ファイルを上書きしない。候補の採否と現在版だけを記録に更新する。

保存先は使用中のsettingsディレクトリ内の`workflows/`。標準起動なら`settings/workflows/`、検証用の`--saa-settings-dir`指定時はその配下となる。ライブラリの「編集データの場所」でsettingsフォルダーを開き、`workflows/`を参照できる。

```
workflows/
  preferences.json
  runs/<run UUID>/record.json, final.png, stage-*.png
  projects/<project UUID>/record.json, original.png,
    <attempt UUID>-mask.png, -lock.png, -alpha.png,
    -candidate.png, -candidate-full.png, -composite.png
```

原画を含むローカルデータであり、Gitと配布パッケージから除外する。自動削除や保存期限は設けていない。再起動時に終了記録がない試行は`interrupted`として表示し、遠隔側の実行完了を推定しない。

## 実行記録の意味

`requested`はFast適用前の許可された設定項目、`transforms`はFastなどの変換理由、`apiPrompt`は送信するグラフ、`provenance`は選択出力までの静的な接続と工程の入力・由来。API認証情報やキュー内のLLMキーは収集しない。

`promptId`、出力ノード・画像スロット・batch index、ComfyUIイベント、キャッシュ通知、保存画像を紐づける。接続されていることと実際の計算実行は別扱いであり、Detailer内部の検出数・再描画の有無など、取得していない情報は不明のまま残す。

段階記録は既定OFF。ONなら選択出力が既に依存する既知のIMAGE出力にだけPreviewImageを追加する。未選択の枝を有効化したり、比較のために新しいsamplerを実行したりしない。中間latentを新たにdecodeする処理も追加しないため、画像出力を持たない中間段階の画像は得られない。

ローカルComfyUIでは先にWebSocketを接続し、最終結果をhistoryから取得する。キャッシュでprogressが発生しなくても画像を取得する。取消は`POST /api/jobs/{prompt_id}/cancel`を利用し、応答前に実行枠を解放しない。確認環境にはこのAPIがある。未対応サーバーで取消APIが失敗した場合はエラーを表示し、無関係なジョブを止める全体interruptへ自動退避しない。

Pod生成では既存のSSH/WebSocket転送を維持し、出力変換後のAPI promptとrelayが返すjob ID・最終画像を記録する。relayが提供しない工程ごとの実行証跡・段階画像は取得不可と記録する。今回の検証で有料Podは起動していない。

## 対応範囲

部分編集はローカルComfyUIのCheckpoint系。既存環境の`MaskDetailerPipe`、`ToBasicPipe`、`GzippedBase64ToImage`、`LoRAfromText`などを実際のobject_infoで確認し、利用可能なmodel/sampler/schedulerのみ受け付ける。Diffusion/UNet、Pod上の部分編集、ブラウザ版は今回の対象外。

通常のCheckpoint・Regional生成では、同一モデルRefinerの迂回条件をlatent HiResでも統一した。ADetailerは利用者が選択したHiRes／色転送後の画像を受け取るよう修正した。モデル・LoRAの入れ替えや環境更新は行わない。

## 検証

自動テストは`node --test`で通常のテスト群を実行する。`tests/e2e/workflow-edit-session.mjs`は検証用の専用settingsでSAAを起動する手動E2E補助。既存のローカルComfyUIを使用する。画像やpromptを含む検証生成物はGit除外の`reports/workflow-edit-2026-10-21/`に置く。

実機検証結果は`docs/workflow-editing-verification.md`に記録する。画素保持、意味のある編集、境界品質は別々に判定する。
