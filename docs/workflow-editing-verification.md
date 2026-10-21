# ワークフロー改善の検証記録（2026-10-21）

## 対象と環境

ブランチは`codex/workflow-editing`。デスクトップ版でP0の実行記録とP1の手動マスク編集を実装した。ブラウザ版の機能追加は対象外。

実機確認は既存のComfyUI `3541246a`（`127.0.0.1:8189`）、既存Checkpoint `waiIllustriousSDXL_v160.safetensors`、既存Impact Packの`MaskDetailerPipe`を使用。モデルの追加・置換やComfyUI更新は実施していない。通常の設定を変更せず、専用settingsでElectronを起動し、既存E2E harnessのCDP操作で確認した。

## 結果

| 項目 | 結果 | 確認内容 |
|---|---|---|
| 自動テスト | PASS | 1,265件中1,263成功、2スキップ、失敗0。最終の取消記録変更後も関連6件成功 |
| P0・通常生成 | PASS | 768×512の非人物静物を実画面から生成。最終PNG、VAEDecode段階画像、指定値、API prompt、選択出力、job ID、22件のイベントを保存 |
| P0・キャッシュ | PASS | 同じ親・同じ設定の再生成と分岐でキャッシュ通知を取得。progressなしでも最終画像を取得し、実行状態をキャッシュとして記録 |
| P1・人工画像合成 | PASS | 同梱fixtureを本番のcrop/合成経路へ通し、独立した`check_preservation.py`でも保持検査成功。変更13,202画素、保護領域変更0画素 |
| P1・実画像2領域 | PASS（下記画質限界あり） | 左の果物の色・形と右の布への青い線という異なる変更を生成。採用版の変更画素数は32,801／17,846 |
| P1・全候補の保持 | PASS | 未採用・破棄・採用・分岐を含む5候補すべてで独立検査成功。保護領域の変更画素数・最大チャンネル差はいずれも0 |
| 親・採否・連続編集 | PASS | 同じR0から2候補、片方破棄、再試行候補をR1として採用。布のLockを明示解除し、採用済み果物をLockへ追加してR1からR2を生成 |
| 再起動・Undo・分岐 | PASS | アプリ終了・再起動後にR2を復元。R1へ戻り別候補を採用、旧R2も保持したまま再選択できた |
| 失敗・再試行 | PASS | HTTP結果照会タイムアウトで失敗した試行を保持。親・マスク・設定を再起動後に復元して再試行成功 |
| 中止 | PASS | UIの中止操作で候補を採用せず`cancelled`として記録、現在版を保持。今回のUI試行では遠隔計算は既にキャッシュ完了しており、GPU計算の途中中断を証明する試験ではない。送信中取消と応答待機は制御サーバーテストで別途確認 |
| 不正入力 | PASS | 8×8のマスクを768×512親へ読み込むと寸法エラー。暗黙の伸縮を行わず、同じファイルを再選択できる |
| ブラシ座標 | PASS | 表示150%、横180px・縦80pxスクロール後の実マウス入力が原画(400,180)へ描かれた |
| 古い親の候補 | PASS | 異なる親の未採用候補を表示中は生成・採用・描画を無効化し、比較と明示的な親復元のみ許可 |
| Pod実機生成 | NOT_RUN | 有料リソースを使用していない。出力変換後グラフ、relay証跡、画像の保存はunit testで確認 |
| Diffusion/UNet部分編集 | NOT_RUN | 初期対応の範囲外。Checkpoint系に限定 |

## 目視評価と限界

画素保持とは別に、親画像と各合成結果を目視比較した。採用した2候補には、cropの位置ずれや合成許可範囲外のハロー、明白な切断線は見られなかった。ただし果物には黄色いハイライトが残り、布の青い線は指定した細い反復ストライプより縁取りに近い。意味のある変更は確認できたが、細かな指示への忠実度はこのモデル・設定では限定的。任意の画像・指示で同じ品質になるとは結論づけない。

初回候補はマスク境界近くに元の黄色が残ったため、マスクと余白を広げて再試行した。その途中でComfyUIが計算中にもかかわらず30秒のhistory照会だけが失敗する問題を確認し、通信失敗の再試行と終了時の対象job取消を追加した。失敗時点の親は不変。試験で残った当該jobはIDを指定して停止した。

成功した再試行はguide size 384／max size 512、16 steps、CFG 5、euler/normal。果物はdenoise 0.6、布は0.72。実行時間は環境の負荷で変動しており、速度比較やピークVRAM計測の試験にはしていない。

## 保存証拠

検証生成物はGit除外の`reports/workflow-edit-2026-10-21/`に保存している。

- `still-life-original.png`、`basket-retry-result.png`、`cloth-result.png`：原画、採用した第1・第2編集。
- `synthetic-preservation.json`、`all-preservation.json`：独立チェッカーの結果。RGB/RGBAの親と出力は変換せず比較。マスクは保存PNGの赤チャンネルをLへ抽出し、Lockの非0を255へ正規化してアプリの契約と合わせた。
- `branch-check.json`、`cancel-check.json`、`brush-check.json`、`stale-parent-check.json`：実画面操作の確認結果。
- `original-run.json`、`workflows/`：実行ごとのAPI prompt、設定、画像、イベント、親子関係、採否、失敗記録の保存コピー。
- `final-editor-ui.png`、`run-history-ui.png`：実際の画面。後者は実機検証初期の表示で、当時の`observed-running`は「executingイベントを観測した」の意味。現実装では`execution-observed`と表示して現在実行中との混同を避ける。
- `unit-tests.txt`：全体テストの結果。

元画像のファイルバイト列も検証前後で同一。画像の保護契約そのものはファイルバイトではなくdecode後の全チャンネルを比較している。個々の結果画像はAPI promptをPNGへ再埋め込みせず、隣接するプロジェクト記録から対応runへ辿る。

## experimentalへの統合

同日、既存の`experimental`（`bbd100c`）へ上記の実装4コミットを取り込んだ。既存のLoRA・Library・画像のrecipe/timing機能を保持し、通常生成の実行記録経路にもrecipeの送信と保存先・生成時間の受け渡しを接続した。バージョン番号はexperimentalのものを維持した。

- 統合後のunit test：1,339件中1,337成功、2スキップ、失敗0。
- HTTP/WebSocket制御サーバーで、送信応答前のイベント、他jobの除外、PNG内のrecipe/timingと保存先の引き継ぎを確認。
- 実機`tests/e2e/recipe.e2e.mjs`：2件成功。専用settingsでComfyUIから生成し、保存PNGのrecipe/timing、Info表示、「Use settings…」での設定読み戻しとUndoを確認。使用Checkpointは既存の`waiIllustriousSDXL_v170.safetensors`。
- 実機テストのログとsettingsは`C:/Users/kurah/AppData/Local/Temp/saa-e2e-2pVfih/`に保存。元の実装時の部分編集検証は上記の記録を参照。
