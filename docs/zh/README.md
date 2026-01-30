<p align="center">
    <img src="https://github.com/bpwhelan/GameSentenceMiner/blob/main/assets/gsm.png?raw=true" width="100" height="100" style="border-radius: 20px" alt="gamesentenceminer" />
</p>

<h1 align="center">GSM (GameSentenceMiner)</h1>

<p align="center">
    <b>让游戏时间助你掌握语言。</b><br>
</p>

<div align="center">

[![Github All Releases](https://img.shields.io/github/downloads/bpwhelan/GameSentenceMiner/total.svg)](https://github.com/bpwhelan/GameSentenceMiner/releases)
<a href="https://github.com/sponsors/bpwhelan">
        <img src="https://img.shields.io/static/v1?label=Sponsor&message=%E2%9D%A4&logo=GitHub&color=%23fe8e86" alt="Sponsor on GitHub">
    </a>
[![Ko-Fi](https://img.shields.io/badge/donate-ko--fi-ed6760?label=donate)](https://ko-fi.com/beangate)
[![Discord](https://img.shields.io/discord/1286409772383342664?color=%237785cc)](https://discord.gg/yP8Qse6bb8)
[![GitHub License](https://img.shields.io/github/license/bpwhelan/GameSentenceMiner)](https://github.com/bpwhelan/GameSentenceMiner?tab=GPL-3.0-1-ov-file)

[English](../../README.md) | [日本語](../ja/README.md) | 简体中文  | [Español](../es/README.md)

</div>

---

### 🎮 实际演示

![Demo Gif](../../.github/files/readme_demo.avif)

- OCR 识别游戏文本（即使游戏不支持文本提取钩子）。
- 在游戏中直接使用 Yomitan 查词。
- 自动创建包含游戏音频和 GIF 的 Anki 卡片。

---

## 它能做什么？

GSM 是一款应用程序，旨在自动化您在玩游戏时创建抽认卡（Flashcards）的过程。它在您的游戏和 Anki 之间运行，处理音频录制、屏幕截图和 OCR，让您无需中断游戏体验。

### 📝 Anki 卡片增强
当您查词时，GSM 会自动为您的 Anki 卡片添加上下文信息。
*   **音频捕获：** 使用语音活动检测 (VAD) 记录并修剪与文本相关的特定语音行。
*   **屏幕截图：** 在语音播放的瞬间捕获游戏画面。支持 GIF 和黑边移除。
*   **历史挖掘：** 回溯并从之前遇到的对话（如过场动画）中创建卡片。
*   **多行支持：** 使用内置的 Texthooker 将多行对话捕获到一张卡片中。
*   **AI 翻译：** 可选集成，使用您自己的 API 密钥提供句子翻译。

https://github.com/user-attachments/assets/df6bc38e-d74d-423e-b270-8a82eec2394c

### 👁️ OCR (文本识别)
对于没有文本钩子 (Agent/Textractor) 的游戏，GSM 使用 [OwOCR](https://github.com/AuroraWright/owocr/) 的自定义分支直接从屏幕读取文本。

这为那些原本无法进行语言学习/句子挖掘的游戏（例如《合金装备 1+2》、《泰坦陨落 2》和《只狼》）开启了无限可能，这些游戏我都使用 GSM 的 OCR 制作过卡片。

*   **简易设置：** 托管安装，无需折腾终端。
*   **双重传递系统：** 输出干净、快速，类似于直接 Hook。
*   **可自定义捕获区域：** 精确定义屏幕上文本出现的区域，以获得最佳结果。

https://github.com/user-attachments/assets/07240472-831a-40e6-be22-c64b880b0d66

### 🖥️ 覆盖层 (Overlay)
GSM 包含一个透明覆盖层，可实现即时词典查询。

目前仅支持 Windows，Linux 和 Mac 支持正在开发中。
*   在游戏中悬停在字符上，通过 Yomitan 查看定义。
*   无需离开游戏窗口即可创建卡片。

![Overlay Demo](https://github.com/user-attachments/assets/c8374705-efa0-497b-b979-113fae8a1e31)

### 📊 统计数据
使用统计仪表板跟踪您的沉浸式学习习惯。
*   **汉字网格：** 查看您遇到的每一个汉字，点击它们可查看来源句子。
*   **目标：** 设定每日阅读目标。
*   **数据库管理：** 清理和组织您的挖掘历史。

![stats](../../docs/images/overview2.png)

---

## 🚀 入门指南

1.  **下载：** 获取 [最新版本](https://github.com/bpwhelan/GameSentenceMiner/releases)。
2.  **安装：** 观看 [安装指南](https://www.youtube.com/watch?v=sVL9omRbGc4)。
3.  **系统要求：**
    *   一个 Anki 工具 (Yomitan, JL 等)
    *   一个文本源 (Agent, Textractor, 或 GSM 内置的 OCR)
    *   一个游戏

## 📚 文档

有关完整的设置指南和配置详情，请查阅 [Wiki](https://docs.gamesentenceminer.com/) (目前正在完善中)。

## ❤️ 致谢

*   [OwOCR](https://github.com/AuroraWright/owocr) & [MeikiOCR](https://github.com/rtr46/meikiocr) 提供 OCR 后端支持。
*   [Renji's Texthooker](https://github.com/Renji-XD/texthooker-ui) & [Saplling](https://github.com/Saplling/transparent-texthooker-overlay)。
*   [exSTATic](https://github.com/KamWithK/exSTATic) 提供统计设计灵感。
*   [chaiNNer](https://github.com/chaiNNer-org/chaiNNer) 提供 Python 集成策略。