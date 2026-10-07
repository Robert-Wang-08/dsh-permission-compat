import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const MARKER = 'DSH_SESSION_FORMAT_COMPAT_V1';

const V3_TO_V4_GUARD = '\t\tif (event.type === "system/message" && this.surface.length > 0 && this.protectedHead === void 0) throw new SessionFormatError("system/message requires a protected first surface head");';
const V2_TO_V3_GUARD = '\t\t\tif (hasSurface && head === void 0) throw new SessionFormatError("system/message requires a protected first surface head");';

const COMMENT = 'tolerate a late system/message in a migrated historical Session instead of refusing the whole migration.';

const TARGETS = [
	{ module: 'dsh-session-format-v3-to-v4', file: ['lib', 'index.js'], guards: [V3_TO_V4_GUARD] },
	{ module: 'dsh-session-format-v2-to-v3', file: ['lib', 'index.js'], guards: [V2_TO_V3_GUARD] },
	{ module: 'dsh-session-persistence-jsonl', file: ['lib', 'worker.cjs'], guards: [V3_TO_V4_GUARD, V2_TO_V3_GUARD] },
];

function findDshRoot() {
	if (process.env.DSH_ROOT) {
		const explicit = path.resolve(process.env.DSH_ROOT);
		if (existsSync(path.join(explicit, 'package.json'))) return explicit;
		throw new Error(`DSH_ROOT does not contain package.json: ${explicit}`);
	}
	const roots = [];
	if (process.env.NVM_SYMLINK) roots.push(path.join(process.env.NVM_SYMLINK, 'node_modules'));
	try {
		roots.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
	} catch {
		// Explicit roots normally suffice on Windows installations without npm on PATH.
	}
	if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
	for (const root of [...new Set(roots.filter(Boolean))]) {
		const candidate = path.join(root, '@deepseek-ai', 'dsh');
		if (existsSync(path.join(candidate, 'package.json'))) return candidate;
	}
	throw new Error(`Cannot locate global @deepseek-ai/dsh under: ${roots.join(', ')}`);
}

const dshRoot = findDshRoot();
const packageJson = JSON.parse(readFileSync(path.join(dshRoot, 'package.json'), 'utf8'));
const modulesRoot = path.join(dshRoot, 'node_modules', '@deepseek-ai');

function targetPath(target) {
	return path.join(modulesRoot, target.module, ...target.file);
}

function backupPrefix(target) {
	return `${target.module}-${target.file[target.file.length - 1]}-${packageJson.version}-`;
}

function backupDir() {
	const dir = process.env.DSH_COMPAT_BACKUP_DIR ? path.resolve(process.env.DSH_COMPAT_BACKUP_DIR) : path.join(PROJECT_DIR, 'backups');
	mkdirSync(dir, { recursive: true });
	return dir;
}

function stamp() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

function relax(source, guards) {
	let text = source;
	let hits = 0;
	for (const guard of guards) {
		let index = text.indexOf(guard);
		while (index >= 0) {
			const indent = (guard.match(/^\t*/) ?? [''])[0];
			text = text.slice(0, index) + `${indent}// ${MARKER}: ${COMMENT}` + text.slice(index + guard.length);
			hits += 1;
			index = text.indexOf(guard, index);
		}
	}
	return { text, hits };
}

function revert() {
	const dir = backupDir();
	let restored = 0;
	for (const target of TARGETS) {
		const prefix = backupPrefix(target);
		const candidates = readdirSync(dir)
			.filter((name) => name.startsWith(prefix) && (name.endsWith('.js') || name.endsWith('.cjs')))
			.sort();
		if (candidates.length === 0) {
			console.log(`SKIP revert ${target.module}: no backup matching ${prefix}*`);
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
	const filePath = targetPath(target);
	if (!existsSync(filePath)) {
		throw new Error(`Refusing to patch dsh ${packageJson.version}: ${target.module} is missing at ${filePath}`);
	}
	const source = readFileSync(filePath, 'utf8');
	if (source.includes(MARKER)) {
		console.log(`SKIP ${MARKER} already applied to ${target.module} (dsh ${packageJson.version})`);
		continue;
	}
	const { text, hits } = relax(source, target.guards);
	if (hits === 0) {
		throw new Error(`Refusing to patch dsh ${packageJson.version}: ${target.module} session-format guard anchor does not match ${filePath}`);
	}
	const dir = backupDir();
	const backupPath = path.join(dir, `${backupPrefix(target)}${stamp()}${target.file[target.file.length - 1] === 'worker.cjs' ? '.cjs' : '.js'}`);
	copyFileSync(filePath, backupPath);
	writeFileSync(filePath, text, 'utf8');
	console.log(`APPLIED ${MARKER} to ${target.module} (dsh ${packageJson.version}): ${hits} guard(s)`);
	console.log(`BACKUP ${backupPath}`);
	applied += 1;
}

console.log(`${applied} file(s) patched for dsh ${packageJson.version}; ${TARGETS.length - applied} already in place.`);
