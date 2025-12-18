<p align="center">
    <img src="https://github.com/bpwhelan/GameSentenceMiner/blob/main/assets/gsm.png?raw=true" width="100" height="100" style="border-radius: 20px" alt="gamesentenceminer" />
</p>

<h1 align="center">GSM (GameSentenceMiner)</h1>

<p align="center">
    <b>ゲーム時間を語学の習得へ。</b><br>
</p>

<div align="center">

[![Github All Releases](https://img.shields.io/github/downloads/bpwhelan/GameSentenceMiner/total.svg)](https://github.com/bpwhelan/GameSentenceMiner/releases)
<a href="https://github.com/sponsors/bpwhelan">
        <img src="https://img.shields.io/static/v1?label=Sponsor&message=%E2%9D%A4&logo=GitHub&color=%23fe8e86" alt="Sponsor on GitHub">
    </a>
[![Ko-Fi](https://img.shields.io/badge/donate-ko--fi-ed6760?label=donate)](https://ko-fi.com/beangate)
[![Discord](https://img.shields.io/discord/1286409772383342664?color=%237785cc)](https://discord.gg/yP8Qse6bb8)
[![GitHub License](https://img.shields.io/github/license/bpwhelan/GameSentenceMiner)](https://github.com/bpwhelan/GameSentenceMiner?tab=GPL-3.0-1-ov-file)

[English](../../README.md) | 日本語 | [简体中文](../zh/README.md)

</div>

---

### 🎮 実際の動作

![Demo Gif](../../.github/files/readme_demo.avif)

- テキストフック（Text Hook）に対応していないゲームでも、OCRでテキストを取得。
- ゲーム内でYomitanを使って単語を検索。
- ゲームの音声とGIF画像を含んだAnkiカードを自動作成。

---

## GSMとは？

GSMは、ゲームをプレイしながら単語カード（Flashcards）を作成するプロセスを自動化するために設計されたアプリケーションです。ゲームとAnkiの間で動作し、音声録音、スクリーンショット撮影、OCR処理を行うため、ゲームプレイを中断する必要がありません。

### 📝 Ankiカードの強化
GSMは、単語を検索した際に自動的にコンテキスト（文脈情報）をAnkiカードに追加します。
*   **音声キャプチャ:** VAD（音声区間検出）を使用し、テキストに対応する音声を正確に録音・トリミングします。
*   **スクリーンショット:** セリフが話された瞬間のゲーム画面をキャプチャします。GIFおよび黒帯（レターボックス）の削除もサポートしています。
*   **履歴からのカード作成:** 過去のログに遡り、以前に遭遇したセリフ（カットシーンなど）からカードを作成できます。
*   **複数行サポート:** 内蔵のTexthookerを使用して、複数のセリフを1枚のカードにまとめることができます。
*   **AI翻訳:** オプションの統合機能により、ご自身のAPIキーを使用して文章の翻訳を追加できます。

https://github.com/user-attachments/assets/df6bc38e-d74d-423e-b270-8a82eec2394c

### 👁️ OCR (文字認識)
テキストフック（Agent/Textractor）がないゲームの場合、GSMは[OwOCR](https://github.com/AuroraWright/owocr/)のカスタムフォークを使用して、画面から直接テキストを読み取ります。

これにより、通常は語学学習や例文収集（Sentence Mining）が難しいゲームでも利用可能になります。例えば、私はGSMのOCRを使用して『メタルギアソリッド 1+2』『タイタンフォール2』『SEKIRO: SHADOWS DIE TWICE』などのカードを作成しました。

*   **簡単なセットアップ:** 管理されたインストールプロセスにより、ターミナル操作は不要です。
*   **2パスシステム:** 直接フックしたかのような、クリーンで高速な出力を実現します。
*   **キャプチャ範囲のカスタマイズ:** 画面上のテキスト表示位置を正確に定義し、最適な結果を得ることができます。

https://github.com/user-attachments/assets/07240472-831a-40e6-be22-c64b880b0d66

### 🖥️ オーバーレイ
GSMには、即座に辞書検索ができる透明なオーバーレイが含まれています。

現在Windowsのみ対応しており、LinuxおよびMacのサポートは開発中です。
*   ゲーム内の文字にカーソルを合わせるだけで、Yomitan経由で定義を表示。
*   ゲームウィンドウを離れることなくカードを作成可能。

![Overlay Demo](https://github.com/user-attachments/assets/c8374705-efa0-497b-b979-113fae8a1e31)

### 📊 統計
統計ダッシュボードで、イマージョン（没入学習）の習慣を追跡できます。
*   **漢字グリッド:** これまでに遭遇したすべての漢字を表示し、クリックするとその漢字が含まれるソース文を確認できます。
*   **目標:** 毎日の読書目標を設定できます。
*   **データベース管理:** マイニング履歴の整理やクリーンアップを行えます。

![stats](../../docs/images/overview2.png)

---

## 🚀 はじめに

1.  **ダウンロード:** [最新リリース](https://github.com/bpwhelan/GameSentenceMiner/releases)を入手してください。
2.  **インストール:** [インストールガイド（動画）](https://www.youtube.com/watch?v=sVL9omRbGc4)をご覧ください。
3.  **必要要件:**
    *   Ankiツール (Yomitan, JLなど)
    *   テキストソース (Agent, Textractor, または GSM内蔵のOCR)
    *   ゲーム

## 📚 ドキュメント

完全なセットアップガイドや設定の詳細については、[Wiki](https://docs.gamesentenceminer.com/) をご覧ください（現在作成中）。

## ❤️ 謝辞

*   OCRバックエンド: [OwOCR](https://github.com/AuroraWright/owocr) & [MeikiOCR](https://github.com/rtr46/meikiocr)
*   [Renji's Texthooker](https://github.com/Renji-XD/texthooker-ui) & [Saplling](https://github.com/Saplling/transparent-texthooker-overlay)
*   統計デザインのインスピレーション: [exSTATic](https://github.com/KamWithK/exSTATic)
*   Python統合戦略: [chaiNNer](https://github.com/chaiNNer-org/chaiNNer)