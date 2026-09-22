'use strict';

const { stableStringify } = require('./api-snapshot-surface');

function keyMap(items, keyOf) {
  return new Map((items || []).map((item) => [keyOf(item), item]));
}

function addBreaking(list, area, key, reason) {
  list.push({ area, key, reason });
}

function compareSchema(base, current, context, breaking) {
  if (base === null || current === null || typeof base !== 'object' || typeof current !== 'object') {
    if (stableStringify(base, 0) !== stableStringify(current, 0)) {
      addBreaking(breaking, context.area, context.key, `${context.path}: schema value changed`);
    }
    return;
  }
  if (Array.isArray(base) || Array.isArray(current)) {
    if (!Array.isArray(base) || !Array.isArray(current)) {
      addBreaking(breaking, context.area, context.key, `${context.path}: schema shape changed`);
      return;
    }
    const currentSet = new Set(current.map((item) => stableStringify(item, 0)));
    for (const item of base) {
      if (!currentSet.has(stableStringify(item, 0))) {
        addBreaking(breaking, context.area, context.key, `${context.path}: accepted schema value removed`);
      }
    }
    return;
  }

  for (const field of ['type', 'const', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength']) {
    if (Object.hasOwn(base, field) && stableStringify(base[field], 0) !== stableStringify(current[field], 0)) {
      addBreaking(breaking, context.area, context.key, `${context.path}.${field}: constraint changed`);
    }
  }

  if (Array.isArray(base.enum)) {
    const currentEnum = new Set(Array.isArray(current.enum) ? current.enum.map(String) : []);
    for (const value of base.enum) {
      if (!currentEnum.has(String(value))) {
        addBreaking(breaking, context.area, context.key, `${context.path}.enum: value removed (${value})`);
      }
    }
  }

  const baseRequired = new Set(Array.isArray(base.required) ? base.required : []);
  const currentRequired = new Set(Array.isArray(current.required) ? current.required : []);
  if (context.direction === 'input') {
    for (const value of currentRequired) {
      if (!baseRequired.has(value)) {
        addBreaking(breaking, context.area, context.key, `${context.path}.required: new required input (${value})`);
      }
    }
  } else {
    for (const value of baseRequired) {
      if (!currentRequired.has(value)) {
        addBreaking(breaking, context.area, context.key, `${context.path}.required: required output removed (${value})`);
      }
    }
  }

  const beforeProps = base.properties && typeof base.properties === 'object' ? base.properties : {};
  const afterProps = current.properties && typeof current.properties === 'object' ? current.properties : {};
  for (const [name, schema] of Object.entries(beforeProps)) {
    if (!Object.hasOwn(afterProps, name)) {
      addBreaking(breaking, context.area, context.key, `${context.path}.properties: property removed (${name})`);
    } else {
      compareSchema(schema, afterProps[name], { ...context, path: `${context.path}.properties.${name}` }, breaking);
    }
  }

  for (const field of ['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf']) {
    if (!Object.hasOwn(base, field)) continue;
    if (!Object.hasOwn(current, field)) {
      addBreaking(breaking, context.area, context.key, `${context.path}.${field}: schema branch removed`);
    } else {
      compareSchema(base[field], current[field], { ...context, path: `${context.path}.${field}` }, breaking);
    }
  }
}

function diffSnapshots(base, current) {
  const breaking = [];
  const added = [];
  const compareIdentity = (area, beforeItems, afterItems, keyOf, onExisting) => {
    const before = keyMap(beforeItems, keyOf);
    const after = keyMap(afterItems, keyOf);
    for (const [key, item] of before) {
      if (!after.has(key)) addBreaking(breaking, area, key, 'removed');
      else onExisting?.(item, after.get(key), key);
    }
    for (const [key] of after) {
      if (!before.has(key)) added.push({ area, key });
    }
  };

  compareIdentity('exports', base.exports, current.exports, (item) => item.name, (before, after, key) => {
    if (before.target !== after.target) addBreaking(breaking, 'exports', key, 'export target changed');
  });

  const flatTypes = (snapshot) => (snapshot.types || []).flatMap((file) =>
    (file.declarations || []).map((decl) => ({ ...decl, file: file.file })));
  compareIdentity('types', flatTypes(base), flatTypes(current),
    (item) => `${item.file}:${item.kind}:${item.name}`,
    (before, after, key) => {
      if (before.signature !== after.signature) addBreaking(breaking, 'types', key, 'declaration signature changed');
    });

  compareIdentity('cli', base.cli?.canonical, current.cli?.canonical, (item) => item.command, (before, after, key) => {
    const removedAliases = (before.aliases || []).filter((value) => !(after.aliases || []).includes(value));
    const removedFlags = (before.flags || []).filter((value) => !(after.flags || []).includes(value));
    if (removedAliases.length) addBreaking(breaking, 'cli', key, `aliases removed: ${removedAliases.join(', ')}`);
    if (removedFlags.length) addBreaking(breaking, 'cli', key, `flags removed: ${removedFlags.join(', ')}`);
    if (before.usage !== after.usage) addBreaking(breaking, 'cli', key, 'usage/signature changed');
  });
  compareIdentity('cli-compat', base.cli?.compatibility, current.cli?.compatibility, (item) => item.command, (before, after, key) => {
    if (before.usage !== after.usage) addBreaking(breaking, 'cli-compat', key, 'usage/signature changed');
  });

  compareIdentity('mcp', base.mcp, current.mcp, (item) => item.name, (before, after, key) => {
    compareSchema(before.inputSchema, after.inputSchema, { area: 'mcp', key, path: 'inputSchema', direction: 'input' }, breaking);
    compareSchema(before.outputSchema, after.outputSchema, { area: 'mcp', key, path: 'outputSchema', direction: 'output' }, breaking);
  });

  compareIdentity('rest-routes', base.rest?.declared, current.rest?.declared, (item) => item.id, (before, after, key) => {
    for (const field of ['path', 'prefix', 'exposure']) {
      if (before[field] !== after[field]) addBreaking(breaking, 'rest-routes', key, `${field} changed`);
    }
    if (Array.isArray(before.methods)) {
      const methods = new Set(after.methods || []);
      for (const method of before.methods) {
        if (!methods.has(method)) addBreaking(breaking, 'rest-routes', key, `method removed (${method})`);
      }
    }
  });

  compareIdentity('rest-workflows', base.rest?.workflows, current.rest?.workflows,
    (item) => `${item.method}:${item.path}`,
    (before, after, key) => {
      compareSchema(before.requestSchema, after.requestSchema, { area: 'rest-workflows', key, path: 'requestSchema', direction: 'input' }, breaking);
      compareSchema(before.responseSchema, after.responseSchema, { area: 'rest-workflows', key, path: 'responseSchema', direction: 'output' }, breaking);
    });

  compareIdentity('schemas', base.schemas, current.schemas, (item) => item.path, (before, after, key) => {
    if (before.schemaVersion !== after.schemaVersion) {
      const migrations = (current.migrations || []).filter((item) => !(base.migrations || []).includes(item));
      if (migrations.length === 0) addBreaking(breaking, 'schemas', key, 'schema version changed without a new migration');
    }
    compareSchema(before.schema, after.schema, { area: 'schemas', key, path: key, direction: 'input' }, breaking);
  });

  return { breaking, added };
}

function reportMarkdown(result, options = {}) {
  const lines = ['<!-- huqan-api-contract -->', '## HUQAN API contract'];
  if (options.bootstrap) {
    lines.push('', 'Baseline bootstrap: the base branch does not contain `api-snapshot-baseline.json` yet.');
  }
  if (result.breaking.length === 0) lines.push('', '✅ No breaking API changes detected.');
  else {
    lines.push('', '⚠️ Breaking change detected. Major version bump required.', '', `❌ ${result.breaking.length} breaking API change(s) detected:`, '');
    for (const item of result.breaking) lines.push(`- **${item.area}** \`${item.key}\`: ${item.reason}`);
  }
  if (result.added.length > 0) {
    lines.push('', `ADDED (${result.added.length}):`);
    for (const item of result.added) lines.push(`- **${item.area}** \`${item.key}\``);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { compareSchema, diffSnapshots, reportMarkdown };
