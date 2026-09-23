import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const MARKER = 'DSH_PERMISSION_COMPAT_V1';

function findDshRoot() {
  const roots = [];
  if (process.env.NVM_SYMLINK) roots.push(path.join(process.env.NVM_SYMLINK, 'node_modules'));
  try {
    roots.push(execFileSync('npm.cmd', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch {
    // The configured workstation normally resolves through NVM_SYMLINK.
  }
  for (const root of [...new Set(roots.filter(Boolean))]) {
    const candidate = path.join(root, '@deepseek-ai', 'dsh');
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`Cannot locate global @deepseek-ai/dsh under: ${roots.join(', ')}`);
}

function lines(items) {
  return items.join('\n');
}

const dshRoot = findDshRoot();
const packageJson = JSON.parse(readFileSync(path.join(dshRoot, 'package.json'), 'utf8'));
const modulePath = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-sandbox', 'lib', 'index.js');
const source = readFileSync(modulePath, 'utf8');

if (source.includes(MARKER)) {
  console.log(`SKIP ${MARKER} already applied to dsh ${packageJson.version}: ${modulePath}`);
  process.exit(0);
}

const oldModes = lines([
  'const WIDER_MODES = {',
  '\t"read-only": ["workspace-write", "danger-full-access"],',
  '\t"workspace-write": ["danger-full-access"]',
  '};',
]);
const newModes = lines([
  'const WIDER_MODES = {',
  '\t"read-only": ["workspace-write", "danger-full-access"],',
  '\t"workspace-write": ["danger-full-access"]',
  '};',
  `// ${MARKER}: normalize only permission requests already satisfied by the effective mode.`,
  'const MODE_RANK = {',
  '\t"read-only": 0,',
  '\t"workspace-write": 1,',
  '\t"danger-full-access": 2',
  '};',
]);

const oldNormalize = lines([
  'function normalizeEscalationArgs(sandboxPermissions, justification) {',
  '\tconst permission = sandboxPermissions !== void 0 && sandboxPermissions.trim().length > 0 ? sandboxPermissions : void 0;',
  '\tconst reason = justification !== void 0 && justification.trim().length > 0 ? justification : void 0;',
  '\tif (reason !== void 0 && permission === void 0) throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");',
  '\tif (permission !== void 0) {',
  '\t\tif (justification === void 0) throw new Error("invalid escalation: sandbox_permissions requires a justification");',
  '\t\tif (reason === void 0) throw new Error("invalid justification: expected a non-empty sentence");',
  '\t\treturn {',
  '\t\t\tsandbox_permissions: permission,',
  '\t\t\tjustification: reason',
  '\t\t};',
  '\t}',
  '}',
]);
const newNormalize = lines([
  'function normalizeEscalationArgs(sandboxPermissions, justification) {',
  '\tconst permission = sandboxPermissions !== void 0 && sandboxPermissions.trim().length > 0 ? sandboxPermissions : void 0;',
  '\tconst reason = justification !== void 0 && justification.trim().length > 0 ? justification : void 0;',
  '\tif (reason !== void 0 && permission === void 0) throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");',
  '\tif (permission !== void 0) return {',
  '\t\tsandbox_permissions: permission,',
  '\t\tjustification: reason',
  '\t};',
  '}',
]);

const oldApprove = lines([
  'async function approveEscalation(request, approval) {',
  '\tconst { requestedMode: mode, effectiveMode, justification, subject } = request;',
  '\tif (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`);',
  '\tif (approval.approver === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`);',
]);
const newApprove = lines([
  'async function approveEscalation(request, approval) {',
  '\tconst { requestedMode: mode, effectiveMode, justification, subject } = request;',
  '\tconst requestedRank = MODE_RANK[mode];',
  '\tconst effectiveRank = MODE_RANK[effectiveMode];',
  '\tif (requestedRank === void 0) throw new Error(`invalid sandbox escalation target: "${mode}"`);',
  '\tif (effectiveRank === void 0) throw new Error(`invalid effective sandbox mode: "${effectiveMode}"`);',
  '\tif (requestedRank <= effectiveRank) {',
  '\t\tconsole.warn(`[dsh-permission-compat] redundant escalation normalized: ${subject} requested ${mode} while effective mode is ${effectiveMode}`);',
  '\t\treturn effectiveMode;',
  '\t}',
  '\tif (justification === void 0) throw new Error("invalid justification: expected a non-empty sentence");',
  '\tif (approval.approver === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`);',
]);

for (const [label, anchor] of [
  ['mode ladder', oldModes],
  ['argument normalizer', oldNormalize],
  ['approval gate', oldApprove],
]) {
  if (!source.includes(anchor)) {
    throw new Error(`Refusing to patch dsh ${packageJson.version}: ${label} anchor does not match ${modulePath}`);
  }
}

const backupDir = path.join(PROJECT_DIR, 'backups');
mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `dsh-sandbox-index-${packageJson.version}-${new Date().toISOString().replace(/[:.]/g, '-')}.js`);
copyFileSync(modulePath, backupPath);

const patched = source
  .replace(oldModes, newModes)
  .replace(oldNormalize, newNormalize)
  .replace(oldApprove, newApprove);
if (!patched.includes(MARKER)) throw new Error('Patch marker missing after replacement');
writeFileSync(modulePath, patched, 'utf8');
console.log(`APPLIED ${MARKER} to dsh ${packageJson.version}: ${modulePath}`);
console.log(`BACKUP ${backupPath}`);
