# Icons

今のアプリで使っているアイコンの一覧（置き換える前）。まとめた後の形は IconSet を見る。線で描いた 16 単位の枠のアイコンで、色は `currentColor` で文字色を引き継ぐ。

## 置き場所（今）
同じ形が 5 か所に別々に定義されている。
- uiShell.js：dice・lock・chevD・layers（SVG 文字列、線 1.5〜1.6）
- myLoRASlot.js：down・close・relink・image・plus（loraSamples.js と同じパス）
- loraSamples.js：close・back・prev・next・down・right・relink・image・plus・search・pencil（パスの配列、線 1.8）
- sizeRatioUi.js：chain の linked・broken と chevron（SVG 文字列、線 1.5・1.8）
- tagCapsuleChip.js：createIcon の 20 個（線 1.5）
- ほかに html_shared_body.js（grid・expand・info。info は 12 か所に同じものがある）、viewerInfo.js と libraryWindow.js（put-in）。

## 重複
- 下向きの山形は 4 種類（uiShell の chevD は線 1.6、sizeRatioUi は線 1.8 で 10px、loraSamples の down は線 1.8、タグ側の chevronDown は線 1.5）。
- close・plus は 3 か所、search・lock は 2 か所。
- layers と dice（random）は名前が同じでも形が違う（dice は点 4 つ、random は点 3 つ）。

## 決まり
- 新しいアイコンは Icons グループの形と線の太さに合わせ、1 か所の定義から使う。
- Legacy グループ（scripts/svg）は、もとのアプリの塗りのアイコン。新しい部品には使わない。
- アセットの SVG を `<img>` で表示すると `currentColor` が効かず黒くなる。アプリでは SVG を要素として埋め込んでいる。
