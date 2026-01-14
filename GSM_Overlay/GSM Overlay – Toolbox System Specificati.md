GSM Overlay – Toolbox System Specification
1. Overview

GSM Overlay allows users to overlay text and tools on top of games.
When the user presses Alt + Shift + T, a Toolbox overlay is displayed.

The Toolbox is a transparent, full-screen overlay that provides small, modular tools intended to assist with studying while playing video games.

2. User Interaction & Hotkeys

Alt + Shift + T
Opens or toggles the Toolbox overlay.

Alt + Shift + H (Hide Overlay Box)
Hides other overlay boxes.
Exception: If the Toolbox is activated, it must remain visible as long as the Overlay itself is active.

3. Toolbox Overlay Behavior

The Toolbox:

Uses 100% of the overlay’s vertical height

Scales horizontally based on the number of active tools

Is fully transparent, allowing the game to be visible underneath

Covers the entire screen

The Toolbox is column-based only (no rows).

Layout Rules

If there is 1 tool:

X


The tool occupies 100% width and 100% height.

If there are 2 tools:

XX


Each tool occupies 50% width and 100% height.

For N tools:

The Toolbox divides horizontal space equally into N columns

Each column is 100 / N % width and 100% height

3+ tools follow the same equal-width column rule.

There is no minimum width for tools.

If the screen becomes too narrow:

No automatic layout adjustments are made

Users are expected to disable tools manually via settings

4. Architecture & Technology

The overlay is implemented as:

HTML + CSS + JavaScript

Vanilla JS only (no frameworks)

The Toolbox:

Lives in its own HTML / CSS / JS files

Is referenced from index.html

Must not bloat index.html

Each tool:

Lives in its own independent file

Can be added or removed without modifying other tools

Cannot communicate with other tools

5. Settings Integration

A new section called “Toolbox” will be added to the Overlay Settings page.

Toolbox Settings Panel

Contains:

A list of tools with checkboxes

Users can enable or disable tools at any time

Enabling/disabling tools dynamically updates the Toolbox layout

Tools that require their own configuration:

Will place their settings under the Toolbox section

Toolbox settings act as a parent container for tool-specific settings

6. State Management

No formal state management system is required at this time.

Configuration and enabled tools will be stored in AppData, consistent with how other overlay tools manage persistent settings.

7. First Tool: Clock
Clock Tool Specification

A simple digital 24-hour clock

Uses the user’s local system time

Displayed directly over the game

No advanced features or customization

Purpose:

Serve as a lightweight utility

Act as a proof-of-concept for the Toolbox system

8. Extensibility & Tool System

Tools are:

Modular

Independent

Loaded only when enabled

The Toolbox must:

Automatically scale when tools are added or removed

Require no changes to core files when new tools are introduced

9. Documentation Requirement (toolbox.md)

Create a file named toolbox.md that documents:

The overall Toolbox system

How to create a new tool

Required file structure for tools

How a tool is registered with the Toolbox

How tools can add settings to the Toolbox settings panel

A simple example tool (e.g., template or Clock reference)

The documentation should be written for future contributors adding new tools.

10. Functional Requirements Summary

Toolbox is visible whenever the Overlay is active and Toolbox is enabled

Toolbox ignores the “hide box” hotkey while active

Tools can be enabled or disabled via settings

Toolbox always uses full vertical space

Toolbox scales horizontally based on active tools

Toolbox and tools are modular and easy to extend

No tool-to-tool communication

Clean separation between index.html, Toolbox, and tools