// The window fixture supplies the game pixels. Only OBS scene discovery is simulated.
const scene = {id: "smoke", name: "Native OCR Smoke"};
const invoke = window.ipcRenderer.invoke;
window.ipcRenderer.invoke = (channel, ...args) => {
    if (channel === "obs.getScenes") return Promise.resolve([scene]);
    if (channel === "obs.getActiveScene") return Promise.resolve(scene);
    return invoke(channel, ...args);
};
const waitFor = async (read, name) => {
    const end = performance.now() + 12000;
    while (performance.now() < end) {
        const value = read();
        if (value) return value;
        await new Promise(done => setTimeout(done, 50));
    }
    throw Error("Timed out waiting for " + name + " (" + document.visibilityState + "): " + document.body.innerText.slice(-1600));
};
try {
    await waitFor(() => {
        window.__GSM_DESKTOP_DISPATCH__("app.navigateToTab", ["ocr"]);
        return document.querySelector(".desk-map-canvas:enabled");
    }, "OCR tab preview");
    const open = async () => {
        document.querySelector(".desk-map-canvas").click();
        return waitFor(() => document.querySelector(".ocr-selector-workspace .ocr-selector-toolbar"), "in-window area selector");
    };
    const button = (toolbar, label) => [...toolbar.querySelectorAll("button")].find(b => b.textContent.includes(label));
    const toolbar = await open();
    const canvas = await waitFor(() => {
        const box = document.querySelector(".ocr-selector-workspace .ocr-selector-image")?.getBoundingClientRect();
        return box && box.width >= 200 && box.height >= 100 && box;
    }, "expanded selector image");
    const ocrTab = document.querySelector(".tab-button.active");
    const homeTab = document.querySelector(".tab-button");
    const tabBox = homeTab.getBoundingClientRect();
    if (!homeTab.contains(document.elementFromPoint(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2)))
        throw Error("Editor is covering the main tabs");
    button(toolbar, "Auto-Send").click();
    button(toolbar, "Auto-Refresh").click();
    button(toolbar, "All").click();
    await waitFor(() => document.querySelector(".ocr-selector-workspace .ocr-selector-box"), "new area");
    homeTab.click();
    await waitFor(() => homeTab.classList.contains("active") && !toolbar.getClientRects().length, "switching away from OCR");
    ocrTab.click();
    await waitFor(() => toolbar.getClientRects().length && document.querySelector(".ocr-selector-workspace .ocr-selector-box"), "returning to the draft");
    button(toolbar, "Save areas").click();
    await waitFor(() => !document.querySelector(".ocr-selector-workspace") && document.querySelector(".desk-map-area"), "saved area in preview");
    const reopened = await open();
    if (document.querySelectorAll(".ocr-selector-workspace .ocr-selector-box").length !== 1) throw Error("Saved area did not reopen");
    const tips = [...reopened.querySelectorAll("button[title]")].filter(b => b.hasAttribute("aria-pressed") && !b.classList.contains("live"));
    if (tips.length !== 5 || tips.some(b => b.title.length < 20)) throw Error("Missing area type descriptions");
    if (button(reopened, "Auto-Send")?.getAttribute("aria-pressed") !== "true") throw Error("Auto-Send should start on");
    if (button(reopened, "Auto-Refresh")?.getAttribute("aria-pressed") !== "true") throw Error("Auto-Refresh preference was lost");
    if (!document.querySelector(".ocr-selector-workspace .desk-text-feed")) throw Error("Captured text feed missing from viewer");
    button(reopened, "Close").click();
    return {saved:true, reopened:true, editorWidth:canvas.width, editorHeight:canvas.height};
} finally {
    window.ipcRenderer.invoke = invoke;
}
