// @vitest-environment jsdom
/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultHoshidictsFieldOverwriteModes,
  DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS,
  DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
  DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  HOSHIDICTS_CHANNELS,
  MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH,
  type HoshidictsActionResult,
  type HoshidictsDesktopSnapshot,
  type HoshidictsMiningOptions
} from "../../../../shared/features/hoshidicts";
import {
  activationKeyFromKeyboardCode,
  getReadiness,
  sortFrequencyDictionaryOrderForMode
} from "./hoshidictsSettingsModel";
import {
  createHoshidictsIpcMock,
  deferred,
  installFakeAudio,
  installFakeSpeechSynthesis,
  installHoshidictsTestEnvironment,
  makeHoshidictsCustomDocument,
  makeHoshidictsDictionary,
  makeHoshidictsFrequencyDictionary,
  makeHoshidictsMiningOptions,
  makeHoshidictsMiningProfile,
  makeHoshidictsReaderPreferences,
  makeHoshidictsSnapshot,
  renderHoshidictsSettings,
  setInputValue,
  setSelectValue,
  setTextareaValue,
  type HoshidictsIpcMock,
  type HoshidictsSettingsHarness
} from "./test_helpers";

const hoshidictsStyles = readFileSync(
  resolve(
    process.cwd(),
    "electron-src/renderer/src/features/hoshidicts/hoshidicts.css"
  ),
  "utf8"
);

const baseState = makeHoshidictsSnapshot();
const miningOptions = makeHoshidictsMiningOptions();
const customDocument = makeHoshidictsCustomDocument();

describe("HoshidictsSettingsWindow", () => {
  let ipc: HoshidictsIpcMock;
  let invokeMock: HoshidictsIpcMock["invoke"];
  let listeners: HoshidictsIpcMock["listeners"];
  let harness: HoshidictsSettingsHarness | null;
  let container: HTMLElement;
  let restoreEnvironment: () => void;

  beforeEach(() => {
    restoreEnvironment = installHoshidictsTestEnvironment();
    ipc = createHoshidictsIpcMock();
    invokeMock = ipc.invoke;
    listeners = ipc.listeners;
    harness = null;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await harness?.dispose();
    restoreEnvironment();
  });

  async function render(options: { locale?: string } = {}) {
    harness = await renderHoshidictsSettings(options);
    container = harness.container;
  }

  /** Runs an interaction, then lets its IPC round trip and effects settle. */
  async function settle(interaction: () => void = () => {}, flushes = 2) {
    await act(async () => {
      interaction();
      for (let index = 0; index < flushes; index += 1) {
        await Promise.resolve();
      }
    });
  }

  /** Runs an edit, then lets the autosave debounce fire and settle. */
  const flushAfter = (interaction: () => void = () => {}) =>
    act(async () => {
      interaction();
      await flushAutosave();
    });

  const clickAndSettle = (element: Element | null | undefined) =>
    settle(() => (element as HTMLElement | null)?.click());

  const submitForm = (element: Element | null | undefined) =>
    settle(() =>
      element
        ?.closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );

  const openView = (label: string) =>
    clickAndSettle(
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === label
      )
    );

  // Positional so localized runs do not depend on translated tab labels.
  const openTab = (position: string) =>
    clickAndSettle(
      container.querySelector(`.hoshidicts-window__tabs button${position}`)
    );
  const openDesign = () => openTab(":nth-child(2)");
  const openMining = () => openTab(":last-child");
  const openCustom = () => openView("Custom");

  async function flushAutosave() {
    await vi.advanceTimersByTimeAsync(450);
    await Promise.resolve();
    await Promise.resolve();
  }

  function callsFor(channel: string): unknown[][] {
    return invokeMock.mock.calls.filter(
      ([calledChannel]) => calledChannel === channel
    );
  }

  /** ES2020 lib has no Array.prototype.at, so index from the length. */
  const lastCallFor = (channel: string): unknown[] | undefined => {
    const calls = callsFor(channel);
    return calls[calls.length - 1];
  };

  it("shows the compact profile control and switches or clones profiles", async () => {
    const profileState: HoshidictsDesktopSnapshot = {
      ...baseState,
      profiles: [
        { id: "default", name: "Default" },
        { id: "persona", name: "Persona" }
      ]
    };
    ipc.configure({
      state: profileState,
      handlers: {
        [HOSHIDICTS_CHANNELS.switchProfile]: (request) => ({
          success: true,
          outcome: { code: "profileSwitched" },
          state: {
            ...profileState,
            revision: ipc.nextRevision(),
            activeProfileId: (request as { id: string }).id
          }
        })
      }
    });
    vi.spyOn(window, "prompt").mockReturnValue("Visual Novels");

    await render();
    const select = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-active-profile"
    );
    expect(Array.from(select?.options ?? []).map(({ text }) => text)).toEqual([
      "Default",
      "Persona"
    ]);

    await act(async () => {
      container
        .querySelector<HTMLInputElement>("#hoshidicts-reader-mode-hover")
        ?.click();
      setSelectValue(select, "persona");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const saveIndex = invokeMock.mock.calls.findIndex(
      ([channel]) => channel === HOSHIDICTS_CHANNELS.setReaderPreferences
    );
    const switchIndex = invokeMock.mock.calls.findIndex(
      ([channel]) => channel === HOSHIDICTS_CHANNELS.switchProfile
    );
    expect(saveIndex).toBeGreaterThan(-1);
    expect(switchIndex).toBeGreaterThan(saveIndex);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.switchProfile,
      { id: "persona" }
    );

    await clickAndSettle(
      container.querySelector<HTMLButtonElement>('button[aria-label="Create profile"]')
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.createProfile,
      { name: "Visual Novels" }
    );
  });

  it("shows dictionary import progress beside the dictionary import controls", async () => {
    ipc.configure({
      state: makeHoshidictsSnapshot({
        busy: true,
        progress: { phase: "importing", completed: 1, total: 3 }
      })
    });

    await render();

    const localProgress = container.querySelector(
      ".hoshidicts-dictionary-import-progress"
    );
    expect(localProgress?.textContent).toContain("Importing dictionaries...");
    expect(localProgress?.textContent).toContain("1 / 3");
  });

  it.each([
    ["KeyA", "A"],
    ["Digit1", "1"],
    ["Numpad7", "7"],
    ["ControlRight", "Ctrl"],
    ["NumpadEnter", "Return"],
    ["ArrowUp", "Up"],
    ["Semicolon", ";"],
    ["F24", "F24"],
    ["CapsLock", null],
    ["F25", null]
  ] as const)("maps physical key code %s to %s", (code, expected) => {
    expect(activationKeyFromKeyboardCode(code)).toBe(expected);
  });

  it.each([
    ["rank-based", "ascending"],
    ["occurrence-based", "descending"],
    [null, "descending"]
  ] as const)("derives %s frequency sorting as %s", (mode, expected) => {
    expect(sortFrequencyDictionaryOrderForMode(mode)).toBe(expected);
  });

  it("shows loading instead of flashing a false disabled state", async () => {
    const pendingState = deferred<HoshidictsDesktopSnapshot>();
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === HOSHIDICTS_CHANNELS.getState) {
        return await pendingState.promise;
      }
      return {};
    });

    await render();
    expect(container.textContent).toContain("Loading Hoshidicts settings");
    expect(container.textContent).not.toContain("Feature off");
    expect(container.textContent).not.toContain("No enabled dictionaries");

    await settle(() => pendingState.resolve(baseState));
    expect(container.textContent).toContain("2 installed · 1 enabled");
    expect(container.textContent).toContain("Ready");
  });

  it("derives every readiness state in priority order", () => {
    expect(getReadiness({ ...baseState, effectiveEnabled: false }).kind).toBe(
      "featureOff"
    );
    expect(
      getReadiness({
        ...baseState,
        overlay: { running: false, restartRequired: true }
      }).kind
    ).toBe("overlayStopped");
    expect(
      getReadiness({
        ...baseState,
        overlay: { running: true, restartRequired: true }
      }).kind
    ).toBe("restartRequired");
    expect(
      getReadiness({
        ...baseState,
        dictionaries: baseState.dictionaries.map((dictionary) => ({
          ...dictionary,
          enabled: false
        }))
      }).kind
    ).toBe("noEnabledDictionaries");
    expect(
      getReadiness({
        ...baseState,
        dictionaries: [
          {
            ...baseState.dictionaries[0],
            termCount: 0,
            frequencyCount: 500,
            kanjiCount: 0
          }
        ]
      }).kind
    ).toBe("noEnabledLookupDictionary");
    expect(
      getReadiness({
        ...baseState,
        dictionaries: [
          {
            ...baseState.dictionaries[0],
            termCount: 0,
            frequencyCount: 0,
            kanjiCount: 1
          }
        ]
      }).kind
    ).toBe("ready");
    expect(
      getReadiness({
        ...baseState,
        dictionaries: [],
        customDictionaryActive: true
      })
    ).toEqual({ kind: "ready", installed: 1, enabled: 1 });
    expect(getReadiness(baseState).kind).toBe("ready");
  });

  it("configures favourites only for term dictionaries", async () => {
    await render();

    const favorite = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add JMdict to favourites"]'
    );
    expect(favorite?.getAttribute("aria-pressed")).toBe("false");
    expect(
      container.querySelector('button[aria-label="Add Custom to favourites"]')
    ).toBeNull();

    expect(
      container.querySelectorAll(".hoshidicts-dictionary-favorite-placeholder")
    ).toHaveLength(1);
    expect(container.textContent).not.toContain("Always show");
    expect(container.textContent).not.toContain("Fallback");

    await clickAndSettle(favorite);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setDictionaryPresentation,
      {
        id: "jmdict-id",
        favorite: true
      }
    );
  });

  it("searches dictionary titles and aliases and bulk-selects only matching rows", async () => {
    ipc.configure({
      state: makeHoshidictsSnapshot({
        dictionaries: [
          makeHoshidictsDictionary({ displayName: "Primary Lexicon" }),
          makeHoshidictsFrequencyDictionary()
        ]
      })
    });
    await render();

    const search = container.querySelector<HTMLInputElement>(
      '[aria-label="Search installed dictionaries"]'
    );
    await settle(() => setInputValue(search, "jmdict"), 1);
    expect(
      container.querySelectorAll(".hoshidicts-dictionary-row")
    ).toHaveLength(1);
    expect(container.textContent).toContain("Primary Lexicon");

    await settle(() => setInputValue(search, "primary"), 1);
    expect(
      container.querySelectorAll(".hoshidicts-dictionary-row")
    ).toHaveLength(1);
    expect(container.textContent).toContain("Primary Lexicon");

    await settle(() => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Select all matches")
        ?.click();
    }, 1);
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Select Primary Lexicon"]'
      )?.checked
    ).toBe(true);

    await clickAndSettle(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "Disable")
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.bulkDictionaryAction,
      { action: "disable", ids: ["jmdict-id"] }
    );
  });

  it("shows ordered search positions before favourites and renumbers after reorder", async () => {
    const reorderedState: HoshidictsDesktopSnapshot = {
      ...baseState,
      revision: baseState.revision + 1,
      dictionaries: [baseState.dictionaries[1], baseState.dictionaries[0]]
    };
    ipc.configure({
      handlers: {
        [HOSHIDICTS_CHANNELS.moveDictionary]: () => ({
          success: true,
          outcome: { code: "dictionaryChanged" },
          state: reorderedState
        })
      }
    });

    await render();

    const rows = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(".hoshidicts-dictionary-row")
      );
    const position = (row: HTMLElement) =>
      row.querySelector<HTMLElement>(".hoshidicts-dictionary-search-position");
    expect(position(rows()[0])?.textContent).toBe("1");
    expect(position(rows()[0])?.getAttribute("aria-label")).toBe(
      "Search position 1 of 2 for JMdict"
    );
    expect(position(rows()[0])?.nextElementSibling).toBe(
      rows()[0].querySelector(".hoshidicts-dictionary-favorite")
    );
    expect(position(rows()[1])?.textContent).toBe("2");
    expect(position(rows()[1])?.nextElementSibling).toBe(
      rows()[1].querySelector(".hoshidicts-dictionary-favorite-placeholder")
    );

    await settle(() => {
      rows()[0]
        .querySelector<HTMLElement>(
          '[aria-label="Dictionary actions for JMdict"]'
        )
        ?.click();
    }, 1);
    const moveDown = Array.from(
      rows()[0].querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((button) => button.textContent?.trim() === "Move down");
    await clickAndSettle(moveDown);

    expect(invokeMock).toHaveBeenCalledWith(HOSHIDICTS_CHANNELS.moveDictionary, {
      id: "jmdict-id",
      direction: 1
    });
    expect(rows()[0].textContent).toContain("Custom");
    expect(position(rows()[0])?.getAttribute("aria-label")).toBe(
      "Search position 1 of 2 for Custom"
    );
    expect(rows()[1].textContent).toContain("JMdict");
    expect(position(rows()[1])?.getAttribute("aria-label")).toBe(
      "Search position 2 of 2 for JMdict"
    );
  });

  it.each([
    {
      name: "enables the first lookup-capable dictionary, including kanji",
      label: "Enable a Dictionary",
      dictionaries: [
        { ...baseState.dictionaries[1], enabled: true },
        {
          ...baseState.dictionaries[0],
          enabled: false,
          termCount: 0,
          kanjiCount: 1
        }
      ],
      invocation: [
        HOSHIDICTS_CHANNELS.setDictionaryEnabled,
        { id: "jmdict-id", enabled: true }
      ]
    },
    {
      name: "offers the default set when only frequency data is installed",
      label: "Install default set",
      dictionaries: [{ ...baseState.dictionaries[1], enabled: true }],
      invocation: [HOSHIDICTS_CHANNELS.installAllRecommended]
    }
  ])(
    "$name from the readiness action",
    async ({ dictionaries, label, invocation }) => {
      ipc.configure({ state: makeHoshidictsSnapshot({ dictionaries }) });

      await render();
      const action = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === label
      );
      expect(action).toBeDefined();

      await settle(() => action?.click(), 1);

      expect(invokeMock.mock.calls).toContainEqual(invocation);
    }
  );

  it("ignores progress snapshots older than the displayed revision", async () => {
    await render();
    const progressListener = listeners.get(HOSHIDICTS_CHANNELS.progress)?.[0];
    await settle(() => {
      progressListener?.({}, {
        ...baseState,
        revision: baseState.revision - 1,
        effectiveEnabled: false,
        dictionaries: []
      });
    }, 1);

    expect(container.textContent).toContain("2 installed · 1 enabled");
    expect(container.textContent).not.toContain("Feature off");
  });

  it("keeps dictionary actions independently wired", async () => {
    await render();
    const buttons = Array.from(container.querySelectorAll("button"));
    const buttonContaining = (text: string) =>
      buttons.find((button) => button.textContent?.includes(text));
    const schedule = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-update-schedule"
    );

    await settle(() => {
      buttonContaining("Import Dictionaries")?.click();
      buttonContaining("Check for Updates")?.click();
      buttons.find((button) => button.textContent?.trim() === "Install")?.click();
      setSelectValue(schedule, "monthly");
    });

    await settle(() => {
      container
        .querySelector<HTMLElement>(
          '[aria-label="Dictionary actions for JMdict"]'
        )
        ?.click();
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      )
        .find((button) => button.textContent?.trim() === "Remove")
        ?.click();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.importDictionary
    );
    expect(invokeMock).toHaveBeenCalledWith(HOSHIDICTS_CHANNELS.checkUpdates);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.installRecommended,
      { id: "jitendex" }
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.removeDictionary,
      "jmdict-id"
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setSchedule,
      "monthly"
    );
  });

  it("keeps Hoshidicts backup actions simple with local busy feedback", async () => {
    const exportJob = deferred<HoshidictsActionResult>();
    invokeMock.mockImplementation(
      async (channel: string): Promise<unknown> => {
        if (channel === HOSHIDICTS_CHANNELS.getState) return baseState;
        if (channel === HOSHIDICTS_CHANNELS.exportBackup) {
          return exportJob.promise;
        }
        if (channel === HOSHIDICTS_CHANNELS.restoreBackup) {
          return {
            success: true,
            outcome: { code: "backupRestored" },
            state: { ...baseState, revision: baseState.revision + 2 }
          } satisfies HoshidictsActionResult;
        }
        throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    );
    await render();

    const backups = container.querySelector<HTMLElement>(
      ".hoshidicts-backups"
    );
    const backupButtons = () =>
      Array.from(backups?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const backupButton = (label: string) =>
      backupButtons().find((button) => button.textContent?.trim() === label);

    expect(
      backupButtons().map((button) => button.textContent?.trim())
    ).toEqual(["Export Backup", "Restore Backup"]);

    await settle(() => backupButton("Export Backup")?.click(), 1);

    expect(
      backups?.querySelector<HTMLElement>(
        '.hoshidicts-backups__status[role="status"]'
      )?.textContent
    ).toBe("Exporting backup...");
    expect(backupButtons().every((button) => button.disabled)).toBe(true);

    await act(async () => {
      exportJob.resolve({
        success: true,
        outcome: { code: "backupExported" },
        state: { ...baseState, revision: baseState.revision + 1 }
      });
      await exportJob.promise;
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Hoshidicts backup exported.");
    await clickAndSettle(backupButton("Restore Backup"));
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.exportBackup
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.restoreBackup
    );
    expect(container.textContent).toContain("Hoshidicts backup restored.");
  });

  it("collapses recommended dictionaries when dictionaries are installed", async () => {
    await render();
    const recommendedList = container.querySelector<HTMLElement>(
      "#hoshidicts-recommended-list"
    );
    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand recommended dictionaries"]'
    );

    expect(recommendedList?.hidden).toBe(true);
    expect(expand?.getAttribute("aria-expanded")).toBe("false");
    expect(
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Install default set")
      )
    ).toBeTruthy();

    await settle(() => expand?.click(), 1);
    expect(recommendedList?.hidden).toBe(false);

    await settle(() => {
      ipc.emit(HOSHIDICTS_CHANNELS.progress, {
        ...baseState,
        revision: baseState.revision + 1
      });
    }, 1);
    expect(recommendedList?.hidden).toBe(false);
  });

  it("collapses recommended dictionaries when the custom dictionary is active", async () => {
    ipc.configure({ state: makeHoshidictsSnapshot({ dictionaries: [] }) });

    await render();
    let recommendedList = container.querySelector<HTMLElement>(
      "#hoshidicts-recommended-list"
    );
    expect(recommendedList?.hidden).toBe(false);
    expect(
      container
        .querySelector('[aria-label="Collapse recommended dictionaries"]')
        ?.getAttribute("aria-expanded")
    ).toBe("true");

    await harness?.dispose();
    ipc.configure({
      state: makeHoshidictsSnapshot({
        dictionaries: [],
        customDictionaryActive: true
      })
    });

    await render();
    recommendedList = container.querySelector<HTMLElement>(
      "#hoshidicts-recommended-list"
    );
    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand recommended dictionaries"]'
    );

    expect(recommendedList?.hidden).toBe(true);
    expect(expand?.getAttribute("aria-expanded")).toBe("false");

    await settle(() => expand?.click(), 1);
    expect(recommendedList?.hidden).toBe(false);
  });

  it("keeps tab groups collapsed by default and wires group management actions", async () => {
    const groupState: HoshidictsDesktopSnapshot = {
      ...baseState,
      tabGroups: [
        {
          id: "grammar",
          name: "Grammar",
          dictionaryIds: ["jmdict-id"]
        },
        { id: "games", name: "Games", dictionaryIds: [] }
      ]
    };
    ipc.configure({ state: groupState });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await render();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand tab groups (2)"]'
    );
    const panel = container.querySelector<HTMLElement>(
      "#hoshidicts-tab-groups-panel"
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.hidden).toBe(true);

    await settle(() => toggle?.click(), 1);
    expect(panel?.hidden).toBe(false);
    expect(panel?.textContent).toContain("Grammar");
    expect(panel?.textContent).toContain("Dictionaries: 1");

    const createName = panel?.querySelector<HTMLInputElement>(
      'input[aria-label="Tab group name"]'
    );
    setInputValue(createName ?? null, "Study");
    await submitForm(createName);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.createTabGroup,
      { name: "Study" }
    );

    await clickAndSettle(
      container.querySelector<HTMLButtonElement>('[aria-label="Move Grammar down"]')
    );
    expect(invokeMock).toHaveBeenCalledWith(HOSHIDICTS_CHANNELS.moveTabGroup, {
      groupId: "grammar",
      direction: 1
    });

    await settle(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Rename Grammar"]')
        ?.click();
    }, 1);
    const renameName = container.querySelector<HTMLInputElement>(
      'input[aria-label="New name for Grammar"]'
    );
    setInputValue(renameName, "Language");
    await submitForm(renameName);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.renameTabGroup,
      { groupId: "grammar", name: "Language" }
    );

    await clickAndSettle(
      container.querySelector<HTMLButtonElement>('[aria-label="Delete Games"]')
    );
    expect(confirm).toHaveBeenCalledWith(
      "Delete the Games tab group? Its dictionaries will not be deleted."
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.deleteTabGroup,
      { groupId: "games" }
    );
    confirm.mockRestore();
  });

  it("keeps a rejected tab group rename open with the entered name", async () => {
    const groupState: HoshidictsDesktopSnapshot = {
      ...baseState,
      tabGroups: [
        {
          id: "grammar",
          name: "Grammar",
          dictionaryIds: ["jmdict-id"]
        }
      ]
    };
    ipc.configure({
      state: groupState,
      handlers: {
        [HOSHIDICTS_CHANNELS.renameTabGroup]: () => ({
          success: false,
          error: "That tab group name is already in use.",
          state: groupState
        })
      }
    });

    await render();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Expand tab groups (1)"]'
        )
        ?.click();
      await Promise.resolve();
      container
        .querySelector<HTMLButtonElement>('[aria-label="Rename Grammar"]')
        ?.click();
      await Promise.resolve();
    });
    const renameName = container.querySelector<HTMLInputElement>(
      'input[aria-label="New name for Grammar"]'
    );
    setInputValue(renameName, "Games");
    await submitForm(renameName);

    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="New name for Grammar"]'
      )?.value
    ).toBe("Games");
    expect(container.textContent).toContain(
      "That tab group name is already in use."
    );
  });

  it("assigns only term dictionaries to one or more tab groups from the action menu", async () => {
    const groupState: HoshidictsDesktopSnapshot = {
      ...baseState,
      tabGroups: [
        {
          id: "grammar",
          name: "Grammar",
          dictionaryIds: ["jmdict-id"]
        },
        { id: "games", name: "Games", dictionaryIds: [] }
      ]
    };
    ipc.configure({ state: groupState });

    await render();
    const summary = container.querySelector<HTMLElement>(
      '[aria-label="Dictionary actions for JMdict"]'
    );
    await settle(() => summary?.click(), 1);
    const menu = summary?.closest<HTMLDetailsElement>("details");
    expect(menu?.open).toBe(true);

    await settle(() => {
      container.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
      );
    }, 1);
    expect(menu?.open).toBe(false);

    await settle(() => summary?.click(), 1);
    let addToGroup = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((button) => button.textContent?.includes("Add to Tab Group"));
    await settle(() => addToGroup?.click(), 1);

    const initialGrammar = container.querySelector<HTMLInputElement>(
      'input[aria-label="Remove JMdict from Grammar"]'
    );
    expect(document.activeElement).toBe(initialGrammar);
    const picker = container.querySelector<HTMLElement>(
      '.hoshidicts-dictionary-tab-groups[role="group"]'
    );
    const pickerHeading = document.getElementById(
      picker?.getAttribute("aria-labelledby") ?? ""
    );
    expect(pickerHeading?.textContent).toBe("Add to tab group");
    expect(
      Array.from(picker?.querySelectorAll<HTMLButtonElement>("button") ?? [])
        .some((button) => button.textContent?.trim() === "Back")
    ).toBe(false);

    await settle(() => {
      container.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
      );
    }, 1);
    expect(menu?.open).toBe(false);
    expect(
      container.querySelector(".hoshidicts-dictionary-tab-groups")
    ).toBeNull();

    await settle(() => summary?.click(), 1);
    addToGroup = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((button) => button.textContent?.includes("Add to Tab Group"));
    await settle(() => addToGroup?.click(), 1);
    const grammar = container.querySelector<HTMLInputElement>(
      'input[aria-label="Remove JMdict from Grammar"]'
    );
    let games = container.querySelector<HTMLInputElement>(
      'input[aria-label="Add JMdict to Games"]'
    );
    expect(grammar?.checked).toBe(true);
    expect(games?.checked).toBe(false);

    await settle(() => {
      ipc.emit(HOSHIDICTS_CHANNELS.progress, {
        ...groupState,
        revision: ipc.nextRevision(),
        busy: true,
        progress: { phase: "saving", scope: "dictionary" }
      });
    }, 1);
    games = container.querySelector<HTMLInputElement>(
      'input[aria-label="Add JMdict to Games"]'
    );
    expect(games?.disabled).toBe(true);
    expect(games?.closest("label")?.classList.contains("is-disabled")).toBe(
      true
    );

    await settle(() => {
      ipc.emit(HOSHIDICTS_CHANNELS.progress, {
        ...groupState,
        revision: ipc.nextRevision(),
        busy: false,
        progress: { phase: "idle", scope: "dictionary" }
      });
    }, 1);
    games = container.querySelector<HTMLInputElement>(
      'input[aria-label="Add JMdict to Games"]'
    );
    await clickAndSettle(games);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setTabGroupMembership,
      { groupId: "games", dictionaryId: "jmdict-id", member: true }
    );

    const newGroupName = container.querySelector<HTMLInputElement>(
      'input[aria-label="New tab group name"]'
    );
    setInputValue(newGroupName, "Vocabulary");
    await submitForm(newGroupName);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.createTabGroup,
      { name: "Vocabulary", dictionaryId: "jmdict-id" }
    );

    await act(async () => {
      summary?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      summary?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container.querySelector(".hoshidicts-dictionary-tab-groups")
    ).toBeNull();

    const frequencyRow = Array.from(
      container.querySelectorAll<HTMLElement>(".hoshidicts-dictionary-row")
    ).find((row) => row.textContent?.includes("Custom"));
    await settle(() => {
      frequencyRow?.querySelector<HTMLElement>("summary")?.click();
    }, 1);
    expect(
      frequencyRow?.querySelector(".hoshidicts-dictionary-menu__items")
        ?.textContent
    ).not.toContain("Add to Tab Group");
  });

  it("moves a dictionary directly to a selected search position", async () => {
    await render();
    const menu = container.querySelector<HTMLElement>(
      '[aria-label="Dictionary actions for JMdict"]'
    );

    await settle(() => menu?.click(), 1);
    const moveToPosition = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Move dict to position")
    );
    await settle(() => moveToPosition?.click(), 1);

    const position = container.querySelector<HTMLInputElement>(
      '.hoshidicts-dictionary-position input[type="number"]'
    );
    setInputValue(position, "2");
    await submitForm(position);

    expect(invokeMock).toHaveBeenCalledWith(
      "hoshidicts.moveDictionaryToPosition",
      { id: "jmdict-id", position: 2 }
    );
  });

  it("configures an updatable dictionary schedule from its action menu", async () => {
    await render();

    const globalSchedule = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-update-schedule"
    );
    expect(
      Array.from(globalSchedule?.options ?? []).map((option) => option.text)
    ).toContain("Every hour");

    const openScheduleEditor = async () => {
      await settle(() => {
        container
          .querySelector<HTMLElement>(
            '[aria-label="Dictionary actions for JMdict"]'
          )
          ?.click();
      }, 1);
      const updateSchedule = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      ).find((button) => button.textContent?.includes("Update schedule"));
      await settle(() => updateSchedule?.click(), 1);
      return container.querySelector<HTMLFormElement>(
        ".hoshidicts-dictionary-schedule"
      );
    };

    let form = await openScheduleEditor();
    expect(form?.getAttribute("aria-label")).toBe(
      "Update schedule for JMdict"
    );
    let select = form?.querySelector<HTMLSelectElement>("select") ?? null;
    expect(select?.value).toBe("global");
    expect(Array.from(select?.options ?? []).map((option) => option.text)).toEqual(
      ["Use global (Weekly)", "Off", "Every hour", "Daily", "Weekly", "Monthly"]
    );
    expect(
      Array.from(form?.querySelectorAll("button") ?? []).map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(["Save", "Cancel"]);
    await submitForm(form);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setDictionarySchedule,
      { id: "jmdict-id", schedule: null }
    );

    form = await openScheduleEditor();
    select = form?.querySelector<HTMLSelectElement>("select") ?? null;
    setSelectValue(select, "hourly");
    await submitForm(form);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setDictionarySchedule,
      { id: "jmdict-id", schedule: "hourly" }
    );

    const scheduleCalls = () =>
      invokeMock.mock.calls.filter(
        ([channel]) => channel === HOSHIDICTS_CHANNELS.setDictionarySchedule
      );
    expect(scheduleCalls()).toHaveLength(2);
    form = await openScheduleEditor();
    const cancel = Array.from(form?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "Cancel"
    );
    await settle(() => cancel?.click(), 1);
    expect(
      container.querySelector(".hoshidicts-dictionary-schedule")
    ).toBeNull();
    expect(scheduleCalls()).toHaveLength(2);

    const manualRow = Array.from(
      container.querySelectorAll<HTMLElement>(".hoshidicts-dictionary-row")
    ).find((row) => row.textContent?.includes("Custom"));
    await settle(() => {
      manualRow?.querySelector<HTMLElement>("summary")?.click();
    }, 1);
    expect(manualRow?.textContent).not.toContain("Update schedule");
  });

  it("shows a dictionary alias and saves a renamed display name", async () => {
    await render();
    await settle(() => {
      ipc.emit(HOSHIDICTS_CHANNELS.progress, {
        ...baseState,
        revision: baseState.revision + 1,
        dictionaries: [
          {
            ...baseState.dictionaries[0],
            displayName: "Core Japanese"
          },
          baseState.dictionaries[1]
        ]
      });
    }, 1);

    expect(container.textContent).toContain("Core Japanese");
    expect(container.textContent).toContain("Original name: JMdict");
    expect(
      container.querySelector('strong[title="Original name: JMdict"]')
        ?.textContent
    ).toBe("Core Japanese");

    const menu = container.querySelector<HTMLElement>(
      '[aria-label="Dictionary actions for Core Japanese"]'
    );
    await settle(() => menu?.click(), 1);
    const rename = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Rename dictionary")
    );
    await settle(() => rename?.click(), 1);

    const input = container.querySelector<HTMLInputElement>(
      '.hoshidicts-dictionary-rename input[type="text"]'
    );
    const renameForm = input?.closest("form");
    expect(input?.value).toBe("Core Japanese");
    expect(input?.getAttribute("aria-describedby")).toBe(
      "hoshidicts-dictionary-rename-original-jmdict-id"
    );
    expect(renameForm?.getAttribute("aria-label")).toBe(
      "Rename Core Japanese"
    );
    expect(
      Array.from(renameForm?.querySelectorAll("button") ?? []).map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(["Save", "Cancel", "Reset original name"]);
    setInputValue(input, "Friendly Lexicon");
    await submitForm(input);

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.renameDictionary,
      { id: "jmdict-id", displayName: "Friendly Lexicon" }
    );
  });

  it("resets a dictionary alias to its original name", async () => {
    await render();
    await settle(() => {
      ipc.emit(HOSHIDICTS_CHANNELS.progress, {
        ...baseState,
        revision: baseState.revision + 1,
        dictionaries: [
          {
            ...baseState.dictionaries[0],
            displayName: "Core Japanese"
          },
          baseState.dictionaries[1]
        ]
      });
    }, 1);

    const menu = container.querySelector<HTMLElement>(
      '[aria-label="Dictionary actions for Core Japanese"]'
    );
    await settle(() => menu?.click(), 1);
    const rename = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Rename dictionary")
    );
    await settle(() => rename?.click(), 1);
    const reset = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Reset original name")
    );
    await clickAndSettle(reset);

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.renameDictionary,
      { id: "jmdict-id", displayName: null }
    );
  });

  it("auto-saves reader preferences atomically", async () => {
    vi.useFakeTimers();
    await render();
    const hover = container.querySelector<HTMLInputElement>(
      "#hoshidicts-reader-mode-hover"
    );
    const delay = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-hide-delay"
    );
    const maxDepth = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-nesting-max-depth"
    );
    const onlyScanJapaneseText = container.querySelector<HTMLInputElement>(
      "#hoshidicts-only-scan-japanese-text"
    );

    expect(onlyScanJapaneseText?.checked).toBe(true);
    expect(container.textContent).toContain(
      "Only scan words written entirely in Japanese"
    );

    await settle(() => {
      hover?.click();
      setInputValue(delay, "850");
      setInputValue(maxDepth, "12");
      onlyScanJapaneseText?.click();
    }, 1);
    await openDesign();

    const showLookupCounts = container.querySelector<HTMLInputElement>(
      "#hoshidicts-show-lookup-counts"
    );
    const showCompactDefinitionSummary =
      container.querySelector<HTMLInputElement>(
        "#hoshidicts-show-compact-definition-summary"
      );
    const compactDefinitionSummaryDictionary =
      container.querySelector<HTMLSelectElement>(
        "#hoshidicts-compact-definition-summary-dictionary"
      );
    const compactDefinitionSummaryCount =
      container.querySelector<HTMLInputElement>(
        "#hoshidicts-compact-definition-summary-count"
      );
    const kanjiClickDictionary = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-kanji-click-dictionary"
    );
    const showPitchAccentFurigana =
      container.querySelector<HTMLInputElement>(
        "#hoshidicts-show-pitch-accent-furigana"
      );
    const pitchAccentFuriganaDictionary =
      container.querySelector<HTMLSelectElement>(
        "#hoshidicts-pitch-accent-furigana-dictionary"
      );
    const showPitchAccentBadge = container.querySelector<HTMLInputElement>(
      "#hoshidicts-show-pitch-accent-badge"
    );
    const averageFrequency = container.querySelector<HTMLInputElement>(
      "#hoshidicts-average-frequency"
    );
    const showFrequencyDictionaryNames =
      container.querySelector<HTMLInputElement>(
        "#hoshidicts-show-frequency-dictionary-names"
      );
    const hidePopupGrammarTags = container.querySelector<HTMLInputElement>(
      "#hoshidicts-hide-popup-grammar-tags"
    );

    expect(showLookupCounts?.checked).toBe(true);
    expect(showCompactDefinitionSummary?.checked).toBe(false);
    expect(compactDefinitionSummaryCount?.value).toBe("3");
    expect(compactDefinitionSummaryCount?.disabled).toBe(true);
    expect(compactDefinitionSummaryDictionary?.disabled).toBe(true);
    expect(showPitchAccentFurigana?.checked).toBe(true);
    expect(pitchAccentFuriganaDictionary?.disabled).toBe(false);
    expect(showPitchAccentBadge?.checked).toBe(false);
    expect(averageFrequency?.checked).toBe(false);
    expect(showFrequencyDictionaryNames?.checked).toBe(true);
    expect(hidePopupGrammarTags?.checked).toBe(true);
    expect(
      Array.from(compactDefinitionSummaryDictionary?.options ?? []).map(
        (option) => [option.value, option.textContent]
      )
    ).toEqual([
      ["", "Automatic"],
      ["JMdict", "JMdict"]
    ]);
    expect(
      Array.from(pitchAccentFuriganaDictionary?.options ?? []).map(
        (option) => [option.value, option.textContent]
      )
    ).toEqual([
      ["", "Automatic (first enabled pitch dictionary)"],
      ["JMdict", "JMdict"]
    ]);
    expect(
      Array.from(kanjiClickDictionary?.options ?? []).map(
        (option) => [option.value, option.textContent]
      )
    ).toEqual([
      ["", "Automatic (KANJIDIC when installed)"],
      ["JMdict", "JMdict"],
      ["Custom", "Custom"]
    ]);
    expect(container.textContent).toContain("Show seen and lookup counts");
    expect(container.textContent).toContain(
      "Show a compact definition near the word"
    );
    expect(container.textContent).toContain(
      "Pitch shown in furigana"
    );
    expect(container.textContent).toContain("Show pitch accent badge");
    expect(container.textContent).toContain("Average frequencies");
    expect(container.textContent).toContain("Show frequency dictionary names");
    expect(container.textContent).toContain(
      "Hide grammar tags in popup metadata"
    );

    await flushAfter(() => {
      showLookupCounts?.click();
      showCompactDefinitionSummary?.click();
      setInputValue(compactDefinitionSummaryCount, "5");
      setSelectValue(compactDefinitionSummaryDictionary, "JMdict");
      setSelectValue(kanjiClickDictionary, "Custom");
      setSelectValue(pitchAccentFuriganaDictionary, "JMdict");
      showPitchAccentFurigana?.click();
      showPitchAccentBadge?.click();
      averageFrequency?.click();
      showFrequencyDictionaryNames?.click();
      hidePopupGrammarTags?.click();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      makeHoshidictsReaderPreferences({
        lookupMode: "hover",
        onlyScanJapaneseText: false,
        popupHideDelayMs: 850,
        showLookupCounts: false,
        averageFrequency: true,
        showFrequencyDictionaryNames: false,
        showCompactDefinitionSummary: true,
        compactDefinitionSummaryCount: 5,
        compactDefinitionSummaryDictionary: "JMdict",
        kanjiClickDictionary: "Custom",
        showPitchAccentFurigana: false,
        pitchAccentFuriganaDictionary: "JMdict",
        showPitchAccentBadge: true,
        hidePopupGrammarTags: false,
        popupNestingMaxDepth: 12
      })
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setLookupMode,
      expect.anything()
    );
    expect(container.textContent).toContain("Saved");
  });

  it("keeps an unavailable preferred definition dictionary visible", async () => {
    ipc.configure({
      state: makeHoshidictsSnapshot({
        showCompactDefinitionSummary: true,
        compactDefinitionSummaryDictionary: "Removed Mono Dictionary"
      })
    });

    await render();
    await openDesign();

    const dictionary = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-compact-definition-summary-dictionary"
    );
    expect(dictionary?.value).toBe("Removed Mono Dictionary");
    expect(dictionary?.disabled).toBe(false);
    expect(
      Array.from(dictionary?.options ?? []).map((option) => option.textContent)
    ).toEqual([
      "Automatic",
      "Removed Mono Dictionary (not installed)",
      "JMdict"
    ]);
  });

  it("chooses the popup image source from image dictionaries and their tab groups", async () => {
    vi.useFakeTimers();
    const imageState: HoshidictsDesktopSnapshot = {
      ...baseState,
      dictionaries: [
        makeHoshidictsDictionary({
          id: "images-id",
          title: "Pixel Terms",
          termCount: 50,
          mediaCount: 12
        }),
        makeHoshidictsDictionary({
          id: "jmdict-id",
          title: "JMdict",
          termCount: 123,
          mediaCount: 0
        }),
        makeHoshidictsDictionary({
          id: "disabled-images-id",
          title: "Disabled Pics",
          enabled: false,
          termCount: 10,
          mediaCount: 7
        }),
        makeHoshidictsFrequencyDictionary()
      ],
      tabGroups: [
        {
          id: "art",
          name: "Art",
          dictionaryIds: ["jmdict-id", "images-id"]
        },
        { id: "text-only", name: "Text only", dictionaryIds: ["jmdict-id"] }
      ]
    };
    ipc.configure({ state: imageState });

    await render();
    await openDesign();

    const source = () =>
      container.querySelector<HTMLSelectElement>(
        "#hoshidicts-popup-image-source"
      );
    expect(source()?.value).toBe("");
    expect(
      Array.from(source()?.options ?? [], (option) => [
        option.value,
        option.textContent
      ])
    ).toEqual([
      ["", "Automatic (every dictionary)"],
      ["dictionary:Pixel Terms", "Pixel Terms"],
      ["tabGroup:art", "Art"]
    ]);

    await flushAfter(() => setSelectValue(source(), "dictionary:Pixel Terms"));
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupImageSource: { kind: "dictionary", title: "Pixel Terms" }
      })
    );

    await flushAfter(() => setSelectValue(source(), "tabGroup:art"));
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupImageSource: { kind: "tabGroup", id: "art" }
      })
    );

    await flushAfter(() => setSelectValue(source(), ""));
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({ popupImageSource: null })
    );

    await harness?.dispose();
    ipc.configure({
      state: makeHoshidictsSnapshot({
        dictionaries: [
          makeHoshidictsDictionary({ mediaCount: 0 }),
          makeHoshidictsFrequencyDictionary()
        ],
        tabGroups: [],
        popupImageSource: null
      })
    });
    await render();
    await openDesign();
    expect(source()?.disabled).toBe(true);
    expect(
      Array.from(source()?.options ?? [], (option) => option.textContent)
    ).toEqual(["Automatic (every dictionary)"]);
  });

  it.each([
    [
      "dictionary",
      { kind: "dictionary", title: "Removed Images" } as const,
      "dictionary:Removed Images",
      "Removed Images (not installed)"
    ],
    [
      "tab group",
      { kind: "tabGroup", id: "gone" } as const,
      "tabGroup:gone",
      "Removed tab group"
    ]
  ])(
    "keeps an unavailable popup image %s selectable",
    async (_label, popupImageSource, expectedValue, unavailableLabel) => {
      ipc.configure({
        state: makeHoshidictsSnapshot({
          dictionaries: [
            makeHoshidictsDictionary({
              id: "images-id",
              title: "Pixel Terms",
              termCount: 50,
              mediaCount: 12
            })
          ],
          tabGroups: [],
          popupImageSource
        })
      });

      await render();
      await openDesign();

      const source = container.querySelector<HTMLSelectElement>(
        "#hoshidicts-popup-image-source"
      );
      expect(source?.value).toBe(expectedValue);
      expect(source?.disabled).toBe(false);
      expect(
        Array.from(source?.options ?? [], (option) => option.textContent)
      ).toEqual([
        "Automatic (every dictionary)",
        unavailableLabel,
        "Pixel Terms"
      ]);
    }
  );

  it.each([
    {
      name: "the lookup scan length",
      id: "hoshidicts-scan-length",
      initial: "16",
      bounds: ["1", "64"],
      typed: "0",
      clamped: "1",
      saved: { scanLength: 1 }
    },
    {
      name: "the lookup result limit",
      id: "hoshidicts-max-results",
      initial: "32",
      bounds: ["1", "256"],
      typed: "999",
      clamped: "256",
      saved: { maxResults: 256 }
    },
    {
      name: "the definition blur threshold",
      design: true,
      id: "hoshidicts-definition-blur-threshold",
      initial: "5",
      bounds: ["1", "1000000"],
      typed: "0",
      clamped: "1",
      saved: {
        definitionBlur: {
          ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
          lookupThreshold: 1
        }
      }
    },
    {
      name: "the definition blur reveal delay",
      design: true,
      id: "hoshidicts-definition-blur-reveal-delay",
      initial: "5",
      bounds: ["1", "3600"],
      typed: "7200",
      clamped: "3600",
      saved: {
        definitionBlur: {
          ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
          revealDelayMs: 3_600_000
        }
      }
    }
  ])(
    "clamps $name to its supported bounds",
    async ({ design, id, initial, bounds, typed, clamped, saved }) => {
      vi.useFakeTimers();
      await render();
      if (design) await openDesign();
      const input = () =>
        container.querySelector<HTMLInputElement>(`#${id}`);

      expect(input()?.value).toBe(initial);
      expect([input()?.min, input()?.max]).toEqual(bounds);

      await flushAfter(() => setInputValue(input(), typed));

      expect(input()?.value).toBe(clamped);
      expect(invokeMock).toHaveBeenLastCalledWith(
        HOSHIDICTS_CHANNELS.setReaderPreferences,
        expect.objectContaining(saved)
      );
    }
  );

  it("matches Yomitan frequency sorting controls and automatic order", async () => {
    vi.useFakeTimers();
    await render();
    const dictionary = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-sort-frequency-dictionary"
    );

    expect(dictionary?.value).toBe("");
    expect(
      container.querySelector(
        "#hoshidicts-sort-frequency-dictionary-order-container"
      )
    ).toBeNull();

    await settle(() => setSelectValue(dictionary, "JMdict"), 1);
    let order = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-sort-frequency-dictionary-order"
    );
    expect(order?.value).toBe("descending");

    await act(flushAutosave);
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        sortFrequencyDictionary: "JMdict",
        sortFrequencyDictionaryOrder: "descending"
      })
    );

    await flushAfter(() => setSelectValue(order, "ascending"));
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({ sortFrequencyDictionaryOrder: "ascending" })
    );

    await flushAfter(() =>
      container
        .querySelector<HTMLButtonElement>(
          "#hoshidicts-sort-frequency-dictionary-order-auto"
        )
        ?.click()
    );
    order = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-sort-frequency-dictionary-order"
    );
    expect(order?.value).toBe("descending");

    await settle(() => setSelectValue(dictionary, ""), 1);
    expect(
      container.querySelector(
        "#hoshidicts-sort-frequency-dictionary-order-container"
      )
    ).toBeNull();
  });

  it("shows the live popup preview with fit and actual-size modes", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    await render();
    await openDesign();

    const frame = container.querySelector<HTMLIFrameElement>(
      'iframe[src="./hoshidicts-preview/index.html"]'
    );
    const viewport = container.querySelector<HTMLElement>(
      ".hoshidicts-popup-preview__viewport"
    );
    const canvas = container.querySelector<HTMLElement>(
      ".hoshidicts-popup-preview__canvas"
    );
    const stage = container.querySelector<HTMLElement>(
      ".hoshidicts-popup-preview__stage"
    );
    const status = container.querySelector<HTMLElement>(
      ".hoshidicts-popup-preview__status"
    );
    const scaleToFit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Scale to fit"
    );
    const actualSize = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Actual size"
    );

    expect(frame?.title).toBe("HoshiDict popup preview");
    expect(scaleToFit?.getAttribute("aria-pressed")).toBe("true");
    expect(actualSize?.getAttribute("aria-pressed")).toBe("false");
    expect(viewport?.dataset.scaleToFit).toBe("true");
    expect(Number.parseFloat(canvas?.style.width ?? "0")).toBeLessThan(656);
    expect(Number.parseFloat(canvas?.style.height ?? "0")).toBeLessThan(532);
    expect(stage?.style.width).toBe("656px");
    expect(stage?.style.height).toBe("532px");
    expect(stage?.style.transform).not.toBe("scale(1)");
    const initialStatus = status?.textContent;

    await settle(() => actualSize?.click(), 1);

    expect(scaleToFit?.getAttribute("aria-pressed")).toBe("false");
    expect(actualSize?.getAttribute("aria-pressed")).toBe("true");
    expect(viewport?.dataset.scaleToFit).toBe("false");
    expect(canvas?.style.width).toBe("656px");
    expect(canvas?.style.height).toBe("532px");
    expect(stage?.style.transform).toBe("scale(1)");

    await settle(() => scaleToFit?.click(), 1);

    expect(viewport?.dataset.scaleToFit).toBe("true");
    expect(container.querySelector("iframe")).toBe(frame);
    expect(status?.textContent).toBe(initialStatus);
  });

  it("live previews, auto-saves, and resets custom popup CSS", async () => {
    vi.useFakeTimers();
    await render();
    await openDesign();

    const editor = container.querySelector<HTMLTextAreaElement>(
      "#hoshidicts-custom-popup-css"
    );
    const reset = container.querySelector<HTMLButtonElement>(
      "#hoshidicts-custom-popup-css-reset"
    );
    const frame = container.querySelector<HTMLIFrameElement>(
      'iframe[src="./hoshidicts-preview/index.html"]'
    );
    const postMessage = vi.spyOn(frame!.contentWindow!, "postMessage");
    const customPopupCss = `:scope {
  border-radius: 18px;
}

.gsm-hoshidicts-expression {
  color: hotpink;
}`;

    expect(editor?.value).toBe(DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS);
    expect(editor?.maxLength).toBe(MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH);
    expect(editor?.getAttribute("aria-describedby")).toBe(
      "hoshidicts-custom-popup-css-count hoshidicts-custom-popup-css-scope-hint"
    );
    expect(editor?.placeholder).toContain("--hoshidicts-popup-background");
    expect(reset?.disabled).toBe(true);
    expect(hoshidictsStyles).toMatch(
      /\.hoshidicts-window \.hoshidicts-custom-css textarea/
    );

    postMessage.mockClear();
    await settle(() => setTextareaValue(editor, customPopupCss), 1);

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "gsm.hoshidicts.preview.v1",
        type: "preferences",
        preferences: expect.objectContaining({ customPopupCss })
      }),
      expect.any(String)
    );
    expect(reset?.disabled).toBe(false);

    await act(flushAutosave);
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({ customPopupCss })
    );

    postMessage.mockClear();
    await settle(() => reset?.click(), 1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "gsm.hoshidicts.preview.v1",
        type: "preferences",
        preferences: expect.objectContaining({
          customPopupCss: DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS
        })
      }),
      expect.any(String)
    );

    await act(flushAutosave);
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        customPopupCss: DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS
      })
    );
  });

  it("sends per-dictionary term and kanji counts and the clicked-kanji selection to the live Design preview", async () => {
    ipc.configure({
      state: makeHoshidictsSnapshot({
        dictionaries: [
          makeHoshidictsDictionary({
            id: "jpdb-kanji-terms",
            title: "JPDB Kanji Terms",
            termCount: 20409,
            kanjiCount: 0,
            frequencyCount: 0,
            pitchCount: 0
          }),
          makeHoshidictsDictionary({
            id: "kanjidic",
            title: "KANJIDIC (English)",
            termCount: 0,
            kanjiCount: 13108,
            frequencyCount: 0,
            pitchCount: 0
          })
        ]
      })
    });

    vi.useFakeTimers();
    await render({ locale: "ja" });
    await openDesign();

    const frame = container.querySelector<HTMLIFrameElement>(
      'iframe[src="./hoshidicts-preview/index.html"]'
    );
    const postMessage = vi.spyOn(frame!.contentWindow!, "postMessage");

    const kanjiClickDictionary = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-kanji-click-dictionary"
    );
    postMessage.mockClear();
    await settle(
      () => setSelectValue(kanjiClickDictionary, "JPDB Kanji Terms"),
      1
    );

    // The real Design preview receives the same capability metadata the overlay
    // uses to route a clicked kanji, keyed by the explicit selection.
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "gsm.hoshidicts.preview.v1",
        type: "preferences",
        locale: "ja",
        preferences: expect.objectContaining({
          kanjiClickDictionary: "JPDB Kanji Terms",
          dictionaryPresentation: [
            expect.objectContaining({
              title: "JPDB Kanji Terms",
              termCount: 20409,
              kanjiCount: 0
            }),
            expect.objectContaining({
              title: "KANJIDIC (English)",
              termCount: 0,
              kanjiCount: 13108
            })
          ]
        })
      }),
      expect.any(String)
    );
  });


  it("defaults the popup toolbar to auto and saves fixed positions", async () => {
    vi.useFakeTimers();
    await render();
    await openDesign();
    const toolbarPosition = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-popup-toolbar-position"
    );

    expect(toolbarPosition?.value).toBe("auto");

    await flushAfter(() => setSelectValue(toolbarPosition, "bottom"));

    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({ popupToolbarPosition: "bottom" })
    );
  });

  it("controls the popup buttons and custom links", async () => {
    vi.useFakeTimers();
    await render();
    await openDesign();

    const addToAnki = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-button-add-to-anki"
    );
    const audio = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-button-audio"
    );
    const customDefinition = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-button-custom-definition"
    );
    const viewInAnki = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-button-view-in-anki"
    );

    expect(addToAnki?.checked).toBe(true);
    expect(audio?.checked).toBe(true);
    expect(customDefinition?.checked).toBe(true);
    expect(viewInAnki?.checked).toBe(false);

    await flushAfter(() => {
      audio?.click();
      viewInAnki?.click();
      setInputValue(
        container.querySelector("#hoshidicts-popup-link-label"),
        "Jisho"
      );
      setInputValue(
        container.querySelector("#hoshidicts-popup-link-url"),
        "https://jisho.org/search/%w?sentence=%s"
      );
      container
        .querySelector<HTMLButtonElement>("#hoshidicts-popup-link-submit")
        ?.click();
    });

    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupButtons: {
          addToAnki: true,
          audio: false,
          customDefinition: true,
          viewInAnki: true,
          customLinks: [
            {
              label: "Jisho",
              url: "https://jisho.org/search/%w?sentence=%s"
            }
          ]
        }
      })
    );
    expect(container.textContent).toContain("Jisho");

    await settle(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Edit custom popup link Jisho"]'
        )
        ?.click();
    }, 1);
    expect(
      container.querySelector<HTMLInputElement>("#hoshidicts-popup-link-label")
        ?.value
    ).toBe("Jisho");

    await flushAfter(() => {
      setInputValue(
        container.querySelector("#hoshidicts-popup-link-url"),
        "https://jisho.org/search/%s"
      );
      container
        .querySelector<HTMLButtonElement>("#hoshidicts-popup-link-submit")
        ?.click();
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupButtons: expect.objectContaining({
          customLinks: [
            { label: "Jisho", url: "https://jisho.org/search/%s" }
          ]
        })
      })
    );

    await flushAfter(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Delete custom popup link Jisho"]'
        )
        ?.click()
    );
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupButtons: expect.objectContaining({ customLinks: [] })
      })
    );
  });

  it("auto-saves popup appearance and keeps columns on size reset", async () => {
    vi.useFakeTimers();
    await render();
    await openDesign();
    const theme = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-popup-theme"
    );
    const opacity = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-opacity"
    );
    expect(
      container.querySelector("#hoshidicts-popup-backdrop-blur")
    ).toBeNull();
    expect(container.textContent).not.toContain("Backdrop blur");
    const width = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-width"
    );
    const height = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-height"
    );
    const columns = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-columns"
    );
    const reset = container.querySelector<HTMLButtonElement>(
      ".hoshidicts-reader-appearance__reset"
    );

    expect(theme?.value).toBe("default");
    expect(opacity?.value).toBe("85");
    expect(width?.value).toBe("560");
    expect(height?.value).toBe("420");
    expect(columns?.value).toBe("1");
    expect(reset?.disabled).toBe(true);

    await flushAfter(() => {
      setSelectValue(theme, "girlypop");
      setInputValue(opacity, "70");
      setInputValue(width, "720");
      setInputValue(height, "520");
      setInputValue(columns, "3");
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupWidthPx: 720,
        popupHeightPx: 520,
        popupColumns: 3,
        theme: "girlypop",
        popupOpacityPercent: 70
      })
    );
    expect(reset?.disabled).toBe(false);

    await flushAfter(() => reset?.click());
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
        popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
        popupColumns: 3,
        theme: "girlypop",
        popupOpacityPercent: 70
      })
    );
  });

  it("keeps source highlighting off by default and auto-saves when enabled", async () => {
    vi.useFakeTimers();
    await render();
    await openDesign();
    const sourceHighlight = container.querySelector<HTMLInputElement>(
      "#hoshidicts-source-highlight-enabled"
    );

    expect(sourceHighlight?.checked).toBe(false);
    expect(container.textContent).toContain("Highlight looked-up word");

    await act(async () => {
      sourceHighlight?.click();
      await vi.advanceTimersByTimeAsync(450);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sourceHighlight?.checked).toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      makeHoshidictsReaderPreferences({
        sourceHighlightEnabled: true
      })
    );
  });

  it("auto-saves definition blur preferences as one nested setting", async () => {
    vi.useFakeTimers();
    await render();
    await openDesign();

    const enabled = container.querySelector<HTMLInputElement>(
      "#hoshidicts-definition-blur-enabled"
    );
    const threshold = container.querySelector<HTMLInputElement>(
      "#hoshidicts-definition-blur-threshold"
    );
    const revealMode = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-definition-blur-reveal-mode"
    );

    expect(
      container.querySelector<HTMLInputElement>(
        "#hoshidicts-definition-blur-reveal-delay"
      )?.value
    ).toBe("5");

    await flushAfter(() => {
      enabled?.click();
      setInputValue(threshold, "12");
      setSelectValue(revealMode, "hover");
    });

    expect(
      container.querySelector("#hoshidicts-definition-blur-reveal-delay")
    ).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      makeHoshidictsReaderPreferences({
        definitionBlur: { enabled: true, lookupThreshold: 12, revealMode: "hover", revealDelayMs: 5000 }
      })
    );
  });

  it("restores and updates the preserved reveal duration in timed mode", async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementationOnce(async () => ({
      ...baseState,
      definitionBlur: {
        enabled: true,
        lookupThreshold: 7,
        revealMode: "hover",
        revealDelayMs: 9000
      }
    }));
    await render();
    await openDesign();

    expect(
      container.querySelector("#hoshidicts-definition-blur-reveal-delay")
    ).toBeNull();
    await settle(() => {
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          "#hoshidicts-definition-blur-reveal-mode"
        ),
        "timed"
      );
    }, 1);
    const revealDelay = container.querySelector<HTMLInputElement>(
      "#hoshidicts-definition-blur-reveal-delay"
    );
    expect(revealDelay?.value).toBe("9");

    await flushAfter(() => setInputValue(revealDelay, "8"));

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        definitionBlur: {
          enabled: true,
          lookupThreshold: 7,
          revealMode: "timed",
          revealDelayMs: 8000
        }
      })
    );
  });

  it("toggles popup-content scanning and restores one child level", async () => {
    vi.useFakeTimers();
    await render();

    const toggle = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-content-scanning"
    );
    const initialDepth = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-nesting-max-depth"
    );
    expect(toggle?.checked).toBe(true);
    expect(initialDepth?.value).toBe("10");

    await flushAfter(() => toggle?.click());

    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      makeHoshidictsReaderPreferences({
        popupNestingMaxDepth: 0
      })
    );
    expect(
      container.querySelector("#hoshidicts-popup-nesting-max-depth")
    ).toBeNull();

    await flushAfter(() =>
      container
        .querySelector<HTMLInputElement>("#hoshidicts-popup-content-scanning")
        ?.click()
    );

    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      makeHoshidictsReaderPreferences({
        popupNestingMaxDepth: 1
      })
    );
    expect(
      container.querySelector<HTMLInputElement>(
        "#hoshidicts-popup-nesting-max-depth"
      )?.value
    ).toBe("1");
  });

  it("captures a single physical key and can reset it to Shift", async () => {
    vi.useFakeTimers();
    await render();
    const capture = container.querySelector<HTMLButtonElement>(
      "#hoshidicts-activation-key-capture"
    );

    await settle(() => capture?.click(), 1);
    await settle(() => {
      capture?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "CapsLock",
          key: "CapsLock"
        })
      );
    }, 1);
    expect(container.textContent).toContain("That key cannot be used");

    const shiftedDigit = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Digit1",
      key: "!",
      shiftKey: true
    });
    await settle(() => capture?.dispatchEvent(shiftedDigit), 1);
    expect(shiftedDigit.defaultPrevented).toBe(true);
    expect(container.textContent).toContain("Hold 1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      makeHoshidictsReaderPreferences({
        activationKey: "1"
      })
    );

    const reset = container.querySelector<HTMLButtonElement>(
      "#hoshidicts-activation-key-reset"
    );
    await settle(() => reset?.click(), 1);
    expect(container.textContent).toContain("Hold Shift");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      makeHoshidictsReaderPreferences()
    );
  });

  it("loads the custom source lazily and saves the explicit draft", async () => {
    await render();
    expect(invokeMock).not.toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getCustomDictionary
    );

    await openCustom();
    const editor = container.querySelector<HTMLTextAreaElement>(
      "#hoshidicts-custom-dictionary-editor"
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getCustomDictionary
    );
    expect(editor?.value).toBe(customDocument.text);
    expect(container.textContent).toContain(customDocument.filePath);

    const draft = [
      customDocument.text.trimEnd(),
      "bad line",
      "千鳥, ちどり, Lightning thrust, with chakra"
    ].join("\n");
    await settle(() => setTextareaValue(editor, draft), 1);
    expect(container.textContent).toContain("2 valid entries");
    expect(container.textContent).toContain(
      "Malformed lines will be preserved but skipped (1 total; first lines: 2)."
    );
    expect(container.textContent).toContain("Unsaved changes");
    expect(invokeMock).not.toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.saveCustomDictionary,
      expect.anything()
    );

    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Save Dictionary")
    );
    await clickAndSettle(save);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.saveCustomDictionary,
      { text: draft, expectedRevision: customDocument.revision }
    );
    expect(container.textContent).toContain("Custom dictionary saved.");
    expect(container.textContent).toContain("Saved");
  });

  it("preserves the custom draft when saving fails", async () => {
    const originalImplementation = invokeMock.getMockImplementation();
    const reloadedDocument = {
      ...customDocument,
      text: `${customDocument.text}千鳥, ちどり, External definition\n`,
      revision: "external-revision"
    };
    let customReadCount = 0;
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === HOSHIDICTS_CHANNELS.getCustomDictionary) {
          customReadCount += 1;
          return customReadCount === 1 ? customDocument : reloadedDocument;
        }
        if (channel === HOSHIDICTS_CHANNELS.saveCustomDictionary) {
          return {
            success: false,
            error: "The custom dictionary changed after it was opened.",
            state: { ...baseState, revision: ipc.nextRevision() }
          };
        }
        return await originalImplementation?.(channel, ...args);
      }
    );
    await render();
    await openCustom();
    const editor = container.querySelector<HTMLTextAreaElement>(
      "#hoshidicts-custom-dictionary-editor"
    );
    const draft = `${customDocument.text}影分身の術, かげぶんしんのじゅつ, Creates solid shadow clones\n`;
    await settle(() => {
      setTextareaValue(editor, draft);
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Save Dictionary"))
        ?.click();
    });

    expect(editor?.value).toBe(draft);
    expect(container.textContent).toContain(
      "The custom dictionary changed after it was opened."
    );
    expect(container.textContent).toContain("Save failed");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await clickAndSettle(
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Reload from File"))
    );
    expect(confirm).toHaveBeenCalledWith(
      "Reloading will discard your unsaved custom dictionary changes. Continue?"
    );
    expect(
      container.querySelector<HTMLTextAreaElement>(
        "#hoshidicts-custom-dictionary-editor"
      )?.value
    ).toBe(reloadedDocument.text);
    expect(
      invokeMock.mock.calls.filter(
        ([channel]) => channel === HOSHIDICTS_CHANNELS.getCustomDictionary
      )
    ).toHaveLength(2);
    confirm.mockRestore();
  });

  it("loads every Anki field on entry without dirtying automatic mappings", async () => {
    vi.useFakeTimers();
    await render();
    await openView("Anki Mining");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getMiningOptions,
      undefined
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setMiningProfile,
      expect.anything()
    );
    const values = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        ".hoshidicts-mining-field-value"
      )
    ).map((input) => [input.dataset.ankiField, input.value]);
    expect(values).toEqual([
      ["Expression", "{expression}"],
      ["ExpressionReading", "{reading}"],
      ["Glossary", "{definition}"],
      ["Sentence", "{sentence}"],
      ["Frequency", "{frequency}"],
      ["PitchPosition", "{pitch-position}"],
      ["WordAudio", "{audio}"],
      ["Front", ""]
    ]);
    expect(container.textContent).toContain("7 of 8 fields mapped");
    expect(container.textContent).toContain(
      "All fields from the selected Anki note type are shown"
    );
  });

  it("falls back to persisted target fields offline and preserves explicit blanks", async () => {
    const offlineState: HoshidictsDesktopSnapshot = {
      ...baseState,
      miningProfile: {
        ...baseState.miningProfile,
        model: "Offline",
        fieldTemplates: {
          Front: { value: "", overwriteMode: "coalesce" },
          Note: { value: "x", overwriteMode: "append" }
        }
      }
    };
    ipc.configure({
      state: offlineState,
      miningOptions: makeHoshidictsMiningOptions({
        connected: false,
        selectedNoteType: "Offline",
        fields: [],
        suggestedFieldTemplates: {},
        resolvedFieldTemplates: {},
        error: "Anki is offline."
      })
    });

    await render();
    await openMining();

    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>(
          ".hoshidicts-mining-field-value"
        )
      ).map((input) => [input.dataset.ankiField, input.value])
    ).toEqual([
      ["Front", ""],
      ["Note", "x"]
    ]);
    expect(container.textContent).toContain("1 of 2 fields mapped");
    expect(callsFor(HOSHIDICTS_CHANNELS.setMiningProfile)).toHaveLength(0);
  });

  it("shows normalized legacy target fields while Anki is offline", async () => {
    const offlineState: HoshidictsDesktopSnapshot = {
      ...baseState,
      miningProfile: {
        ...baseState.miningProfile,
        model: "Offline legacy",
        fields: {
          ...baseState.miningProfile.fields,
          expression: "Front",
          reading: "Reading",
          definition: "Front",
          sentence: "Context"
        },
        disabledFields: ["reading"],
        fieldOverwriteModes: {
          ...baseState.miningProfile.fieldOverwriteModes,
          expression: "append",
          definition: "overwrite"
        },
        fieldTemplates: null
      }
    };
    ipc.configure({
      state: offlineState,
      miningOptions: makeHoshidictsMiningOptions({
        connected: false,
        selectedNoteType: "Offline legacy",
        fields: [],
        suggestedFieldTemplates: {},
        resolvedFieldTemplates: {},
        error: "Anki is offline."
      })
    });

    await render();
    await openMining();

    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>(
          ".hoshidicts-mining-field-value"
        )
      ).map((input) => [input.dataset.ankiField, input.value])
    ).toEqual([
      ["Front", "{expression}<br>{definition}"],
      ["Context", "{sentence}"]
    ]);
    expect(
      container.querySelector<HTMLSelectElement>(
        '[data-anki-field="Front"][data-field-control="overwrite"]'
      )?.value
    ).toBeUndefined();
    expect(container.textContent).toContain("2 of 2 fields mapped");
  });

  it("preserves a saved mapping when Anki changes only the field casing", async () => {
    vi.useFakeTimers();
    const caseChangedState: HoshidictsDesktopSnapshot = {
      ...baseState,
      miningProfile: {
        ...baseState.miningProfile,
        model: "Case changed",
        fieldTemplates: {
          front: { value: "x", overwriteMode: "append" }
        }
      }
    };
    ipc.configure({
      state: caseChangedState,
      miningOptions: makeHoshidictsMiningOptions({
        selectedNoteType: "Case changed",
        fields: ["Front", "Back"],
        suggestedFieldTemplates: { Front: "", Back: "" },
        resolvedFieldTemplates: {
          Front: { value: "x", overwriteMode: "append" },
          Back: { value: "", overwriteMode: "coalesce" }
        }
      })
    });

    await render();
    await openMining();
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-anki-field="Front"][data-field-control="value"]'
      )?.value
    ).toBe("x");
    expect(
      container.querySelector(".hoshidicts-mining-fields__warning")
    ).toBeNull();

    await flushAfter(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Back"][data-field-control="value"]'
        ),
        "y"
      );
    });

    expect(
      lastCallFor(HOSHIDICTS_CHANNELS.setMiningProfile)?.[1]
    ).toMatchObject({
      fieldTemplates: {
        Front: { value: "x", overwriteMode: "append" },
        Back: { value: "y", overwriteMode: "coalesce" }
      }
    });
  });

  it("links the exact yomitan-audio-fast setup guidance near the top of Audio", async () => {
    await render();
    await openView("Audio");

    const audioPanel = container.querySelector<HTMLElement>(".hoshidicts-audio");
    const guidance = Array.from(audioPanel?.querySelectorAll("a") ?? []).find(
      (link) =>
        link.textContent ===
        "If you want non-TTS audio, you can try setting up yomitan-fast-audio"
    );

    expect(guidance).toBeDefined();
    expect(guidance?.getAttribute("href")).toBe(
      "https://github.com/bee-san/yomitan-audio-fast"
    );
    expect(guidance?.closest("section")).toBe(
      audioPanel?.querySelector("section")
    );
  });

  it("shows only generic audio sources without enable or volume controls", async () => {
    await render();
    await openView("Audio");

    const audioPanel = container.querySelector<HTMLElement>(".hoshidicts-audio");
    expect.soft(audioPanel?.querySelector("#hoshidicts-audio-enabled")).toBeNull();
    expect.soft(audioPanel?.querySelector("#hoshidicts-audio-volume")).toBeNull();
    expect.soft(audioPanel?.textContent).not.toMatch(
      /JapanesePod101|LanguagePod101|Jisho/u
    );

    let sourceSelect = audioPanel?.querySelector<HTMLSelectElement>(
      ".hoshidicts-audio-source select"
    );
    if (!sourceSelect) {
      await clickAndSettle(
        audioPanel?.querySelector("#hoshidicts-audio-add-source")
      );
      sourceSelect = audioPanel?.querySelector<HTMLSelectElement>(
        ".hoshidicts-audio-source select"
      );
    }
    if (!sourceSelect) {
      throw new Error("Expected an audio source type selector.");
    }
    expect(Array.from(sourceSelect.options, (option) => option.value)).toEqual([
      "custom",
      "custom-json",
      "text-to-speech",
      "text-to-speech-reading"
    ]);
  });

  it("edits and auto-saves ordered pronunciation audio sources", async () => {
    vi.useFakeTimers();
    ipc.configure({
      state: makeHoshidictsSnapshot({
        audioProfile: {
          version: 1,
          autoPlay: false,
          sources: [
            {
              id: "direct-audio",
              type: "custom",
              url: "https://first.test/{term}.mp3",
              voice: ""
            },
            {
              id: "audio-list",
              type: "custom-json",
              url: "https://second.test/list?term={term}",
              voice: ""
            }
          ]
        }
      })
    });
    await render();
    await openView("Audio");

    await flushAfter(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Move Custom JSON up"]'
        )
        ?.click();
      container
        .querySelector<HTMLButtonElement>("#hoshidicts-audio-add-source")
        ?.click();
      const rows = container.querySelectorAll<HTMLElement>(
        ".hoshidicts-audio-source"
      );
      const customRow = rows[rows.length - 1];
      setSelectValue(
        customRow?.querySelector<HTMLSelectElement>("select"),
        "custom-json"
      );
      setInputValue(
        customRow?.querySelector<HTMLInputElement>('input[type="text"]'),
        "http://127.0.0.1:9000/audio"
      );
      const autoplay = container.querySelector<HTMLInputElement>(
        "#hoshidicts-audio-autoplay"
      );
      autoplay?.click();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setAudioProfile,
      expect.objectContaining({
        autoPlay: true,
        sources: expect.arrayContaining([
          expect.objectContaining({
            type: "custom-json",
            url: "http://127.0.0.1:9000/audio"
          })
        ])
      })
    );
    const savedProfile = invokeMock.mock.calls.find(
      ([channel]) => channel === HOSHIDICTS_CHANNELS.setAudioProfile
    )?.[1] as typeof baseState.audioProfile;
    expect(savedProfile.sources[0].id).toBe("audio-list");
    expect(container.textContent).toContain("Saved");
  });

  it("tests every downloadable audio row with the current draft and plays the returned bytes", async () => {
    const { instances, createObjectUrl, revokeObjectUrl } =
      installFakeAudio("blob:hoshidicts-kiku");
    const audioState: HoshidictsDesktopSnapshot = {
      ...baseState,
      audioProfile: {
        version: 1,
        autoPlay: false,
        sources: [
          {
            id: "direct-audio",
            type: "custom",
            url: "https://audio.test/{term}.mp3",
            voice: ""
          },
          {
            id: "audio-list",
            type: "custom-json",
            url: "https://audio.test/list?term={term}",
            voice: ""
          }
        ]
      }
    };

    const pendingTest = deferred<unknown>();
    ipc.configure({
      state: audioState,
      handlers: {
        [HOSHIDICTS_CHANNELS.testAudioSource]: () => pendingTest.promise
      }
    });

    await render();
    await openView("Audio");

    const testButtons = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "[data-audio-test-source]"
        )
      );
    expect(testButtons()).toHaveLength(audioState.audioProfile.sources.length);

    const firstButton = container.querySelector<HTMLButtonElement>(
      '[data-audio-test-source="direct-audio"]'
    );
    await settle(() => firstButton?.click(), 1);

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.testAudioSource,
      {
        profile: audioState.audioProfile,
        sourceId: "direct-audio"
      }
    );
    expect(container.textContent).toContain("Testing 聞く（きく）");
    expect(testButtons().every((button) => button.disabled)).toBe(true);

    await settle(() => {
      pendingTest.resolve({
        success: true,
        audio: {
          bytes: Uint8Array.from([0x49, 0x44, 0x33]),
          contentType: "audio/mpeg",
          candidateName: "Kiku recording"
        },
        state: audioState
      });
    });

    expect(createObjectUrl).toHaveBeenCalledOnce();
    const blob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/mpeg");
    expect(blob.size).toBe(3);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.src).toBe("blob:hoshidicts-kiku");
    expect(instances[0]?.volume).toBe(1);
    expect(instances[0]?.play).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Playing Kiku recording");

    await settle(() => {
      instances[0]?.onended?.(new Event("ended"));
    }, 1);

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:hoshidicts-kiku");
    expect(container.textContent).toContain("Played Kiku recording");
    expect(testButtons().every((button) => !button.disabled)).toBe(true);

    await clickAndSettle(
      container.querySelector<HTMLButtonElement>('[data-audio-test-source="audio-list"]')
    );
    expect(instances).toHaveLength(2);

    await harness?.unmount();
    expect(instances[1]?.pause).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
  });

  it("uses the same per-row test control to speak expression and reading TTS", async () => {
    const { spoken, cancel } = installFakeSpeechSynthesis();

    const ttsState: HoshidictsDesktopSnapshot = {
      ...baseState,
      audioProfile: {
        ...baseState.audioProfile,
        sources: [
          {
            id: "expression-tts",
            type: "text-to-speech",
            url: "",
            voice: ""
          },
          {
            id: "reading-tts",
            type: "text-to-speech-reading",
            url: "",
            voice: ""
          }
        ]
      }
    };
    ipc.configure({ state: ttsState });

    await render();
    await openView("Audio");

    await settle(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-audio-test-source="expression-tts"]'
        )
        ?.click();
    }, 1);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({
      text: "聞く",
      lang: "ja-JP"
    });
    expect(container.textContent).toContain("Playing 聞く");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-audio-test-source="reading-tts"]'
      )?.disabled
    ).toBe(true);

    await settle(() => spoken[0]?.onend?.(new Event("end")), 1);
    expect(container.textContent).toContain("Played 聞く");

    await settle(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-audio-test-source="reading-tts"]'
        )
        ?.click();
    }, 1);
    expect(spoken).toHaveLength(2);
    expect(spoken[1]?.text).toBe("きく");
    expect(cancel).toHaveBeenCalled();
    expect(
      callsFor(HOSHIDICTS_CHANNELS.testAudioSource)
    ).toHaveLength(0);
  });

  it("shows a per-row error and re-enables source tests after a failed probe", async () => {
    const audioState: HoshidictsDesktopSnapshot = {
      ...baseState,
      audioProfile: {
        version: 1,
        autoPlay: false,
        sources: [
          {
            id: "direct-audio",
            type: "custom",
            url: "https://audio.test/{term}.mp3",
            voice: ""
          }
        ]
      }
    };
    ipc.configure({
      state: audioState,
      handlers: {
        [HOSHIDICTS_CHANNELS.testAudioSource]: () => ({
          success: false,
          error: "The recording service is unavailable.",
          state: audioState
        })
      }
    });

    await render();
    await openView("Audio");
    await clickAndSettle(
      container.querySelector<HTMLButtonElement>('[data-audio-test-source="direct-audio"]')
    );

    const error = container.querySelector<HTMLElement>(
      '.hoshidicts-audio-source__test-status[data-phase="error"]'
    );
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toBe(
      "Test failed: The recording service is unavailable."
    );
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "[data-audio-test-source]"
        )
      ).every((button) => !button.disabled)
    ).toBe(true);
  });

  it("locks the full audio profile and times out stalled media and TTS tests", async () => {
    vi.useFakeTimers();
    const { instances, revokeObjectUrl } = installFakeAudio("blob:stalled-kiku");
    const { spoken, cancel } = installFakeSpeechSynthesis();

    const timeoutState: HoshidictsDesktopSnapshot = {
      ...baseState,
      audioProfile: {
        ...baseState.audioProfile,
        sources: [
          {
            id: "custom-test",
            type: "custom",
            url: "https://example.test/{term}/{reading}.mp3",
            voice: ""
          },
          {
            id: "expression-tts",
            type: "text-to-speech",
            url: "",
            voice: ""
          }
        ]
      }
    };
    ipc.configure({
      state: timeoutState,
      handlers: {
        [HOSHIDICTS_CHANNELS.testAudioSource]: () => ({
          success: true,
          audio: {
            bytes: Uint8Array.from([1, 2, 3]),
            contentType: "audio/mpeg",
            candidateName: "Stalled recording"
          },
          state: timeoutState
        })
      }
    });

    await render();
    await openView("Audio");
    const customTest = container.querySelector<HTMLButtonElement>(
      '[data-audio-test-source="custom-test"]'
    );
    const customRow = customTest?.closest<HTMLElement>(
      ".hoshidicts-audio-source"
    );
    await clickAndSettle(customTest);

    const profileControls = Array.from(
      container.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      >(
        ".hoshidicts-audio input, .hoshidicts-audio select, " +
          ".hoshidicts-actions button, .hoshidicts-audio-source__order button, " +
          ".hoshidicts-audio-source__actions button"
      )
    );
    expect(profileControls.length).toBeGreaterThan(10);
    expect(profileControls.every((control) => control.disabled)).toBe(true);
    expect(customRow?.textContent).toContain("Playing Stalled recording");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(instances[0]?.pause).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:stalled-kiku");
    expect(
      customRow?.querySelector<HTMLElement>(
        '.hoshidicts-audio-source__test-status[data-phase="error"]'
      )?.textContent
    ).toBe("Test failed: Audio source test timed out.");
    expect(
      container.querySelector<HTMLInputElement>("#hoshidicts-audio-autoplay")
        ?.disabled
    ).toBe(false);
    expect(
      customRow?.querySelector<HTMLInputElement>('input[type="text"]')
        ?.disabled
    ).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>(
        "#hoshidicts-audio-add-source"
      )?.disabled
    ).toBe(false);

    const ttsTest = container.querySelector<HTMLButtonElement>(
      '[data-audio-test-source="expression-tts"]'
    );
    await settle(() => ttsTest?.click(), 1);
    expect(spoken).toHaveLength(1);
    expect(
      container.querySelector<HTMLInputElement>("#hoshidicts-audio-autoplay")
        ?.disabled
    ).toBe(true);
    const cancelsBeforeTimeout = cancel.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(cancel.mock.calls.length).toBeGreaterThan(cancelsBeforeTimeout);
    expect(
      ttsTest
        ?.closest(".hoshidicts-audio-source")
        ?.querySelector<HTMLElement>(
          '.hoshidicts-audio-source__test-status[data-phase="error"]'
        )?.textContent
    ).toBe("Test failed: Audio source test timed out.");
    expect(ttsTest?.disabled).toBe(false);
    expect(
      container.querySelector<HTMLInputElement>("#hoshidicts-audio-autoplay")
        ?.disabled
    ).toBe(false);
  });

  it("blocks a failed audio version until the next edit", async () => {
    vi.useFakeTimers();
    let rejectNextAudioSave = true;
    ipc.configure({
      handlers: {
        [HOSHIDICTS_CHANNELS.setAudioProfile]: () => {
          if (!rejectNextAudioSave) return undefined;
          rejectNextAudioSave = false;
          return {
            success: false,
            error: "Audio profile was rejected.",
            state: { ...baseState, revision: ipc.nextRevision() }
          };
        }
      }
    });
    await render();
    await openView("Audio");

    await flushAfter(() =>
      container
        .querySelector<HTMLInputElement>("#hoshidicts-audio-autoplay")
        ?.click()
    );
    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)).toHaveLength(1);
    expect(container.textContent).toContain("Save failed");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)).toHaveLength(1);

    await flushAfter(() =>
      container
        .querySelector<HTMLButtonElement>("#hoshidicts-audio-add-source")
        ?.click()
    );
    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)).toHaveLength(2);
    expect(container.textContent).toContain("Saved");
  });

  it("queues edits made while an audio save is in flight", async () => {
    vi.useFakeTimers();
    const pendingSave = deferred<HoshidictsActionResult>();
    let firstAudioSave = true;
    ipc.configure({
      state: makeHoshidictsSnapshot({
        audioProfile: {
          version: 1,
          autoPlay: false,
          sources: [
            {
              id: "direct-audio",
              type: "custom",
              url: "https://audio.test/{term}.mp3",
              voice: ""
            }
          ]
        }
      })
    });
    ipc.configure({
      handlers: {
        [HOSHIDICTS_CHANNELS.setAudioProfile]: () => {
          if (!firstAudioSave) return undefined;
          firstAudioSave = false;
          return pendingSave.promise;
        }
      }
    });
    await render();
    await openView("Audio");

    await flushAfter(() =>
      container
        .querySelector<HTMLInputElement>("#hoshidicts-audio-autoplay")
        ?.click()
    );
    const firstRequest = callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)[0]?.[1] as
      | typeof baseState.audioProfile
      | undefined;
    expect(firstRequest?.autoPlay).toBe(true);

    await settle(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '.hoshidicts-audio-source input[type="text"]'
        ),
        "https://queued.test/{term}.mp3"
      );
    }, 1);
    await settle(() => {
      pendingSave.resolve({
        success: true,
        state: {
          ...baseState,
          revision: ipc.nextRevision(),
          audioProfile: firstRequest ?? baseState.audioProfile
        }
      });
    }, 1);
    await act(flushAutosave);

    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)).toHaveLength(2);
    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)[1]?.[1]).toMatchObject({
      autoPlay: true,
      sources: [
        expect.objectContaining({
          type: "custom",
          url: "https://queued.test/{term}.mp3"
        })
      ]
    });
  });

  it("does not overwrite a dirty audio draft with progress snapshots", async () => {
    vi.useFakeTimers();
    await render();
    await openView("Audio");

    await settle(() => {
      container
        .querySelector<HTMLButtonElement>("#hoshidicts-audio-add-source")
        ?.click();
      ipc.emit(HOSHIDICTS_CHANNELS.progress, {
        ...baseState,
        revision: ipc.nextRevision(),
        audioProfile: baseState.audioProfile
      });
    }, 1);
    expect(container.querySelectorAll(".hoshidicts-audio-source")).toHaveLength(1);

    await act(flushAutosave);
    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)[0]?.[1]).toMatchObject({
      sources: [expect.objectContaining({ type: "custom" })]
    });
  });

  it("renders every Anki field with accessible editable marker inputs", async () => {
    await render();
    await openMining();

    const grid = container.querySelector(".hoshidicts-mining-field-grid");
    expect(grid).not.toBeNull();

    const rows = Array.from(
      grid?.querySelectorAll<HTMLElement>(".hoshidicts-mining-field-row") ?? []
    );
    const labels = rows.map((row) => row.querySelector("label"));
    const inputs = rows.map((row) =>
      row.querySelector<HTMLInputElement>(".hoshidicts-mining-field-value")
    );
    expect(inputs).toHaveLength(8);
    expect(labels.map((label) => label?.htmlFor)).toEqual(
      inputs.map((input) => input?.id)
    );
    expect(
      inputs.every(
        (input) =>
          input?.getAttribute("list") === "hoshidicts-mining-field-values"
      )
    ).toBe(true);
  });

  it("auto-saves duplicate scope, note-type checks, behavior, and field overwrite modes", async () => {
    vi.useFakeTimers();
    await render();
    await openMining();

    const checkAllNoteTypes = container.querySelector<HTMLInputElement>(
      "#hoshidicts-mining-check-all-note-types"
    );
    await settle(() => {
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          "#hoshidicts-mining-duplicate-scope"
        ),
        "deck-root"
      );
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          "#hoshidicts-mining-duplicate-behavior"
        ),
        "overwrite"
      );
      checkAllNoteTypes?.click();
    }, 1);

    expect(
      Array.from(
        container.querySelectorAll(".hoshidicts-mining-field-grid__header")
      ).map((header) => header.textContent)
    ).toEqual(["Field", "Value", "On overwrite"]);
    expect(
      container.querySelectorAll('[id^="hoshidicts-mining-overwrite-"]')
    ).toHaveLength(8);

    await flushAfter(() => {
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          '[data-anki-field="Expression"][data-field-control="overwrite"]'
        ),
        "overwrite"
      );
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setMiningProfile,
      expect.objectContaining({
        checkForDuplicates: true,
        duplicateScope: "deck-root",
        duplicateScopeCheckAllModels: true,
        duplicateBehavior: "overwrite",
        fieldTemplates: expect.objectContaining({
          Expression: {
            value: "{expression}",
            overwriteMode: "overwrite"
          },
          Front: { value: "", overwriteMode: "coalesce" }
        })
      })
    );
  });

  it.each([
    {
      name: "every duplicate scope while a mining deck is configured",
      deck: "Default",
      expected: ["collection", "deck", "deck-root"]
    },
    {
      name: "only collection scope when no mining deck is configured",
      deck: "",
      expected: ["collection"]
    }
  ])("offers $name", async ({ deck, expected }) => {
    ipc.configure({
      state: {
        ...baseState,
        miningProfile: makeHoshidictsMiningProfile({ deck })
      }
    });

    await render();
    await openMining();

    const scope = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-mining-duplicate-scope"
    );
    expect(
      Array.from(scope?.options ?? []).map((option) => option.value)
    ).toEqual(expected);
  });

  it("coerces duplicate scope to collection when the deck is cleared", async () => {
    vi.useFakeTimers();
    ipc.configure({
      state: {
        ...baseState,
        miningProfile: makeHoshidictsMiningProfile({
          deck: "Mining",
          duplicateScope: "deck-root"
        })
      },
      miningOptions: makeHoshidictsMiningOptions({ connected: false })
    });

    await render();
    await openMining();

    await flushAfter(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>("#hoshidicts-mining-deck"),
        ""
      );
    });

    expect(
      lastCallFor(HOSHIDICTS_CHANNELS.setMiningProfile)?.[1]
    ).toMatchObject({
      deck: "",
      duplicateScope: "collection"
    });
  });

  it("auto-saves marker choices, blanks, and arbitrary literal values", async () => {
    vi.useFakeTimers();
    await render();
    await openView("Anki Mining");

    await flushAfter(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Front"][data-field-control="value"]'
        ),
        "x"
      );
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Glossary"][data-field-control="value"]'
        ),
        "{sentence}"
      );
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="WordAudio"][data-field-control="value"]'
        ),
        ""
      );
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setMiningProfile,
      expect.objectContaining({
        fieldTemplates: {
          Expression: { value: "{expression}", overwriteMode: "coalesce" },
          ExpressionReading: {
            value: "{reading}",
            overwriteMode: "coalesce"
          },
          Glossary: { value: "{sentence}", overwriteMode: "coalesce" },
          Sentence: { value: "{sentence}", overwriteMode: "coalesce" },
          Frequency: { value: "{frequency}", overwriteMode: "coalesce" },
          PitchPosition: {
            value: "{pitch-position}",
            overwriteMode: "coalesce"
          },
          WordAudio: { value: "", overwriteMode: "coalesce" },
          Front: { value: "x", overwriteMode: "coalesce" }
        }
      })
    );
    expect(container.querySelector("button")?.textContent).not.toBe(
      "Save Mining Profile"
    );
  });

  it("resets mappings for a new note type and ignores stale discovery", async () => {
    const lapisRequest = deferred<HoshidictsMiningOptions>();
    const kikuRequest = deferred<HoshidictsMiningOptions>();
    ipc.configure({
      handlers: {
        [HOSHIDICTS_CHANNELS.getMiningOptions]: (model) => {
          if (model === "Lapis") return lapisRequest.promise;
          if (model === "Kiku") return kikuRequest.promise;
          return undefined;
        }
      }
    });

    await render();
    await openView("Anki Mining");
    await settle(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Front"][data-field-control="value"]'
        ),
        "x"
      );
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        "Lapis"
      );
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        "Kiku"
      );
      kikuRequest.resolve(miningOptions);
    });
    await settle(() => {
      lapisRequest.resolve({
        ...miningOptions,
        selectedNoteType: "Lapis",
        fields: ["Expression", "MainDefinition"],
        suggestedFields: {
          ...miningOptions.suggestedFields,
          definition: "MainDefinition"
        },
        resolvedFields: {
          ...miningOptions.resolvedFields,
          definition: "MainDefinition"
        },
        suggestedFieldTemplates: {
          Expression: "{expression}",
          MainDefinition: "{definition}"
        },
        resolvedFieldTemplates: {
          Expression: { value: "{expression}", overwriteMode: "coalesce" },
          MainDefinition: {
            value: "{definition}",
            overwriteMode: "coalesce"
          }
        }
      });
    });

    expect(
      container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model")
        ?.value
    ).toBe("Kiku");
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-anki-field="Front"][data-field-control="value"]'
      )?.value
    ).toBe("");
    expect(container.textContent).toContain("Glossary");
    expect(container.textContent).not.toContain("MainDefinition");
  });

  it("saves a note-type change with fresh automatic mappings", async () => {
    vi.useFakeTimers();
    await render();
    await openMining();

    await settle(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Front"][data-field-control="value"]'
        ),
        "x"
      );
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        "Lapis"
      );
    }, 1);
    await act(flushAutosave);

    const saved = lastCallFor(HOSHIDICTS_CHANNELS.setMiningProfile)?.[1];
    expect(saved).toMatchObject({
      model: "Lapis",
      fieldTemplates: null,
      disabledFields: [],
      fields: {
        expression: "",
        reading: "",
        definition: "",
        sentence: "",
        frequency: "",
        pitch: "",
        audio: ""
      },
      fieldOverwriteModes: createDefaultHoshidictsFieldOverwriteModes()
    });
  });

  it("preserves mappings when explicit and Automatic select the same note type", async () => {
    vi.useFakeTimers();
    await render();
    await openMining();

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Front"][data-field-control="value"]'
        ),
        "x"
      );
      await flushAutosave();
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        "Kiku"
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(flushAutosave);

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getMiningOptions,
      "Kiku"
    );
    expect(
      lastCallFor(HOSHIDICTS_CHANNELS.setMiningProfile)?.[1]
    ).toMatchObject({
      model: "Kiku",
      fieldTemplates: {
        Front: { value: "x", overwriteMode: "coalesce" }
      }
    });

    await settle(() => {
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        ""
      );
    });
    await act(flushAutosave);

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getMiningOptions,
      ""
    );
    expect(
      lastCallFor(HOSHIDICTS_CHANNELS.setMiningProfile)?.[1]
    ).toMatchObject({
      model: "",
      fieldTemplates: {
        Front: { value: "x", overwriteMode: "coalesce" }
      }
    });
  });

  it("resets mappings when Automatic resolves to a different note type", async () => {
    const automaticRequest = deferred<HoshidictsMiningOptions>();
    ipc.configure({
      state: makeHoshidictsSnapshot({
        miningProfile: makeHoshidictsMiningProfile({ model: "Lapis" })
      }),
      miningOptions: makeHoshidictsMiningOptions({ selectedNoteType: "Lapis" }),
      handlers: {
        [HOSHIDICTS_CHANNELS.getMiningOptions]: (model) =>
          model === "" ? automaticRequest.promise : undefined
      }
    });
    vi.useFakeTimers();
    await render();
    await openMining();

    await flushAfter(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Front"][data-field-control="value"]'
        ),
        "x"
      );
    });
    const savesBeforeSwitch = callsFor(
      HOSHIDICTS_CHANNELS.setMiningProfile
    ).length;

    await settle(() => {
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        ""
      );
    });

    expect(
      container.querySelector<HTMLInputElement>(
        '[data-anki-field="Front"][data-field-control="value"]'
      )?.disabled
    ).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(callsFor(HOSHIDICTS_CHANNELS.setMiningProfile)).toHaveLength(
      savesBeforeSwitch
    );

    await settle(() => automaticRequest.resolve(miningOptions));
    await act(flushAutosave);

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getMiningOptions,
      ""
    );
    expect(
      lastCallFor(HOSHIDICTS_CHANNELS.setMiningProfile)?.[1]
    ).toMatchObject({ model: "", fieldTemplates: null });
  });

});
