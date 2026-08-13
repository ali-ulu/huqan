const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

function loadPlugin({ settings, requestHandler }) {
  const commands = [];
  const notices = [];
  const originalLoad = Module._load;
  class Element {
    empty() {}
    addClass() {}
    createDiv() { return new Element(); }
    createEl() { return new Element(); }
    createSpan() { return new Element(); }
  }
  class Plugin {
    constructor() {
      this.app = { workspace: { getActiveViewOfType: () => null } };
      this.manifest = { id: 'huqan-trust-panel' };
    }
    async loadData() { return settings; }
    async saveData() {}
    addSettingTab() {}
    addRibbonIcon() {}
    addCommand(command) { commands.push(command); }
  }
  class Modal { constructor() { this.contentEl = new Element(); } open() { this.onOpen?.(); } }
  class Notice { constructor(message) { notices.push(String(message)); } }
  class PluginSettingTab { constructor() { this.containerEl = new Element(); } }
  class Setting {
    setName() { return this; } setHeading() { return this; } setDesc() { return this; }
    addText() { return this; } addSlider() { return this; } addButton() { return this; }
  }
  const obsidian = { Plugin, Modal, Notice, PluginSettingTab, Setting, MarkdownView: class {}, Editor: class {}, requestUrl: requestHandler };
  Module._load = function(request, parent, isMain) {
    if (request === 'obsidian') return obsidian;
    return originalLoad.call(this, request, parent, isMain);
  };
  const target = path.resolve(__dirname, '..', 'obsidian-plugin', 'main.js');
  delete require.cache[target];
  const PluginClass = require(target).default;
  Module._load = originalLoad;
  return { plugin: new PluginClass(), commands, notices };
}

test('selected text is verified through the local HUQAN v2 endpoint', async () => {
  const calls = [];
  const { plugin, commands } = loadPlugin({
    settings: { endpoint: 'http://127.0.0.1:3000', apiKey: 'secret', workspaceId: 'vault-a', maxStatements: 20 },
    requestHandler: async options => {
      calls.push(options);
      return { status: 200, json: { ok: true, data: { status: 'verified', confidence: 0.9, evidenceSummary: ['cat --[type]--> animal'] }, evidence: [] } };
    },
  });
  await plugin.onload();
  const command = commands.find(item => item.id === 'huqan-verify-selected-text');
  assert.ok(command);
  command.editorCallback({ getSelection: () => 'Cats are animals' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/v2/verify');
  assert.equal(calls[0].headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(calls[0].body), { claim: 'Cats are animals', workspaceId: 'vault-a' });
});

test('remote endpoints are rejected before the API key can leave the machine', async () => {
  const calls = [];
  const { plugin, commands, notices } = loadPlugin({
    settings: { endpoint: 'https://example.com', apiKey: 'secret', workspaceId: 'default', maxStatements: 20 },
    requestHandler: async options => { calls.push(options); throw new Error('should not be called'); },
  });
  await plugin.onload();
  const command = commands.find(item => item.id === 'huqan-verify-selected-text');
  command.editorCallback({ getSelection: () => 'Cats are animals' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0);
  assert.ok(notices.some(message => message.includes('loopback server')));
});
