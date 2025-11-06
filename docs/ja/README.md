# GSM - ゲーム向けイマージョンツールキット

### [English](../../README.md) | 日本語 | [简体中文](../zh/README.md)

ゲームを使った言語学習を支援するために設計されたアプリケーションです。

ショートデモ（まずはこちらをご覧ください）： https://www.youtube.com/watch?v=FeFBL7py6HY

インストール方法： https://www.youtube.com/watch?v=sVL9omRbGc4

Discord： https://discord.gg/yP8Qse6bb8

## 機能 - [Ankiカードの強化](#ankiカードの強化) | [OCR](#ocr) | [オーバーレイ](#オーバーレイ) | [統計](#統計)

### Ankiカードの強化

GSMは、豊富なコンテキスト情報でAnkiカードを大幅に強化します。

*   **音声の自動キャプチャ**：テキストに対応するセリフの音声を自動的に録音します。

    *   **自動トリミング**：テキストイベントが発生した時間に基づいた簡単な計算と、「音声区間検出」（VAD）ライブラリを組み合わせることで、音声をきれいに切り抜きます。
    *   **手動トリミング**：音声の自動トリミングが完璧でない場合、[外部プログラムで音声を開いて](https://youtu.be/LKFQFy2Qm64)手動でトリミングすることが可能です。

*   **スクリーンショット**：セリフが話された瞬間のゲーム画面をキャプチャします。

*   **複数行対応**：GSM独自のTexthookerを使用することで、複数行のテキストとそれに付随する音声を一度にキャプチャできます。

*   **AI翻訳**：AIを統合し、キャプチャした文章の翻訳を素早く提供します。カスタムプロンプトにも対応しています。（オプション、ご自身のAPIキーが必要です）

#### ゲームでの使用例（音声あり）

https://github.com/user-attachments/assets/df6bc38e-d74d-423e-b270-8a82eec2394c

---

#### ビジュアルノベルでの使用例（音声あり）

https://github.com/user-attachments/assets/ee670fda-1a8b-4dec-b9e6-072264155c6e

### OCR

GSMは[OwOCR](https://github.com/AuroraWright/owocr/)のフォークを実行し、フックが利用できないゲームからでも正確なテキストキャプチャを提供します。以下は、GSMが標準のOwOCRに加えた改良点です。

*   **簡単なセットアップ**：GSMに管理されたPythonインストール機能により、数回ボタンをクリックするだけでセットアップが完了します。

*   **除外領域の設定**：OCRを実行する領域を選択する代わりに、OCRから除外する領域を選択できます。これは、ゲーム内に固定のUIがあり、テキストが画面の様々な場所にランダムに表示される場合に便利です。

*   **2パスOCR**：API呼び出しを減らし、出力をクリーンに保つため、GSMは「2パス」OCRシステムを搭載しています。ローカルOCRが常に実行され、画面上のテキストが安定した時点で、より高精度な2回目のスキャンが実行され、その結果がクリップボードやWebSocketに送信されます。

*   **一貫した音声タイミング**：2パスシステムにより、特殊なオフセットやハックを使わなくても、正確なタイミングで録音された音声をAnkiに取り込むことができます。

*   **多言語対応**：標準のOwOCRは日本語にハードコードされていますが、GSMでは様々な言語を使用できます。

https://github.com/user-attachments/assets/07240472-831a-40e6-be22-c64b880b0d66

---

### オーバーレイ

GSMは、画面上でYomitanによる辞書検索を可能にするオーバーレイ機能も備えています。オーバーレイが有効になっている場合、GSMに任意のソースからテキストイベントが入ってくるたびに、画面を一度スキャンします。その後、ゲーム内の実際の文字にカーソルを合わせることで、Yomitanでの検索やマイニングが可能になります。

https://youtu.be/m1MweBsHbwI

![l0qGasWkoH](https://github.com/user-attachments/assets/c8374705-efa0-497b-b979-113fae8a1e31)

<!--### ゲームランチャー機能（開発中）

これはおそらく私が最も力を入れていない機能ですが、私のように面倒くさがりな方には役立つかもしれません。

*   **起動**：GSMから直接ゲームを起動でき、セットアッププロセスを簡略化します。

*   **フック**：ゲームへのフック（Agent使用）プロセスを効率化します。

この機能は、ゲームの起動と（将来的には）フックのプロセスを簡素化し、ワークフロー全体をより効率的にします。

<img width="2560" height="1392" alt="GameSentenceMiner_1zuov0R9xK" src="https://github.com/user-attachments/assets/205769bb-3dd2-493b-9383-2d6e2ca05c2d" />-->

---

### 統計

GSMには、現在**32種類のグラフ**を備えた統計ページがあり、充実したデータを視覚化できます。

![stats](../../docs/images/overview2.png)

この統計は、ただ見た目が良いだけではありません。

あなたの成長を助けるために設計されています。

目標を設定し、それを達成するために毎日必要なタスクを正確に確認できます：

![stats](../../docs/images/goals2.png)

読んだすべての漢字を、好きな順序で表示できます：

![stats](../../docs/images/kanji_grid2.png)

そして、それらをクリックすると、その漢字を含むすべての文章を見ることができます：

![stats](../../docs/images/search2.png)

Ankiを使っていますか？よく読む漢字だけど、まだAnkiに入っていない漢字を見つけられます：

![stats](../../docs/images/anki2.png)

高度なツールで、好きな方法でデータをクリーンアップできます。

![stats](../../docs/images/db_management2.png)

これらの統計は、ただ見た目を良くするためだけでなく、以下のような質問に答えるために設計されています：
* 楽しさと学習の両方を最大化できるゲームは何か？
* 夕方と朝、どちらの方が読解力が高いか？
* この言語で上達しているか？
* 目標を達成するために、どのくらいイマージョンすべきか？

## 必要なもの

*   **Ankiカード作成ツール**：[Yomitan](https://github.com/yomidevs/yomitan)や[JL](https://github.com/rampaa/JL)など。

*   **ゲームからテキストを取得する方法**：[Agent](https://github.com/0xDC00/agent)、[Textractor](https://github.com/Artikash/Textractor)、[LunaTranslator](https://github.com/HIllya51/LunaTranslator)、GSMのOCR機能など。

*   **ゲームソフト :)**

## ドキュメント

インストール、セットアップ、その他の情報については、プロジェクトの[Wiki](https://github.com/bpwhelan/GameSentenceMiner/wiki)をご覧ください。

## よくある質問

### どのような仕組みですか？

これはよくある質問ですが、このプロセスを理解することは、GSMを使用中に発生する可能性のある問題を解決するのに役立ちます。

1.  セリフの開始は、テキストイベントによってマークされます。これは通常、Textractor、Agent、または他のtexthookerから送られてきます。GSMはクリップボードのコピーやWebSocketサーバーを監視することができます（GSM内で設定可能）。

2.  セリフの終了は、ローカルで実行されている音声区間検出（VAD）ライブラリによって検出されます。（[例](https://github.com/snakers4/silero-vad)）

要するに、GSMは正確なタイミングのテキストイベントに依存して、対応する音声をキャプチャしています。

GSMには、理想的とは言えないフックに対応するための設定が用意されています。しかし、音声に大幅なズレが生じる場合、その原因はGSM自体ではなく、タイミングの悪いフック、大きなBGM、またはその他の外部要因である可能性が高いです。中心となる音声トリミングのロジックは、多くのユーザーによって様々なゲームで安定して効果的に動作することが確認されています。

## お問い合わせ

問題が発生した場合は、私の[Discord](https://discord.gg/yP8Qse6bb8)で質問するか、こちらにissueを作成してください。

## 謝辞

*   [OwOCR](https://github.com/AuroraWright/owocr) - GSMに統合させていただいた、その優れたOCR実装に感謝します。

*   [chaiNNer](https://github.com/chaiNNer-org/chaiNNer) - Electronアプリ内にPythonをインストールするというアイデアに感謝します。

*   [OBS](https://obsproject.com/) と [FFMPEG](https://ffmpeg.org/) - これらのツールなしではGSMは実現不可能でした。

*   [Renji's Texthooker](https://github.com/Renji-XD/texthooker-ui)

*   https://github.com/Saplling/transparent-texthooker-overlay

*   [exSTATic](https://github.com/KamWithK/exSTATic) - GSMの統計機能のインスピレーション

*   [Kanji Grid](https://github.com/Kuuuube/kanjigrid)

*   [Jiten.moe（メタデータ提供）](https://jiten.moe)

## 寄付

もしこのプロジェクトや他の私のプロジェクトが役に立ったと感じたら、[GitHub Sponsors](https://github.com/sponsors/bpwhelan)または[Ko-fi](https://ko-fi.com/beangate)を通じて私の活動を支援していただけると幸いです。