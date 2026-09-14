// Settings → Sharing: share this Hachidori with the person's other browsers
// through Anki, or use another Hachidori instead of this one.
// SPDX-License-Identifier: GPL-3.0-or-later
import { DEFAULT_SHARING_PORT } from "./sharing-protocol.js";

const POLL_MS = 2000;
// How long a copied address or a saved download outranks the derived status.
const NOTICE_MS = 8000;
const ADDRESS_KINDS = { tailscale: "Tailscale", local: "Local network" };

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function dictionaries(count) {
  return count === 1 ? "1 dictionary" : `${count ?? 0} dictionaries`;
}

// "the Hachidori in Chrome on this computer (5 dictionaries)"
function hostSummary(host, display) {
  const where = display === "this computer" ? "on this computer" : `at ${display}`;
  return `the Hachidori in ${host?.name || "another browser"} ${where} (${dictionaries(host?.dictionaryCount)})`;
}

// "Chrome on this computer", "another browser at 100.75.152.76"
function clientLabel(entry) {
  const where = entry.local ? "on this computer" : `at ${entry.address}`;
  return `${entry.name || "another browser"} ${where}`;
}

export function createSharingSettingsController({
  document, send, setStatus, downloadAddon,
  copy = text => document.defaultView.navigator.clipboard.writeText(text),
  reload = () => document.defaultView.location.reload(),
}) {
  const element = id => document.getElementById(id);
  let sharing = null;
  let pending = false;
  let timer = null;
  let sequence = 0;
  // A port typed while sharing is off survives status polls until the switch is used.
  let portDraft = null;
  // What the probe of this computer found: null before it ran, false for nothing.
  let found = null;
  let probing = false;
  let refusedBefore = false;
  let notice = null;
  let renderedAddresses = "";

  const client = () => sharing?.client ?? null;
  const linked = () => client()?.linked === true;
  // This install is the one being shared right now.
  const hosting = () => sharing?.enabled === true && sharing.connected === true;

  function derivedStatus() {
    if (linked()) {
      const link = client();
      if (link.connected) return [`Using ${hostSummary(link.host, link.display)}.`, "ready"];
      return [link.display === "this computer"
        ? "Linked to a Hachidori on this computer, but it is not reachable. Check that Anki and the sharing browser are open."
        : `Linked to ${link.display}, but it is not reachable. Check that Anki and the sharing browser are open there.`, "error"];
    }
    if (!sharing.enabled) return ["Not sharing.", undefined];
    if (sharing.error !== null) return [`Sharing is on, but ${lowerFirst(sharing.error)}`, "error"];
    if (sharing.dictionaries === 0) return ["Sharing starts once this Hachidori has dictionaries.", undefined];
    if (!sharing.connected) return ["Waiting for Anki. Sharing starts when Anki is open with the Hachidori Relay add-on.", undefined];
    if (sharing.network.enabled && sharing.network.active) return ["Sharing through Anki, on this computer and the network.", "ready"];
    return ["Sharing through Anki.", "ready"];
  }

  function renderStatus() {
    if (notice !== null && Date.now() < notice.until) {
      setStatus(notice.message, notice.tone);
      return;
    }
    notice = null;
    if (sharing !== null) setStatus(...derivedStatus());
  }

  function show(message, tone) {
    notice = { message, tone, until: Date.now() + NOTICE_MS };
    setStatus(message, tone);
  }

  function portValue() {
    return Number(element("sharing-host-port").value) || DEFAULT_SHARING_PORT;
  }

  function addressRow(entry) {
    const item = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = entry.address;
    const kind = document.createElement("span");
    kind.className = "field-hint";
    kind.textContent = ADDRESS_KINDS[entry.kind] ?? ADDRESS_KINDS.local;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = "Copy";
    button.addEventListener("click", () => {
      Promise.resolve(copy(entry.address)).then(
        () => show(`Copied ${entry.address}.`, "ready"),
        error => show(`Could not copy the address: ${describe(error)}`, "error"),
      );
    });
    item.append(code, kind, button);
    return item;
  }

  function renderAddresses() {
    const network = sharing?.network;
    const container = element("sharing-host-addresses");
    container.hidden = linked() || sharing?.enabled !== true || network?.enabled !== true;
    const note = element("sharing-host-addresses-note");
    const list = element("sharing-host-address-list");
    const addresses = !container.hidden && network.active && network.error === null ? network.addresses : [];
    if (container.hidden) note.textContent = "";
    else if (network.error !== null) note.textContent = `Anki could not share on the network: ${network.error}`;
    else if (!network.active) note.textContent = "The address appears once Anki is connected.";
    else if (addresses.length === 0) note.textContent = "Anki’s computer has no network address right now.";
    else note.textContent = "On your other computer, enter one of these under Sharing:";
    // Rows are rebuilt only when they change, so a Copy button keeps focus across polls.
    const key = JSON.stringify(addresses);
    if (key === renderedAddresses) return;
    renderedAddresses = key;
    list.replaceChildren(...addresses.map(addressRow));
  }

  function renderHost() {
    const enabled = sharing?.enabled === true;
    const isLinked = linked();
    const toggle = element("sharing-host-enabled");
    if (toggle.checked !== enabled) toggle.checked = enabled;
    toggle.disabled = pending || sharing === null;
    const network = element("sharing-host-network");
    const wantsNetwork = sharing?.network?.enabled === true;
    if (network.checked !== wantsNetwork) network.checked = wantsNetwork;
    network.disabled = pending || !enabled || isLinked;
    element("sharing-addon").hidden = hosting() || isLinked;
    element("sharing-addon-download").disabled = pending;
    const port = element("sharing-host-port");
    if (portDraft === null && sharing !== null && port.value !== String(sharing.port)) port.value = String(sharing.port);
    port.disabled = pending || enabled;
    renderAddresses();
    element("sharing-host-clients").textContent = clientsText();
    element("sharing-host").disabled = isLinked;
  }

  function clientsText() {
    if (!hosting()) return "";
    const clients = sharing.clients ?? [];
    if (clients.length === 0) return "No other browser is linked yet.";
    return `Linked: ${clients.map(clientLabel).join(", ")}.`;
  }

  function foundText() {
    if (found === null) return probing ? "Looking for a shared Hachidori on this computer…" : "";
    if (found === false) return "No other Hachidori is sharing on this computer.";
    return `Another browser on this computer is sharing: ${hostSummary(found.host, found.display)}.`;
  }

  function renderClient() {
    const isLinked = linked();
    element("sharing-client-nearby").hidden = isLinked || hosting();
    element("sharing-client-found").textContent = foundText();
    element("sharing-client-use").hidden = !found;
    element("sharing-client-use").disabled = pending;
    element("sharing-client-find").disabled = pending || probing;
    element("sharing-client-remote").hidden = isLinked;
    element("sharing-client-address").disabled = pending;
    element("sharing-client-link").hidden = isLinked;
    element("sharing-client-link").disabled = pending;
    element("sharing-client-unlink").hidden = !isLinked;
    element("sharing-client-unlink").disabled = pending;
  }

  function render() {
    renderHost();
    renderClient();
    renderStatus();
  }

  // One look at this computer: on opening, when another host appears (the relay
  // refuses this one), and on Look again. Never while this install is the host.
  async function probe() {
    if (probing || pending || sharing === null || linked() || hosting()) return;
    probing = true;
    renderClient();
    try {
      const reply = await send("hd_sharing_client_probe", { address: "" });
      found = reply.ok ? { address: reply.address, display: reply.display, host: reply.host } : false;
    } catch {
      found = false;
    }
    probing = false;
    renderClient();
  }

  async function refresh() {
    const current = ++sequence;
    try {
      const reply = await send("hd_sharing_status");
      if (current !== sequence) return;
      if (!reply.ok) throw new Error(reply.error || "The sharing status could not be read.");
      sharing = reply.sharing;
    } catch (error) {
      if (current !== sequence) return;
      setStatus(`Cannot read the sharing status: ${describe(error)}`, "error");
      return;
    }
    render();
    const refused = sharing.error !== null;
    if (refused && !refusedBefore) found = null;
    refusedBefore = refused;
    if (found === null) void probe();
  }

  async function run(action, onReply = null) {
    const operation = action();
    pending = true;
    sequence += 1;
    notice = null;
    render();
    let failure = null;
    try {
      const reply = await operation;
      if (!reply.ok) throw new Error(reply.error || "The request did not complete.");
      if (reply.sharing) sharing = reply.sharing;
      portDraft = null;
      onReply?.(reply);
    } catch (error) {
      failure = error;
    } finally {
      pending = false;
      render();
    }
    if (failure !== null) show(describe(failure), "error");
  }

  async function download() {
    pending = true;
    notice = { message: "Downloading the Anki add-on from GitHub…", until: Infinity };
    render();
    try {
      await downloadAddon();
      show("Saved hachidori-relay.ankiaddon to your downloads. Double-click it to install it in Anki, then restart Anki.", "ready");
    } catch (error) {
      show(`Could not download the add-on: ${describe(error)}`, "error");
    } finally {
      pending = false;
      render();
    }
  }

  // Revision comparisons in every reader only adopt newer values, so a page
  // that just swapped its whole shared state starts over.
  function link(address) {
    void run(() => send("hd_sharing_client_link", { address }), () => reload());
  }

  element("sharing-host-enabled").addEventListener("change", (event) => {
    if (event.target.checked) void run(() => send("hd_sharing_host_enable", { port: portValue(), network: element("sharing-host-network").checked }));
    else void run(() => send("hd_sharing_host_disable"));
  });
  element("sharing-host-network").addEventListener("change", (event) => {
    void run(() => send("hd_sharing_host_enable", { port: sharing?.port ?? portValue(), network: event.target.checked }));
  });
  element("sharing-host-port").addEventListener("input", () => {
    portDraft = element("sharing-host-port").value;
    render();
  });
  element("sharing-addon-download").addEventListener("click", () => { void download(); });
  element("sharing-client-find").addEventListener("click", () => {
    found = null;
    void probe();
  });
  element("sharing-client-use").addEventListener("click", () => {
    if (found) link(found.address);
  });
  element("sharing-client-link").addEventListener("click", () => link(element("sharing-client-address").value));
  element("sharing-client-unlink").addEventListener("click", () => {
    void run(() => send("hd_sharing_client_unlink"), () => reload());
  });

  return {
    start() {
      if (timer !== null) return;
      void refresh();
      timer = document.defaultView.setInterval(() => { void refresh(); }, POLL_MS);
    },
    stop() {
      if (timer === null) return;
      document.defaultView.clearInterval(timer);
      timer = null;
    },
    render,
  };
}
