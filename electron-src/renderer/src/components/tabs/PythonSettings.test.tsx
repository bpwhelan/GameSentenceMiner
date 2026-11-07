// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { PythonSettings } from "./PythonSettings";

describe("Python debugging tools", () => {
  let container: HTMLDivElement;
  let root: Root;
  const invoke = vi.fn();
  const openLogs = vi.fn();
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    invoke.mockReset().mockResolvedValue({ success: true, pythonVersion: "Python 3.13", pythonPath: "C:\\GSM\\python.exe", pipVersion: "pip 25" });
    openLogs.mockReset();
    Object.defineProperty(window, "ipcRenderer", { configurable: true, value: { invoke } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });
  async function render(active = true) {
    await act(async () => root.render(<I18nProvider><PythonSettings active={active} onRequestConsole={openLogs} /></I18nProvider>));
  }
  function button(text: string) {
    return Array.from(container.querySelectorAll("button")).find(item => item.textContent === text)!;
  }
  it("loads environment details only when opened and offers logs without changing packages", async () => {
    await render(false);
    expect(invoke).not.toHaveBeenCalled();
    await render();
    expect(container.textContent).toContain("C:\\GSM\\python.exe");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("python.getPythonInfo");
    await act(async () => button("Open logs").click());
    expect(openLogs).toHaveBeenCalledOnce();
    expect(container.querySelector("details")?.open).toBe(false);
  });
  it("leaves dependencies alone when reset confirmation is cancelled", async () => {
    await render();
    invoke.mockResolvedValueOnce({ response: 0 });
    await act(async () => button("Reset Python Dependencies").click());
    expect(invoke).toHaveBeenLastCalledWith("show-message-box", expect.objectContaining({ cancelId: 0, defaultId: 0 }));
    expect(invoke).not.toHaveBeenCalledWith("python.resetDependencies");
    expect(openLogs).not.toHaveBeenCalled();
    expect(button("Reset Python Dependencies").disabled).toBe(false);
  });
  it("resets confirmed dependencies, opens logs and prevents duplicate actions", async () => {
    await render();
    let finish!: (value: unknown) => void;
    invoke.mockResolvedValueOnce({ response: 1 }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => button("Reset Python Dependencies").click());
    expect(invoke).toHaveBeenLastCalledWith("python.resetDependencies");
    expect(openLogs).toHaveBeenCalledOnce();
    expect(button("Reset Python Dependencies").disabled).toBe(true);
    await act(async () => finish({ success: true, message: "Dependencies reset" }));
    expect(button("Reset Python Dependencies").disabled).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Dependencies reset");
  });
  it("installs a trimmed package specifier and keeps errors available for debugging", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>("#custom-package-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  sample==1.2  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    invoke.mockRejectedValueOnce(new Error("Download failed"));
    await act(async () => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(invoke).toHaveBeenLastCalledWith("python.installCustomPackage", "sample==1.2");
    expect(openLogs).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Download failed");
    expect(input.value).toBe("  sample==1.2  ");
    expect(button("Reset Python Dependencies").disabled).toBe(false);
  });
  it("shows a recoverable error when environment inspection fails", async () => {
    invoke.mockRejectedValueOnce(new Error("Python unavailable"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Python unavailable");
    await act(async () => button("Refresh Info").click());
    expect(container.textContent).toContain("Python 3.13");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
