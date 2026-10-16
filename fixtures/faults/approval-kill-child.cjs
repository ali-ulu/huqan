'use strict';

const fs = require('node:fs');
const path = require('node:path');
const HuqanStorage = require('../../storage');

const dbPath = process.argv[2];
if (!dbPath) process.exit(2);

const store = new HuqanStorage({
  dbPath,
  memoryPath: path.join(path.dirname(dbPath), 'memory.json'),
});

store.saveToolApproval({
  id: 'fault-approval',
  approvalKey: 'mcp.huqan.agent.fault-approval',
  tool: 'huqan.agent',
  input: JSON.stringify({ goal: 'fault injection approval' }),
  context: { source: 'fault-harness', args: { goal: 'fault injection approval' } },
  policy: { gate: {} },
  status: 'pending',
  decision: 'review',
  reason: 'fault_fixture',
});

const claimed = store.claimToolApproval('fault-approval', 'fault_fixture_claim', 'default');
if (!claimed.claimed || claimed.approval?.status !== 'executing') process.exit(3);

fs.writeSync(1, 'READY\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
