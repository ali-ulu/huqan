var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => HuqanTrustPanelPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = { endpoint: "http://127.0.0.1:3000", apiKey: "", workspaceId: "default", maxStatements: 20 };
var MAX_STATEMENT_LENGTH = 480;
function normalizeEndpoint(value) {
  const parsed = new URL(String(value || "").trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HUQAN endpoint must use http:// or https://");
  }
  const host = parsed.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new Error("HUQAN Trust Panel only sends API keys to a local loopback server.");
  }
  return `${parsed.protocol}//${parsed.host}`;
}
function splitStatements(markdown, limit) {
  const withoutFrontmatter = String(markdown || "").replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
  const withoutCode = withoutFrontmatter.replace(/```[\s\S]*?```/g, " ");
  const candidates = withoutCode.split(/\n+/).map((line) => line.replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/, "").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim()).filter((line) => line.length >= 8);
  const result = [];
  for (const candidate of candidates) {
    const words = candidate.split(/\s+/).filter(Boolean);
    let chunk = "";
    for (const word of words) {
      const next = chunk ? `${chunk} ${word}` : word;
      if (next.length > MAX_STATEMENT_LENGTH && chunk) {
        result.push(chunk);
        chunk = word;
        if (result.length >= limit)
          return result;
      } else {
        chunk = next;
      }
    }
    if (chunk)
      result.push(chunk);
    if (result.length >= limit)
      break;
  }
  return result;
}
function statusOf(result) {
  var _a, _b;
  if (result.error)
    return "error";
  return ((_b = (_a = result.envelope) == null ? void 0 : _a.data) == null ? void 0 : _b.status) || "unknown";
}
function evidenceLines(envelope) {
  var _a;
  const summary = (_a = envelope == null ? void 0 : envelope.data) == null ? void 0 : _a.evidenceSummary;
  if (Array.isArray(summary) && summary.length > 0)
    return summary.slice(0, 4).map(String);
  return ((envelope == null ? void 0 : envelope.evidence) || []).map((item) => typeof (item == null ? void 0 : item.text) === "string" ? item.text : "").filter(Boolean).slice(0, 4);
}
var VerificationModal = class extends import_obsidian.Modal {
  constructor(app, scope, sourceLabel, results) {
    super(app);
    this.scope = scope;
    this.sourceLabel = sourceLabel;
    this.results = results;
  }
  onOpen() {
    var _a, _b, _c, _d, _e, _f, _g;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("huqan-trust-panel-modal");
    const shell = contentEl.createDiv({ cls: "huqan-trust-panel" });
    const header = shell.createDiv({ cls: "huqan-trust-panel__header" });
    header.createEl("div", { cls: "huqan-trust-panel__eyebrow", text: "Live HUQAN verification" });
    header.createEl("h2", { text: "Evidence & Trust" });
    header.createEl("div", { cls: "huqan-trust-panel__source", text: this.sourceLabel });
    const counts = { verified: 0, contradicted: 0, unknown: 0, error: 0 };
    for (const result of this.results) {
      const status = statusOf(result);
      if (status === "verified")
        counts.verified += 1;
      else if (status === "contradicted")
        counts.contradicted += 1;
      else if (status === "error")
        counts.error += 1;
      else
        counts.unknown += 1;
    }
    const summary = shell.createDiv({ cls: "huqan-trust-panel__summary" });
    summary.createEl("strong", { text: `${this.results.length} statement${this.results.length === 1 ? "" : "s"} checked` });
    summary.createEl("div", {
      text: `Verified ${counts.verified} \xB7 Contradicted ${counts.contradicted} \xB7 Unknown ${counts.unknown} \xB7 Errors ${counts.error}`
    });
    summary.createEl("div", { cls: "huqan-trust-panel__scope", text: `Scope: ${this.scope}` });
    const list = shell.createDiv({ cls: "huqan-trust-panel__results" });
    for (const result of this.results) {
      const status = statusOf(result);
      const card = list.createDiv({ cls: `huqan-trust-panel__result is-${status}` });
      const top = card.createDiv({ cls: "huqan-trust-panel__result-top" });
      top.createEl("span", { cls: "huqan-trust-panel__status", text: status });
      const confidence = (_b = (_a = result.envelope) == null ? void 0 : _a.data) == null ? void 0 : _b.confidence;
      if (typeof confidence === "number") {
        top.createEl("span", { cls: "huqan-trust-panel__confidence", text: `${Math.round(confidence * 100)}% confidence` });
      }
      card.createEl("div", { cls: "huqan-trust-panel__statement", text: result.statement });
      if (result.error) {
        card.createEl("div", { cls: "huqan-trust-panel__error", text: result.error });
        continue;
      }
      const explanation = (_d = (_c = result.envelope) == null ? void 0 : _c.data) == null ? void 0 : _d.explanation;
      if (explanation)
        card.createEl("div", { cls: "huqan-trust-panel__explanation", text: explanation });
      const evidence = evidenceLines(result.envelope);
      if (evidence.length > 0) {
        const evidenceEl = card.createDiv({ cls: "huqan-trust-panel__evidence" });
        evidenceEl.createEl("strong", { text: "Evidence" });
        const ul = evidenceEl.createEl("ul");
        evidence.forEach((line) => ul.createEl("li", { text: line }));
      }
      const riskLabels = (_g = (_f = (_e = result.envelope) == null ? void 0 : _e.data) == null ? void 0 : _f.risk) == null ? void 0 : _g.labels;
      if (Array.isArray(riskLabels) && riskLabels.length > 0) {
        card.createEl("div", { cls: "huqan-trust-panel__risk", text: `Risk signals: ${riskLabels.join(", ")}` });
      }
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};
var HuqanSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "HUQAN Trust Panel" });
    new import_obsidian.Setting(containerEl).setName("Local HUQAN endpoint").setDesc("Loopback only. Your API key is never sent to a remote host.").addText((text) => text.setPlaceholder(DEFAULT_SETTINGS.endpoint).setValue(this.plugin.settings.endpoint).onChange(async (value) => {
      this.plugin.settings.endpoint = value.trim();
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("HUQAN API key").setDesc("Stored in this plugin's local Obsidian data and sent only to the loopback endpoint.").addText((text) => {
      text.inputEl.type = "password";
      text.setValue(this.plugin.settings.apiKey).onChange(async (value) => {
        this.plugin.settings.apiKey = value.trim();
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Workspace").setDesc("HUQAN workspace used by /v2/verify.").addText((text) => text.setValue(this.plugin.settings.workspaceId).onChange(async (value) => {
      this.plugin.settings.workspaceId = value.trim() || "default";
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Statements per note").setDesc("Bounds a full-note scan so a large note cannot flood the local verifier.").addSlider((slider) => slider.setLimits(1, 40, 1).setValue(this.plugin.settings.maxStatements).setDynamicTooltip().onChange(async (value) => {
      this.plugin.settings.maxStatements = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Connection test").setDesc("Checks the configured HUQAN /health endpoint.").addButton((button) => button.setButtonText("Test HUQAN").onClick(async () => {
      var _a;
      button.setDisabled(true);
      try {
        const health = await this.plugin.testConnection();
        new import_obsidian.Notice(`HUQAN connected: ${health.service || "huqan"} \xB7 ${(_a = health.nodes) != null ? _a : "?"} nodes`);
      } catch (error) {
        new import_obsidian.Notice(`HUQAN connection failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        button.setDisabled(false);
      }
    }));
  }
};
var HuqanTrustPanelPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
  }
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() };
    this.addSettingTab(new HuqanSettingTab(this.app, this));
    this.addRibbonIcon("shield-check", "HUQAN: Verify current note", () => {
      void this.verifyCurrentNote();
    });
    this.addCommand({ id: "huqan-verify-current-note", name: "HUQAN: Verify current note", callback: () => {
      void this.verifyCurrentNote();
    } });
    this.addCommand({
      id: "huqan-verify-selected-text",
      name: "HUQAN: Verify selected text",
      editorCallback: (editor) => {
        void this.verifySelection(editor);
      }
    });
    this.addCommand({ id: "huqan-test-connection", name: "HUQAN: Test connection", callback: () => {
      void this.showConnectionTest();
    } });
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async testConnection() {
    var _a;
    const endpoint = normalizeEndpoint(this.settings.endpoint);
    const response = await (0, import_obsidian.requestUrl)({ url: `${endpoint}/health`, method: "GET", throw: false });
    if (response.status !== 200 || !((_a = response.json) == null ? void 0 : _a.ok))
      throw new Error(`HTTP ${response.status}`);
    return response.json;
  }
  async showConnectionTest() {
    try {
      const health = await this.testConnection();
      new import_obsidian.Notice(`HUQAN connected: ${String(health.service || "huqan")}`);
    } catch (error) {
      new import_obsidian.Notice(`HUQAN connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async verifyCurrentNote() {
    var _a;
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view) {
      new import_obsidian.Notice("Open a markdown note first.");
      return;
    }
    const statements = splitStatements(view.editor.getValue(), this.settings.maxStatements);
    await this.verifyStatements("current_note", statements, ((_a = view.file) == null ? void 0 : _a.path) || "Current note");
  }
  async verifySelection(editor) {
    const selection = editor.getSelection().trim();
    if (!selection) {
      new import_obsidian.Notice("Select text first.");
      return;
    }
    const statements = splitStatements(selection, this.settings.maxStatements);
    await this.verifyStatements("selection", statements.length > 0 ? statements : [selection.slice(0, MAX_STATEMENT_LENGTH)], "Selected text");
  }
  async verifyStatements(scope, statements, label) {
    if (!this.settings.apiKey) {
      new import_obsidian.Notice("Set the HUQAN API key in plugin settings first.");
      return;
    }
    if (statements.length === 0) {
      new import_obsidian.Notice("No verifiable text found.");
      return;
    }
    let endpoint;
    try {
      endpoint = normalizeEndpoint(this.settings.endpoint);
    } catch (error) {
      new import_obsidian.Notice(error instanceof Error ? error.message : String(error));
      return;
    }
    new import_obsidian.Notice(`HUQAN is checking ${statements.length} statement${statements.length === 1 ? "" : "s"}\u2026`);
    const results = [];
    for (const statement of statements) {
      results.push(await this.verifyOne(endpoint, statement));
    }
    new VerificationModal(this.app, scope, label, results).open();
  }
  async verifyOne(endpoint, statement) {
    var _a, _b, _c;
    try {
      const response = await (0, import_obsidian.requestUrl)({
        url: `${endpoint}/v2/verify`,
        method: "POST",
        headers: { Authorization: `Bearer ${this.settings.apiKey}` },
        contentType: "application/json",
        body: JSON.stringify({ claim: statement, workspaceId: this.settings.workspaceId || "default" }),
        throw: false
      });
      if (response.status !== 200) {
        const message = typeof ((_a = response.json) == null ? void 0 : _a.error) === "string" ? response.json.error : (_c = (_b = response.json) == null ? void 0 : _b.error) == null ? void 0 : _c.message;
        return { statement, error: message || `HUQAN returned HTTP ${response.status}` };
      }
      const envelope = response.json;
      if (!(envelope == null ? void 0 : envelope.data) || typeof envelope.data.status !== "string") {
        return { statement, error: "HUQAN returned an invalid verify envelope." };
      }
      return { statement, envelope };
    } catch (error) {
      return { statement, error: error instanceof Error ? error.message : String(error) };
    }
  }
};
