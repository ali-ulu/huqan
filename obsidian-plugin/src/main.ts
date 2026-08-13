import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from 'obsidian';

type VerifyStatus = 'verified' | 'contradicted' | 'unknown' | string;
type VerifyScope = 'current_note' | 'selection';

interface HuqanSettings { endpoint: string; apiKey: string; workspaceId: string; maxStatements: number; }

interface VerifyEnvelope { ok?: boolean;
  data?: {
    status?: VerifyStatus;
    confidence?: number;
    explanation?: string;
    evidenceSummary?: string[];
    contradictionReason?: string;
    risk?: { labels?: string[] };
  };
  evidence?: Array<{ text?: string; kind?: string; confidence?: number }>; error?: { code?: string; message?: string } | string | null; }

interface StatementResult { statement: string; envelope?: VerifyEnvelope; error?: string; }

const DEFAULT_SETTINGS: HuqanSettings = { endpoint: 'http://127.0.0.1:3000', apiKey: '', workspaceId: 'default', maxStatements: 20 };

const MAX_STATEMENT_LENGTH = 480;

function normalizeEndpoint(value: string): string {
  const parsed = new URL(String(value || '').trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('HUQAN endpoint must use http:// or https://');
  }
  const host = parsed.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error('HUQAN Trust Panel only sends API keys to a local loopback server.');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function splitStatements(markdown: string, limit: number): string[] {
  const withoutFrontmatter = String(markdown || '').replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '');
  const withoutCode = withoutFrontmatter.replace(/```[\s\S]*?```/g, ' ');
  const candidates = withoutCode
    .split(/\n+/)
    .map(line => line
      .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(line => line.length >= 8);

  const result: string[] = [];
  for (const candidate of candidates) {
    const words = candidate.split(/\s+/).filter(Boolean);
    let chunk = '';
    for (const word of words) {
      const next = chunk ? `${chunk} ${word}` : word;
      if (next.length > MAX_STATEMENT_LENGTH && chunk) {
        result.push(chunk);
        chunk = word;
        if (result.length >= limit) return result;
      } else {
        chunk = next;
      }
    }
    if (chunk) result.push(chunk);
    if (result.length >= limit) break;
  }
  return result;
}
function statusOf(result: StatementResult): VerifyStatus | 'error' {
  if (result.error) return 'error';
  return result.envelope?.data?.status || 'unknown';
}
function evidenceLines(envelope?: VerifyEnvelope): string[] {
  const summary = envelope?.data?.evidenceSummary;
  if (Array.isArray(summary) && summary.length > 0) return summary.slice(0, 4).map(String);
  return (envelope?.evidence || [])
    .map(item => typeof item?.text === 'string' ? item.text : '')
    .filter(Boolean)
    .slice(0, 4);
}
class VerificationModal extends Modal {
  constructor(
    app: App,
    private readonly scope: VerifyScope,
    private readonly sourceLabel: string,
    private readonly results: StatementResult[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('huqan-trust-panel-modal');
    const shell = contentEl.createDiv({ cls: 'huqan-trust-panel' });
    const header = shell.createDiv({ cls: 'huqan-trust-panel__header' });
    header.createEl('div', { cls: 'huqan-trust-panel__eyebrow', text: 'Live HUQAN verification' });
    header.createEl('h2', { text: 'Evidence & Trust' });
    header.createEl('div', { cls: 'huqan-trust-panel__source', text: this.sourceLabel });

    const counts = { verified: 0, contradicted: 0, unknown: 0, error: 0 };
    for (const result of this.results) {
      const status = statusOf(result);
      if (status === 'verified') counts.verified += 1;
      else if (status === 'contradicted') counts.contradicted += 1;
      else if (status === 'error') counts.error += 1;
      else counts.unknown += 1;
    }

    const summary = shell.createDiv({ cls: 'huqan-trust-panel__summary' });
    summary.createEl('strong', { text: `${this.results.length} statement${this.results.length === 1 ? '' : 's'} checked` });
    summary.createEl('div', {
      text: `Verified ${counts.verified} · Contradicted ${counts.contradicted} · Unknown ${counts.unknown} · Errors ${counts.error}`,
    });
    summary.createEl('div', { cls: 'huqan-trust-panel__scope', text: `Scope: ${this.scope}` });

    const list = shell.createDiv({ cls: 'huqan-trust-panel__results' });
    for (const result of this.results) {
      const status = statusOf(result);
      const card = list.createDiv({ cls: `huqan-trust-panel__result is-${status}` });
      const top = card.createDiv({ cls: 'huqan-trust-panel__result-top' });
      top.createEl('span', { cls: 'huqan-trust-panel__status', text: status });
      const confidence = result.envelope?.data?.confidence;
      if (typeof confidence === 'number') {
        top.createEl('span', { cls: 'huqan-trust-panel__confidence', text: `${Math.round(confidence * 100)}% confidence` });
      }
      card.createEl('div', { cls: 'huqan-trust-panel__statement', text: result.statement });
      if (result.error) {
        card.createEl('div', { cls: 'huqan-trust-panel__error', text: result.error });
        continue;
      }
      const explanation = result.envelope?.data?.explanation;
      if (explanation) card.createEl('div', { cls: 'huqan-trust-panel__explanation', text: explanation });
      const evidence = evidenceLines(result.envelope);
      if (evidence.length > 0) {
        const evidenceEl = card.createDiv({ cls: 'huqan-trust-panel__evidence' });
        evidenceEl.createEl('strong', { text: 'Evidence' });
        const ul = evidenceEl.createEl('ul');
        evidence.forEach(line => ul.createEl('li', { text: line }));
      }
      const riskLabels = result.envelope?.data?.risk?.labels;
      if (Array.isArray(riskLabels) && riskLabels.length > 0) {
        card.createEl('div', { cls: 'huqan-trust-panel__risk', text: `Risk signals: ${riskLabels.join(', ')}` });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
class HuqanSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HuqanTrustPanelPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'HUQAN Trust Panel' });
    new Setting(containerEl)
      .setName('Local HUQAN endpoint')
      .setDesc('Loopback only. Your API key is never sent to a remote host.')
      .addText(text => text.setPlaceholder(DEFAULT_SETTINGS.endpoint).setValue(this.plugin.settings.endpoint)
        .onChange(async (value: string) => { this.plugin.settings.endpoint = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('HUQAN API key')
      .setDesc('Stored in this plugin\'s local Obsidian data and sent only to the loopback endpoint.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setValue(this.plugin.settings.apiKey)
          .onChange(async (value: string) => { this.plugin.settings.apiKey = value.trim(); await this.plugin.saveSettings(); });
      });
    new Setting(containerEl)
      .setName('Workspace')
      .setDesc('HUQAN workspace used by /v2/verify.')
      .addText(text => text.setValue(this.plugin.settings.workspaceId)
        .onChange(async (value: string) => { this.plugin.settings.workspaceId = value.trim() || 'default'; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Statements per note')
      .setDesc('Bounds a full-note scan so a large note cannot flood the local verifier.')
      .addSlider(slider => slider.setLimits(1, 40, 1).setValue(this.plugin.settings.maxStatements).setDynamicTooltip()
        .onChange(async (value: number) => { this.plugin.settings.maxStatements = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Connection test')
      .setDesc('Checks the configured HUQAN /health endpoint.')
      .addButton(button => button.setButtonText('Test HUQAN').onClick(async () => {
        button.setDisabled(true);
        try {
          const health = await this.plugin.testConnection();
          new Notice(`HUQAN connected: ${health.service || 'huqan'} · ${health.nodes ?? '?'} nodes`);
        } catch (error) {
          new Notice(`HUQAN connection failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          button.setDisabled(false);
        }
      }));
  }
}
export default class HuqanTrustPanelPlugin extends Plugin {
  settings: HuqanSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.addSettingTab(new HuqanSettingTab(this.app, this));
    this.addRibbonIcon('shield-check', 'HUQAN: Verify current note', () => { void this.verifyCurrentNote(); });
    this.addCommand({ id: 'huqan-verify-current-note', name: 'HUQAN: Verify current note', callback: () => { void this.verifyCurrentNote(); } });
    this.addCommand({
      id: 'huqan-verify-selected-text',
      name: 'HUQAN: Verify selected text',
      editorCallback: (editor: Editor) => { void this.verifySelection(editor); },
    });
    this.addCommand({ id: 'huqan-test-connection', name: 'HUQAN: Test connection', callback: () => { void this.showConnectionTest(); } });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async testConnection(): Promise<Record<string, unknown>> {
    const endpoint = normalizeEndpoint(this.settings.endpoint);
    const response = await requestUrl({ url: `${endpoint}/health`, method: 'GET', throw: false });
    if (response.status !== 200 || !response.json?.ok) throw new Error(`HTTP ${response.status}`);
    return response.json as Record<string, unknown>;
  }

  private async showConnectionTest(): Promise<void> {
    try {
      const health = await this.testConnection();
      new Notice(`HUQAN connected: ${String(health.service || 'huqan')}`);
    } catch (error) {
      new Notice(`HUQAN connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async verifyCurrentNote(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) as MarkdownView | null;
    if (!view) { new Notice('Open a markdown note first.'); return; }
    const statements = splitStatements(view.editor.getValue(), this.settings.maxStatements);
    await this.verifyStatements('current_note', statements, view.file?.path || 'Current note');
  }

  private async verifySelection(editor: Editor): Promise<void> {
    const selection = editor.getSelection().trim();
    if (!selection) { new Notice('Select text first.'); return; }
    const statements = splitStatements(selection, this.settings.maxStatements);
    await this.verifyStatements('selection', statements.length > 0 ? statements : [selection.slice(0, MAX_STATEMENT_LENGTH)], 'Selected text');
  }

  private async verifyStatements(scope: VerifyScope, statements: string[], label: string): Promise<void> {
    if (!this.settings.apiKey) { new Notice('Set the HUQAN API key in plugin settings first.'); return; }
    if (statements.length === 0) { new Notice('No verifiable text found.'); return; }
    let endpoint: string;
    try { endpoint = normalizeEndpoint(this.settings.endpoint); }
    catch (error) { new Notice(error instanceof Error ? error.message : String(error)); return; }

    new Notice(`HUQAN is checking ${statements.length} statement${statements.length === 1 ? '' : 's'}…`);
    const results: StatementResult[] = [];
    for (const statement of statements) {
      results.push(await this.verifyOne(endpoint, statement));
    }
    new VerificationModal(this.app, scope, label, results).open();
  }

  private async verifyOne(endpoint: string, statement: string): Promise<StatementResult> {
    try {
      const response = await requestUrl({
        url: `${endpoint}/v2/verify`,
        method: 'POST',
        headers: { Authorization: `Bearer ${this.settings.apiKey}` },
        contentType: 'application/json',
        body: JSON.stringify({ claim: statement, workspaceId: this.settings.workspaceId || 'default' }),
        throw: false,
      });
      if (response.status !== 200) {
        const message = typeof response.json?.error === 'string' ? response.json.error : response.json?.error?.message;
        return { statement, error: message || `HUQAN returned HTTP ${response.status}` };
      }
      const envelope = response.json as VerifyEnvelope;
      if (!envelope?.data || typeof envelope.data.status !== 'string') {
        return { statement, error: 'HUQAN returned an invalid verify envelope.' };
      }
      return { statement, envelope };
    } catch (error) {
      return { statement, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
