<p align="center">
    <img src="https://github.com/bpwhelan/GameSentenceMiner/blob/main/assets/gsm.png?raw=true" width="100" height="100" style="border-radius: 20px" alt="gamesentenceminer" />
</p>

<h1 align="center">GSM (GameSentenceMiner)</h1>

<p align="center">
    <b>Convierte tu tiempo jugando en dominio de lenguaje.</b><br>
</p>

<div align="center">

[![Github All Releases](https://img.shields.io/github/downloads/bpwhelan/GameSentenceMiner/total.svg)](https://github.com/bpwhelan/GameSentenceMiner/releases)
<a href="https://github.com/sponsors/bpwhelan">
        <img src="https://img.shields.io/static/v1?label=Sponsor&message=%E2%9D%A4&logo=GitHub&color=%23fe8e86" alt="Sponsor on GitHub">
    </a>
[![Ko-Fi](https://img.shields.io/badge/donate-ko--fi-ed6760?label=donate)](https://ko-fi.com/beangate)
[![Discord](https://img.shields.io/discord/1286409772383342664?color=%237785cc)](https://discord.gg/yP8Qse6bb8)
[![GitHub License](https://img.shields.io/github/license/bpwhelan/GameSentenceMiner)](https://github.com/bpwhelan/GameSentenceMiner?tab=GPL-3.0-1-ov-file)

[English](../../README.md) | [日本語](../ja/README.md) | [简体中文](../zh/README.md) | Español

</div>

---

### 🎮 Véalo en Acción

![Demo Gif](../../.github/files/readme_demo.avif)

- OCR (Reconocimiento Óptico de Caracteres) para obtener texto de juegos sin soportes para text hooks (ganchos de texto).
- Ve las definiciones de palabras en Yomitan sin salir del juego.
- Crea cartas para Anki con audio del juego + captura de pantalla (o gif) de manera automática.

---

## ¿Qué hace GSM?

GSM es una aplicación diseñada para automatizar el proceso de creación de flashcards mientras juegas. Se coloca entre tu juego y Anki, encargándose de la grabación de audio, capturas de pantalla, y OCR para que tu gameplay no se vea interrumpido.


### 📝 Mejoramiento de Cartas de Anki
GSM automáticamente añade contexto a tus cartas en Anki cuando las creas.
*   **Captura de audio:** Usa la detección de actividad de voz (VAD) para grabar y recortar la linea de voz asociada con el texto.
*   **Capturas de pantalla:** Captura el juego en el momento en el que la linea es hablada. Soporte para GIFs y el Recorte de Barras Negras.
*  **Mina desde el historial:** Regresa y crea cartas de lineas anteriormente grabadas.
*   **Soporte Multi-Linea:** Captura multiples lineas de dialogo en una sola carta utilizando el Texthooker incluido.
*   **Traducción con IA:** Integración Opcional para proveer traducción de oraciones utilizando tu propia llave API.

https://github.com/user-attachments/assets/df6bc38e-d74d-423e-b270-8a82eec2394c

### 👁️ OCR (Reconocimiento de texto)
Para juegos sin text hooks (Agent/Textractor), GSM usa un fork personalizado de [OwOCR](https://github.com/AuroraWright/owocr/) para leer texto directamente desde la pantalla.

Esto abre todo tipo de posibilidades para juegos que de otra manera serian inaccesibles para aprendizaje de lenguaje/minar oraciones. Por ejemplo he hecho cartas con juegos como Metal Gear Solid 1+2, Titanfall 2, y Sekiro, todas utilizando el OCR de GSM.

*   **Easy Setup:** Managed installation means you don't need to fiddle with terminals.
*   **Two-Pass System:** Clean, fast output similar to as if you had a hook.
*   **Customizable Capture Zones:** Define exactly where text appears on your screen for optimal results.

https://github.com/user-attachments/assets/07240472-831a-40e6-be22-c64b880b0d66

### 🖥️ Overlay
GSM includes a transparent overlay for instant dictionary lookups.

Currently Windows only, Linux and Mac support are WIP.
*   Hover over characters in-game to see definitions via Yomitan.
*   Create cards without ever leaving the game window.
*   Automatically Generated Furigana Display In Game.

![Overlay Demo](https://github.com/user-attachments/assets/c8374705-efa0-497b-b979-113fae8a1e31)

### 📊 Statistics
Track your immersion habits with the stats dashboard.
*   **Kanji Grid:** View every Kanji you've encountered and click them to see their source sentences.
*   **Goals:** Set daily reading targets.
*   **Database Management:** Clean up and organize your mining history.

![stats](../../docs/images/overview2.png)

---

## 🚀 Getting Started

1.  **Download:** Get the [latest release](https://github.com/bpwhelan/GameSentenceMiner/releases).
2.  **Install:** Watch the [Installation Guide](https://www.youtube.com/watch?v=sVL9omRbGc4).
3.  **Requirements:**
    *   An Anki tool (Yomitan, JL, etc.)
    *   A text source (Agent, Textractor, or GSM's built-in OCR)
    *   A game

## 📚 Documentation

For full setup guides and configuration details, check the [Wiki](https://docs.gamesentenceminer.com/) (Currently WIP).

## ❤️ Acknowledgements

*   [OwOCR](https://github.com/AuroraWright/owocr) & [MeikiOCR](https://github.com/rtr46/meikiocr) for the OCR backend.
*   [Renji's Texthooker](https://github.com/Renji-XD/texthooker-ui) & [Saplling](https://github.com/Saplling/transparent-texthooker-overlay).
*   [exSTATic](https://github.com/KamWithK/exSTATic) for the stats design inspiration.
*   [chaiNNer](https://github.com/chaiNNer-org/chaiNNer) for the Python integration strategy.

### Integrated Components

This project includes modified versions of the following libraries, I got tired of submodule hell so I've included them directly here for easier management all credits go to the original authors:

*   **Texthooker UI**
    - GSM: https://github.com/bpwhelan/GameSentenceMiner/tree/main/texthooker
    - Original: [Renji-XD/texthooker-ui](https://github.com/Renji-XD/texthooker-ui)  

*   **OwOCR** 
    - GSM: https://github.com/bpwhelan/GameSentenceMiner/tree/main/GameSentenceMiner/owocr
    - Original: [AuroraWright/owocr](https://github.com/AuroraWright/owocr)  

*   **MeCab Controller**
    - GSM: https://github.com/bpwhelan/GameSentenceMiner/tree/main/GameSentenceMiner/mecab
    - Original: [Ajatt-Tools/mecab_controller](https://github.com/Ajatt-Tools/mecab_controller)  

## Star History

<a href="https://www.star-history.com/#bpwhelan/GameSentenceMiner&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=bpwhelan/GameSentenceMiner&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=bpwhelan/GameSentenceMiner&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=bpwhelan/GameSentenceMiner&type=date&legend=top-left" />
 </picture>
</a>
