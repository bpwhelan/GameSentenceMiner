# GameSentenceMiner (GSM)

### [English](../../README.md) | [日本語](../ja/README.md) | 简体中文

一款旨在通过游戏辅助语言学习的应用程序。目标是成为游戏领域的“[asbplayer](https://github.com/killergerbah/asbplayer)”。

简短演示（请先观看）： https://www.youtube.com/watch?v=FeFBL7py6HY

安装教程： https://youtu.be/h5ksXallc-o

Discord： https://discord.gg/yP8Qse6bb8

## 功能特性

### Anki 卡片增强

GSM 通过丰富的上下文信息，极大地增强您的 Anki 卡片：

*   **自动音频捕获**：自动录制与文本相关联的语音。

    *   **自动剪辑**：通过对文本事件出现时间的简单计算，再结合“人声活动检测” (VAD) 库，我们可以得到精确剪辑的音频。
    *   **手动剪辑**：如果自动语音剪辑效果不佳，可以[在外部程序中打开音频](https://youtu.be/LKFQFy2Qm64)进行手动修剪。

*   **屏幕截图**：在语音播放的瞬间，截取游戏画面。

*   **多行文本**：使用 GSM 自带的 Texthooker，可以一次性捕获多行文本及其对应的句子音频。

*   **AI 翻译**：集成了 AI 功能，可为捕获的句子提供快速翻译。也支持自定义提示 (Prompt)。 (可选功能，需要您自备 API 密钥)

#### 游戏示例 (含音频)

https://github.com/user-attachments/assets/df6bc38e-d74d-423e-b270-8a82eec2394c

---

#### 视觉小说 (VN) 示例 (含音频)

https://github.com/user-attachments/assets/ee670fda-1a8b-4dec-b9e6-072264155c6e

### OCR

GSM 运行 [OwOCR](https://github.com/AuroraWright/owocr/) 的一个分支，为那些无法使用文本钩子 (hook) 的游戏提供精确的文本捕获。以下是 GSM 相较于原版 OwOCR 的一些改进：

*   **更简便的设置**：通过 GSM 内置的 Python 安装管理，只需点击几下按钮即可完成设置。

*   **排除区域**：您可以选择一个区域从 OCR 中排除，而不是选择一个区域进行 OCR。如果您的游戏中有静态界面，而文本会随机出现在屏幕各处，这个功能会非常有用。

*   **两步 OCR (Two-Pass OCR)**：为了减少 API 调用并保持输出整洁，GSM 采用了一套“两步” OCR 系统。本地 OCR 会持续运行，当屏幕上的文本稳定后，会进行第二次更精确的扫描，并将结果发送到剪贴板/WebSocket。

*   **一致的音频同步**：借助两步系统，我们无需使用复杂的偏移量或取巧的手段，就能将准确录制的音频导入 Anki。

*   **更多语言支持**：原版 OwOCR 硬编码为仅支持日语，而在 GSM 中，您可以使用多种语言。

https://github.com/user-attachments/assets/07240472-831a-40e6-be22-c64b880b0d66

### 游戏启动器功能 (开发中)

这可能是我最不关心的功能，但如果您和我一样懒，也许会觉得它很有用。

*   **启动游戏**：GSM 可以直接启动您的游戏，简化设置过程。

*   **注入钩子 (Hook)**：简化为游戏注入钩子 (Agent) 的过程。

此功能简化了启动游戏和（未来可能）注入钩子的过程，使整个工作流程更加高效。

<img width="2560" height="1392" alt="GameSentenceMiner_1zuov0R9xK" src="https://github.com/user-attachments/assets/205769bb-3dd2-493b-9383-2d6e2ca05c2d" />

## 基本要求

*   **Anki 卡片制作工具**：[Yomitan](https://github.com/yomidevs/yomitan)、[JL](https://github.com/rampaa/JL) 等。

*   **从游戏中获取文本的方法**：[Agent](https://github.com/0xDC00/agent)、[Textractor](https://github.com/Artikash/Textractor)、[LunaTranslator](https://github.com/HIllya51/LunaTranslator)、GSM 的 OCR 功能等。

*   **一款游戏 :)**

## 文档

有关安装、设置和其他信息，请访问本项目的 [Wiki](https://github.com/bpwhelan/GameSentenceMiner/wiki)。

## 常见问题解答 (FAQ)

### 它是如何工作的？

这是一个常见问题。理解其工作流程有助于您在使用 GSM 时解决可能遇到的问题。

1.  语音的开始由一个文本事件标记。该事件通常来自 Textractor、Agent 或其他文本提取工具 (texthooker)。GSM 可以监听剪贴板复制和/或 WebSocket 服务器（可在 GSM 中配置）。

2.  语音的结束由本地运行的语音活动检测 (VAD) 库来确定。([示例](https://github.com/snakers4/silero-vad))

简而言之，GSM 依赖于准确定时的文本事件来捕获相应的音频。

GSM 提供了一些设置来适应不太理想的文本钩子。但是，如果您遇到严重的音频不同步问题，原因很可能在于钩子计时不准、背景音乐过大或其他外部因素，而非 GSM 本身。其核心的音频剪辑逻辑已在各种游戏中为许多用户稳定有效地工作。

## 联系方式

如果您遇到问题，请在我的 [Discord](https://discord.gg/yP8Qse6bb8) 中寻求帮助，或在此处创建 issue。

## 致谢

*   [OwOCR](https://github.com/AuroraWright/owocr) - 感谢其出色的 OCR 实现，我已将其集成到 GSM 中。

*   [chaiNNer](https://github.com/chaiNNer-org/chaiNNer) - 感谢其在 Electron 应用中安装 Python 的想法。

*   [OBS](https://obsproject.com/) 和 [FFMPEG](https://ffmpeg.org/) - 没有它们，GSM 就不可能实现。

*   [Renji's Texthooker](https://github.com/Renji-XD/texthooker-ui)

*   https://github.com/Saplling/transparent-texthooker-overlay

## 赞助

如果您觉得这个项目或我的其他项目对您有帮助，请考虑通过 [GitHub Sponsors](https://github.com/sponsors/bpwhelan)、[Ko-fi](https://ko-fi.com/beangate) 或 [Patreon](https://www.patreon.com/GameSentenceMiner) 支持我的工作。