# GameSentenceMiner (GSM)

### [English](../../README.md) | 日本語 | [简体中文](../zh/README.md)

ゲームを使った言語学習を支援するために設計されたアプリケーションです。ゲーム版の「[asbplayer](https://github.com/killergerbah/asbplayer)」を目指しています。

ショートデモ（まずはこちらをご覧ください）： https://www.youtube.com/watch?v=FeFBL7py6HY

インストール方法： https://youtu.be/h5ksXallc-o

Discord： https://discord.gg/yP8Qse6bb8

## 主な機能

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

### ゲームランチャー機能（開発中）

これはおそらく私が最も力を入れていない機能ですが、私のように面倒くさがりな方には役立つかもしれません。

*   **起動**：GSMから直接ゲームを起動でき、セットアッププロセスを簡略化します。

*   **フック**：ゲームへのフック（Agent使用）プロセスを効率化します。

この機能は、ゲームの起動と（将来的には）フックのプロセスを簡素化し、ワークフロー全体をより効率的にします。

<img width="2560" height="1392" alt="GameSentenceMiner_1zuov0R9xK" src="https://github.com/user-attachments/assets/205769bb-3dd2-493b-9383-2d6e2ca05c2d" />

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

## 寄付

もしこのプロジェクトや他の私のプロジェクトが役に立ったと感じたら、[GitHub Sponsors](https://github.com/sponsors/bpwhelan)、[Ko-fi](https://ko-fi.com/beangate)、または[Patreon](https://www.patreon.com/GameSentenceMiner)を通じて私の活動を支援していただけると幸いです。