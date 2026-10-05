import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const MARKER = 'DSH_SESSION_CONTROL_BASELINE_COMPAT_V1';

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
const moduleRoot = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-api-session-controller');
const hostPath = path.join(moduleRoot, 'lib', 'index.js');
const clientPath = path.join(moduleRoot, 'lib', 'client.js');
const host = readFileSync(hostPath, 'utf8');
const client = readFileSync(clientPath, 'utf8');

const clientNeedsQueues = 'Object.entries(baseline.queues)';
const compatibleBaseline = /baseline\(\) \{[\s\S]*?const queues = Object\.create\(null\);[\s\S]*?return \{\s*queues,\s*jobs,\s*projections:/;
const staleBaseline = [
	'\tbaseline() {',
	'\t\tconst sessions = this.ctx.sessions.list();',
	'\t\tconst jobs = Object.create(null);',
	'\t\tfor (const session of sessions) {',
	'\t\t\tconst agent = this.ctx.agents.get(session.id);',
	'\t\t\tjobs[session.id] = this.jobsFor(agent);',
	'\t\t}',
	'\t\treturn {',
	'\t\t\tjobs,',
	'\t\t\tprojections: this.projectionBaseline(sessions)',
	'\t\t};',
	'\t}',
].join('\n');
const repairedBaseline = [
	`\t// ${MARKER}: keep the Host baseline compatible with clients that require baseline.queues.`,
	'\tbaseline() {',
	'\t\tconst sessions = this.ctx.sessions.list();',
	'\t\tconst queues = Object.create(null);',
	'\t\tconst jobs = Object.create(null);',
	'\t\tfor (const session of sessions) {',
	'\t\t\tqueues[session.id] = [];',
	'\t\t\tconst agent = this.ctx.agents.get(session.id);',
	'\t\t\tjobs[session.id] = this.jobsFor(agent);',
	'\t\t}',
	'\t\treturn {',
	'\t\t\tqueues,',
	'\t\t\tjobs,',
	'\t\t\tprojections: this.projectionBaseline(sessions)',
	'\t\t};',
	'\t}',
].join('\n');

if (!client.includes(clientNeedsQueues)) {
	console.log(`SKIP session-control compatibility: client does not require baseline.queues (dsh ${packageJson.version})`);
	process.exit(0);
}

if (compatibleBaseline.test(host)) {
	console.log(`PASS session-control compatibility: Host provides baseline.queues (dsh ${packageJson.version})`);
	process.exit(0);
}

if (!host.includes(staleBaseline)) {
	throw new Error(`Refusing to repair dsh ${packageJson.version}: session-controller baseline anchor does not match ${hostPath}`);
}

const backupDir = process.env.DSH_COMPAT_BACKUP_DIR
	? path.resolve(process.env.DSH_COMPAT_BACKUP_DIR)
	: path.join(PROJECT_DIR, 'backups');
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `dsh-api-session-controller-index-${packageJson.version}-${stamp}.js`);
copyFileSync(hostPath, backupPath);
writeFileSync(hostPath, host.replace(staleBaseline, repairedBaseline), 'utf8');

console.log(`REPAIRED ${MARKER} for dsh ${packageJson.version}: ${hostPath}`);
console.log(`BACKUP ${backupPath}`);
