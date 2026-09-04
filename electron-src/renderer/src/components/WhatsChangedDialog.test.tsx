// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DesktopUpdateChangelogSnapshot } from "../../../shared/changelog";
import { WhatsChangedDialog } from "./WhatsChangedDialog";

const changelog: DesktopUpdateChangelogSnapshot = {
  fromVersion: "2026.8.2",
  toVersion: "2026.9.0",
  status: "ready",
  source: "bundled",
  title: "What's Changed in 2026.9.0",
  markdown: "[Speech recognition demo](https://youtu.be/oqyFCUAVFag)",
  assetBaseUrl: "gsm-changelog://images/",
  error: null
};

describe("WhatsChangedDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("keeps the YouTube iframe mounted while install progress updates", async () => {
    await act(async () => {
      root.render(
        <WhatsChangedDialog
          changelog={changelog}
          installSession={null}
          backendStatus="pending"
          onContinue={() => {}}
          onRetry={() => {}}
          onOpenLogs={() => {}}
          onQuit={() => {}}
        />
      );
    });

    const initialIframe = container.querySelector("iframe");
    expect(initialIframe).not.toBeNull();

    await act(async () => {
      root.render(
        <WhatsChangedDialog
          changelog={changelog}
          installSession={null}
          backendStatus="running"
          onContinue={() => {}}
          onRetry={() => {}}
          onOpenLogs={() => {}}
          onQuit={() => {}}
        />
      );
    });

    expect(container.querySelector("iframe")).toBe(initialIframe);
  });
});
