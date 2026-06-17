import { App, Plugin, PluginSettingTab, Setting, Notice, parseYaml, stringifyYaml } from 'obsidian';
import * as path from 'path';
import Kernel from '../../kernel';
import { resolvePathWithinRoot } from '../../lib/path-safety';

interface AxiomPluginSettings {
  memoryPath: string;
  lang: string;
}

const DEFAULT_SETTINGS: AxiomPluginSettings = {
  memoryPath: '.obsidian/axiom-memory.json',
  lang: 'tr',
};

function resolveVaultMemoryPath(vaultPath: string, memoryPath: string): string {
  const resolvedCandidate = path.resolve(vaultPath, memoryPath || DEFAULT_SETTINGS.memoryPath);
  try {
    return resolvePathWithinRoot(vaultPath, resolvedCandidate, { allowMissing: true });
  } catch (_) {
    new Notice('Hafiza yolu vault disina cikamaz; varsayilan yol kullanildi');
    return resolvePathWithinRoot(
      vaultPath,
      path.resolve(vaultPath, DEFAULT_SETTINGS.memoryPath),
      { allowMissing: true }
    );
  }
}

export default class AxiomPlugin extends Plugin {
  kernel: Kernel;
  settings: AxiomPluginSettings;

  async onload() {
    await this.loadSettings();

    const vaultPath = this.app.vault.getRoot().path;
    const memoryPath = resolveVaultMemoryPath(vaultPath, this.settings.memoryPath);
    this.kernel = new Kernel({
      memoryPath,
      lang: this.settings.lang,
    });

    this.addCommand({
      id: 'axiom-learn-selection',
      name: 'Learn from selection',
      editorCallback: (editor) => {
        const text = editor.getSelection();
        if (!text) {
          new Notice('Select text first');
          return;
        }
        const result = this.kernel.learn(text);
        new Notice(
          `Öğrenildi: ${result.data.learned} önerme, ` +
          `${result.data.conflicts.length} çelişki`
        );
      },
    });

    this.addCommand({
      id: 'axiom-dream',
      name: 'Dream',
      callback: () => {
        const result = this.kernel.dream({ limit: 10 });
        const h = result.data.hypotheses;
        if (h.length === 0) {
          new Notice('Hiç hipotez üretilmedi');
          return;
        }
        const lines = h.slice(0, 10).map((x, i) =>
          `${i + 1}. ${x.from} → ${x.to} (${(x.confidence * 100).toFixed(0)}%)`
        );
        new Notice(`Rüya sonuçları:\n${lines.join('\n')}`, 8000);
      },
    });

    this.addCommand({
      id: 'axiom-learn-note',
      name: 'Learn current note',
      editorCallback: (editor) => {
        const text = editor.getValue();
        if (!text) {
          new Notice('Note is empty');
          return;
        }
        const result = this.kernel.learnDocument(text);
        new Notice(
          `Öğrenildi: ${result.data.learned} önerme`
        );
      },
    });

    this.addCommand({
      id: 'axiom-stats',
      name: 'Show graph stats',
      callback: () => {
        const stats = this.kernel.graph.getStats();
        new Notice(
          `Düğüm: ${stats.nodes}\n` +
          `Kenar: ${stats.edges}\n` +
          `Altyapı: ${stats.backend}`
        );
      },
    });

    this.addCommand({
      id: 'axiom-contradictions',
      name: 'Show contradictions',
      callback: () => {
        const result = this.kernel.detectContradictions();
        const c = result.data?.contradictions || [];
        if (c.length === 0) {
          new Notice('Çelişki bulunamadı');
          return;
        }
        const lines = c.slice(0, 10).map((x, i) =>
          `${i + 1}. ${x.subject}: ${x.current} ≠ ${x.existing} (${x.type})`
        );
        new Notice(`Çelişkiler:\n${lines.join('\n')}`, 8000);
      },
    });

    this.addCommand({
      id: 'axiom-save',
      name: 'Save graph to file',
      callback: () => {
        this.kernel.graph.save();
        new Notice('Grafik kaydedildi');
      },
    });

    this.addSettingTab(new AxiomSettingTab(this.app, this));
  }

  onunload() {
    this.kernel.graph.save();
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class AxiomSettingTab extends PluginSettingTab {
  plugin: AxiomPlugin;

  constructor(app: App, plugin: AxiomPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Axiom Ayarları' });

    new Setting(containerEl)
      .setName('Hafıza dosyası')
      .setDesc('Vault köküne göreli yol')
      .addText(text =>
        text
          .setPlaceholder('.obsidian/axiom-memory.json')
          .setValue(this.plugin.settings.memoryPath)
          .onChange(async v => {
            this.plugin.settings.memoryPath = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Dil')
      .setDesc('NLP dili (tr, en, auto)')
      .addText(text =>
        text
          .setPlaceholder('tr')
          .setValue(this.plugin.settings.lang)
          .onChange(async v => {
            this.plugin.settings.lang = v;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('hr');
    const stats = this.plugin.kernel.graph.getStats();
    containerEl.createEl('p', {
      text: `Düğüm: ${stats.nodes} | Kenar: ${stats.edges} | Altyapı: ${stats.backend}`,
    });
  }
}
