'use strict';
const { types } = require('node:util');
const validString = value => typeof value === 'string' && value.length <= 1024;
const reserved = new Set(('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof new return super switch this throw try typeof var void while with yield enum await implements interface let package private protected public static null true false').split(' '));

function validStringArray(input) {
  if (types.isProxy(input) || !Array.isArray(input)) return false;
  const length = Object.getOwnPropertyDescriptor(input, 'length').value;
  if (length > 128) return false;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== length + 1) return false;
  for (let i = 0; i < length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !validString(descriptor.value)) return false;
  }
  return true;
}

function record(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
  });
}

function validateStringArrayProgram(program) {
  return record(program, ['type', 'separator']) && (program.type === 'join' || program.type === 'stableUniqueJoin')
    && validString(program.separator);
}

function evaluateStringArrayProgram(program, input) {
  if (!validateStringArrayProgram(program) || !validStringArray(input)) throw new TypeError('STRING_ARRAY_PROGRAM_INVALID');
  let output = ''; const seen = [];
  for (let i = 0; i < input.length; i += 1) {
    let found = false;
    if (program.type === 'stableUniqueJoin') {
      for (let j = 0; j < seen.length; j += 1) if (seen[j] === input[i]) { found = true; break; }
    }
    if (!found) { if (seen.length) output += program.separator; output += input[i]; seen[seen.length] = input[i]; }
  }
  return output;
}

function renderStringArrayProgram(program, parameter = 'value') {
  if (!validateStringArrayProgram(program) || typeof parameter !== 'string'
    || !/^[A-Za-z_$][\w$]*$/u.test(parameter) || reserved.has(parameter)) throw new TypeError('STRING_ARRAY_PROGRAM_INVALID');
  const separator = JSON.stringify(program.separator).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
  if (program.type === 'join') return `return (function(a){var out="",i,n=a.length,v;for(i=0;i<n;i++){if(i)out+=${separator};v=a[i];out+=v==null?"":v;}return out;})(${parameter});`;
  return `return (function(a){var out="",seen=[],i,j,n=a.length,v,found;for(i=0;i<n;i++){v=a[i];found=false;for(j=0;j<seen.length;j++){if(seen[j]===v){found=true;break;}}if(!found){if(seen.length)out+=${separator};out+=v==null?"":v;seen[seen.length]=v;}}return out;})(${parameter});`;
}

function searchStringArrayPrograms(examples, separator) {
  const result = { candidates: [], enumerated: 0, searchBudget: 2, matchingPrograms: 0 };
  if (!validString(separator) || types.isProxy(examples) || !Array.isArray(examples)) return result;
  const length = Object.getOwnPropertyDescriptor(examples, 'length').value;
  if (length < 1 || length > 32 || Reflect.ownKeys(examples).length !== length + 1) return result;
  const rows = [];
  for (let i = 0; i < length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(examples, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return result;
    const row = descriptor.value;
    if (!record(row, ['input', 'output']) || !validStringArray(row.input)
      || typeof row.output !== 'string' || row.output.length > 263168) return result;
    rows.push(row);
  }
  const matches = [];
  for (const type of ['join', 'stableUniqueJoin']) {
    const program = { type, separator }; result.enumerated += 1;
    if (rows.every(row => evaluateStringArrayProgram(program, row.input) === row.output)) matches.push({ program });
  }
  result.matchingPrograms = matches.length;
  if (matches.length === 1) result.candidates = matches;
  return result;
}

module.exports = { validStringArray, validateStringArrayProgram, evaluateStringArrayProgram,
  renderStringArrayProgram, searchStringArrayPrograms };
