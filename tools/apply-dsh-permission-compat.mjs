import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
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

function lines(items) {
	return items.join('\n');
}

const dshRoot = findDshRoot();
const packageJson = JSON.parse(readFileSync(path.join(dshRoot, 'package.json'), 'utf8'));
const modulesRoot = path.join(dshRoot, 'node_modules', '@deepseek-ai');

const MODE_RANK_BLOCK = lines([
	`// ${MARKER}: ordered mode ranks so a request already satisfied by the effective mode is normalized instead of rejected.`,
	'const MODE_RANK = {',
	'\t"read-only": 0,',
	'\t"workspace-write": 1,',
	'\t"danger-full-access": 2',
	'};',
]);

const GUARD_MARKER = `// ${MARKER}: enter the escalation path on sandbox_permissions alone, so an absent justification cannot silently downgrade a genuine escalation.`;

const TARGETS = [
	{
		module: 'dsh-sandbox',
		anchors: [
			{
				label: 'mode ladder',
				old: lines([
					'const WIDER_MODES = {',
					'\t"read-only": ["workspace-write", "danger-full-access"],',
					'\t"workspace-write": ["danger-full-access"]',
					'};',
				]),
				new: lines([
					'const WIDER_MODES = {',
					'\t"read-only": ["workspace-write", "danger-full-access"],',
					'\t"workspace-write": ["danger-full-access"]',
					'};',
					MODE_RANK_BLOCK,
				]),
			},
			{
				label: 'argument validator',
				old: lines([
					'function validateEscalationArgs(sandboxPermissions, justification) {',
					'\tif (sandboxPermissions !== void 0 && justification === void 0) throw new Error("invalid escalation: sandbox_permissions requires a justification");',
					'\tif (justification !== void 0 && sandboxPermissions === void 0) throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");',
					'\tif (justification !== void 0 && justification.trim().length === 0) throw new Error("invalid justification: expected a non-empty sentence");',
					'}',
				]),
				new: lines([
					`// ${MARKER}: the empty/absent justification verdict moved into approveEscalation, which alone knows the effective mode.`,
					'function validateEscalationArgs(sandboxPermissions, justification) {',
					'\tif (justification !== void 0 && sandboxPermissions === void 0) throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");',
					'}',
				]),
			},
			{
				label: 'approval gate',
				old: lines([
					'async function approveEscalation(request, approval) {',
					'\tconst { requestedMode: mode, effectiveMode, justification, subject } = request;',
					'\tif (mode === effectiveMode) return effectiveMode;',
					'\tif (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`);',
				]),
				new: lines([
					'async function approveEscalation(request, approval) {',
					'\tconst { requestedMode: mode, effectiveMode, justification, subject } = request;',
					'\tconst requestedRank = MODE_RANK[mode];',
					'\tconst effectiveRank = MODE_RANK[effectiveMode];',
					'\tif (requestedRank === void 0) throw new Error(`invalid sandbox escalation target: "${mode}"`);',
					'\tif (effectiveRank === void 0) throw new Error(`invalid effective sandbox mode: "${effectiveMode}"`);',
					'\tif (requestedRank <= effectiveRank) {',
					`\t\tconsole.warn(\`[dsh-permission-compat] redundant escalation normalized: \${subject} requested \${mode} while effective mode is \${effectiveMode}\`);`,
					'\t\treturn effectiveMode;',
					'\t}',
					'\tif (justification === void 0) throw new Error("invalid escalation: sandbox_permissions requires a justification");',
					'\tif (justification.trim().length === 0) throw new Error("invalid justification: expected a non-empty sentence");',
					'\tif (approval.approver === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`);',
				]),
			},
		],
	},
	{
		module: 'dsh-tool-pwsh',
		anchors: [{
			label: 'escalation guard',
			old: '\t\t\tconst approvedMode = args.sandbox_permissions !== void 0 && args.justification !== void 0 ? await approvePwshEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy) : void 0;',
			new: lines([
				`\t\t\t${GUARD_MARKER}`,
				'\t\t\tconst approvedMode = args.sandbox_permissions !== void 0 ? await approvePwshEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy) : void 0;',
			]),
		}],
	},
	{
		module: 'dsh-tool-bash',
		anchors: [{
			label: 'escalation guard',
			old: '\t\t\tconst approvedMode = args.sandbox_permissions !== void 0 && args.justification !== void 0 ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy) : void 0;',
			new: lines([
				`\t\t\t${GUARD_MARKER}`,
				'\t\t\tconst approvedMode = args.sandbox_permissions !== void 0 ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy) : void 0;',
			]),
		}],
	},
	{
		module: 'dsh-tool-fs',
		anchors: [{
			label: 'escalation guard',
			old: '\t\tif (args.sandbox_permissions === void 0 || args.justification === void 0) return standingPolicy;',
			new: lines([
				`\t\t${GUARD_MARKER}`,
				'\t\tif (args.sandbox_permissions === void 0) return standingPolicy;',
			]),
		}],
	},
];

function targetPath(target) {
	return path.join(modulesRoot, target.module, 'lib', 'index.js');
}

function backupDir() {
	const dir = path.join(PROJECT_DIR, 'backups');
	mkdirSync(dir, { recursive: true });
	return dir;
}

function backupStamp() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

function revert() {
	const dir = backupDir();
	let restored = 0;
	for (const target of TARGETS) {
		const prefix = `${target.module}-index-${packageJson.version}-`;
		const candidates = readdirSync(dir)
			.filter((name) => name.startsWith(prefix) && name.endsWith('.js'))
			.sort();
		if (candidates.length === 0) {
			console.log(`SKIP revert ${target.module}: no backup matching ${prefix}*.js in ${dir}`);
			continue;
		}
		const latest = candidates[candidates.length - 1];
		copyFileSync(path.join(dir, latest), targetPath(target));
		console.log(`REVERTED ${target.module} from ${latest}`);
		restored += 1;
	}
	if (restored === 0) throw new Error(`Nothing to revert: no versioned backups for dsh ${packageJson.version} in ${dir}`);
}

if (process.argv.includes('--revert')) {
	revert();
	process.exit(0);
}

let applied = 0;
for (const target of TARGETS) {
	const modulePath = targetPath(target);
	const source = readFileSync(modulePath, 'utf8');

	if (source.includes(MARKER)) {
		console.log(`SKIP ${MARKER} already applied to ${target.module} (dsh ${packageJson.version}): ${modulePath}`);
		continue;
	}

	for (const { label, old } of target.anchors) {
		if (!source.includes(old)) {
			throw new Error(`Refusing to patch dsh ${packageJson.version}: ${target.module} ${label} anchor does not match ${modulePath}`);
		}
	}

	const dir = backupDir();
	const backupPath = path.join(dir, `${target.module}-index-${packageJson.version}-${backupStamp()}.js`);
	copyFileSync(modulePath, backupPath);

	let patched = source;
	for (const { old, new: replacement } of target.anchors) patched = patched.replace(old, replacement);
	if (!patched.includes(MARKER)) throw new Error(`Patch marker missing after replacement: ${modulePath}`);
	writeFileSync(modulePath, patched, 'utf8');

	console.log(`APPLIED ${MARKER} to ${target.module} (dsh ${packageJson.version}): ${modulePath}`);
	console.log(`BACKUP ${backupPath}`);
	applied += 1;
}

console.log(`${applied} module(s) patched for dsh ${packageJson.version}; ${TARGETS.length - applied} already in place.`);
