import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'DSH_PERMISSION_COMPAT_V1';

function findDshRoot() {
	const roots = [];
	if (process.env.NVM_SYMLINK) roots.push(path.join(process.env.NVM_SYMLINK, 'node_modules'));
	try {
		roots.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
	} catch {
		// `npm` may be unresolvable on PATH; the explicit roots above and below normally suffice.
	}
	if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
	for (const root of [...new Set(roots.filter(Boolean))]) {
		const candidate = path.join(root, '@deepseek-ai', 'dsh');
		if (existsSync(path.join(candidate, 'package.json'))) return candidate;
	}
	throw new Error(`Cannot locate global @deepseek-ai/dsh under: ${roots.join(', ')}`);
}

const dshRoot = findDshRoot();
const modulesRoot = path.join(dshRoot, 'node_modules', '@deepseek-ai');

for (const module of ['dsh-sandbox', 'dsh-tool-pwsh', 'dsh-tool-bash', 'dsh-tool-fs']) {
	const file = path.join(modulesRoot, module, 'lib', 'index.js');
	assert.ok(existsSync(file), `${module} is missing at ${file}`);
	assert.match(readFileSync(file, 'utf8'), new RegExp(MARKER), `${module} is not patched`);
}

const modulePath = path.join(modulesRoot, 'dsh-sandbox', 'lib', 'index.js');
const sandbox = await import(`${pathToFileURL(modulePath).href}?verify=${Date.now()}`);
const { validateEscalationArgs, approveEscalation, WIDER_MODES } = sandbox;

assert.deepEqual(WIDER_MODES, {
	'read-only': ['workspace-write', 'danger-full-access'],
	'workspace-write': ['danger-full-access'],
});

assert.equal(validateEscalationArgs(undefined, undefined), undefined);
assert.equal(validateEscalationArgs('', ''), undefined);
assert.equal(validateEscalationArgs('workspace-write', undefined), undefined);
assert.equal(validateEscalationArgs('workspace-write', ''), undefined);
assert.equal(validateEscalationArgs('workspace-write', 'reason'), undefined);
assert.throws(
	() => validateEscalationArgs(undefined, 'reason without permission'),
	/justification is only valid together with sandbox_permissions/,
);

let approvals = 0;
const approver = { request: async () => { approvals += 1; return 'allowed-once'; } };
const warnings = [];
const originalWarn = console.warn;
console.warn = (message) => warnings.push(String(message));

try {
	assert.equal(await approveEscalation({
		requestedMode: 'workspace-write',
		effectiveMode: 'workspace-write',
		justification: '',
		subject: 'command',
	}, { agent: {}, toolName: 'pwsh' }), 'workspace-write');

	assert.equal(await approveEscalation({
		requestedMode: 'workspace-write',
		effectiveMode: 'danger-full-access',
		justification: undefined,
		subject: 'operation',
	}, { agent: {}, toolName: 'write' }), 'danger-full-access');

	assert.equal(approvals, 0, 'a redundant escalation must not request approval');
	assert.equal(warnings.filter((line) => line.includes('redundant escalation normalized')).length, 2,
		'every redundant escalation must leave a diagnostic');

	await assert.rejects(approveEscalation({
		requestedMode: 'danger-full-access',
		effectiveMode: 'workspace-write',
		justification: undefined,
		subject: 'command',
	}, { approver, agent: {}, toolName: 'pwsh' }), /invalid escalation: sandbox_permissions requires a justification/);

	await assert.rejects(approveEscalation({
		requestedMode: 'danger-full-access',
		effectiveMode: 'workspace-write',
		justification: '   ',
		subject: 'command',
	}, { approver, agent: {}, toolName: 'pwsh' }), /invalid justification: expected a non-empty sentence/);

	assert.equal(approvals, 0, 'a genuine escalation without a justification must not prompt');

	assert.equal(await approveEscalation({
		requestedMode: 'danger-full-access',
		effectiveMode: 'workspace-write',
		justification: 'Write outside the workspace.',
		subject: 'command',
	}, { approver, agent: {}, toolName: 'pwsh' }), 'danger-full-access');
	assert.equal(approvals, 1, 'a genuine escalation must prompt exactly once');

	await assert.rejects(approveEscalation({
		requestedMode: 'danger-full-access',
		effectiveMode: 'workspace-write',
		justification: 'Write outside the workspace.',
		subject: 'command',
	}, { approver: { request: async () => 'rejected' }, agent: {}, toolName: 'pwsh' }),
	/the user rejected escalating this command to "danger-full-access"/);

	await assert.rejects(approveEscalation({
		requestedMode: 'root',
		effectiveMode: 'workspace-write',
		justification: 'reason',
		subject: 'command',
	}, { approver, agent: {}, toolName: 'pwsh' }), /invalid sandbox escalation target: "root"/);

	await assert.rejects(approveEscalation({
		requestedMode: 'workspace-write',
		effectiveMode: 'root',
		justification: 'reason',
		subject: 'command',
	}, { approver, agent: {}, toolName: 'pwsh' }), /invalid effective sandbox mode: "root"/);

	await assert.rejects(approveEscalation({
		requestedMode: 'danger-full-access',
		effectiveMode: 'workspace-write',
		justification: 'Write outside the workspace.',
		subject: 'command',
	}, { agent: {}, toolName: 'pwsh' }),
	/sandbox escalation to "danger-full-access" requires approval, but no approval service is composed/);
} finally {
	console.warn = originalWarn;
}

assert.equal(approvals, 1, 'only the genuine escalation may have prompted');

console.log(`PASS dsh permission compatibility (${path.basename(dshRoot)}): ${modulePath}`);
