import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function findSandboxModule() {
  const roots = [];
  if (process.env.NVM_SYMLINK) roots.push(path.join(process.env.NVM_SYMLINK, 'node_modules'));
  try {
    roots.push(execFileSync('npm.cmd', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch {
    // The explicit NVM path above is sufficient on the configured workstation.
  }
  for (const root of [...new Set(roots.filter(Boolean))]) {
    const candidate = path.join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-sandbox', 'lib', 'index.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot locate dsh-sandbox under: ${roots.join(', ')}`);
}

const modulePath = findSandboxModule();
const source = readFileSync(modulePath, 'utf8');
assert.match(source, /DSH_PERMISSION_COMPAT_V1/, 'compatibility marker is missing');

const sandbox = await import(`${pathToFileURL(modulePath).href}?verify=${Date.now()}`);
const { normalizeEscalationArgs, approveEscalation } = sandbox;

assert.equal(normalizeEscalationArgs(undefined, undefined), undefined);
assert.equal(normalizeEscalationArgs('', ''), undefined);
assert.throws(
  () => normalizeEscalationArgs(undefined, 'reason without permission'),
  /justification is only valid together with sandbox_permissions/,
);

const redundant = normalizeEscalationArgs('workspace-write', '');
assert.deepEqual(redundant, {
  sandbox_permissions: 'workspace-write',
  justification: undefined,
});

let approvals = 0;
const warnings = [];
const originalWarn = console.warn;
console.warn = (message) => warnings.push(String(message));
try {
  const mode = await approveEscalation({
    requestedMode: redundant.sandbox_permissions,
    effectiveMode: 'workspace-write',
    justification: redundant.justification,
    subject: 'command',
  }, {
    approver: { request: async () => { approvals += 1; return 'allowed-once'; } },
    agent: {},
    toolName: 'pwsh',
  });
  assert.equal(mode, 'workspace-write');
} finally {
  console.warn = originalWarn;
}
assert.equal(approvals, 0, 'redundant escalation must not request approval');
assert.ok(warnings.some((line) => line.includes('redundant escalation normalized')),
  'redundant escalation must leave a diagnostic');

const missingReason = normalizeEscalationArgs('danger-full-access', '');
await assert.rejects(
  approveEscalation({
    requestedMode: missingReason.sandbox_permissions,
    effectiveMode: 'workspace-write',
    justification: missingReason.justification,
    subject: 'command',
  }, {
    approver: { request: async () => 'allowed-once' },
    agent: {},
    toolName: 'pwsh',
  }),
  /invalid justification/,
);

const genuine = normalizeEscalationArgs('danger-full-access', 'Write outside the workspace.');
assert.equal(await approveEscalation({
  requestedMode: genuine.sandbox_permissions,
  effectiveMode: 'workspace-write',
  justification: genuine.justification,
  subject: 'command',
}, {
  approver: { request: async () => 'allowed-once' },
  agent: {},
  toolName: 'pwsh',
}), 'danger-full-access');

await assert.rejects(
  approveEscalation({
    requestedMode: genuine.sandbox_permissions,
    effectiveMode: 'workspace-write',
    justification: genuine.justification,
    subject: 'command',
  }, {
    approver: { request: async () => 'rejected' },
    agent: {},
    toolName: 'pwsh',
  }),
  /user rejected escalating/,
);

console.log(`PASS dsh permission compatibility: ${modulePath}`);
