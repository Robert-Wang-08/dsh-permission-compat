import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPAIR_SCRIPT = path.join(SCRIPT_DIR, 'ensure-dsh-session-control-compat.mjs');
const STALE = [
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

function fixture(host) {
	const root = mkdtempSync(path.join(tmpdir(), 'dsh-session-control-'));
	const moduleRoot = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'lib');
	mkdirSync(moduleRoot, { recursive: true });
	writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: 'test' }));
	writeFileSync(path.join(moduleRoot, 'index.js'), host);
	writeFileSync(path.join(moduleRoot, 'client.js'), 'Object.entries(baseline.queues)');
	return { root, moduleRoot, backups: path.join(root, 'backups') };
}

function run(item) {
	return execFileSync(process.execPath, [REPAIR_SCRIPT], {
		encoding: 'utf8',
		env: { ...process.env, DSH_ROOT: item.root, DSH_COMPAT_BACKUP_DIR: item.backups },
	});
}

const stale = fixture(STALE);
assert.match(run(stale), /REPAIRED DSH_SESSION_CONTROL_BASELINE_COMPAT_V1/);
const repaired = readFileSync(path.join(stale.moduleRoot, 'index.js'), 'utf8');
assert.match(repaired, /const queues = Object\.create\(null\);/);
assert.match(repaired, /queues\[session\.id\] = \[\];/);
assert.equal(readdirSync(stale.backups).length, 1);
assert.match(run(stale), /PASS session-control compatibility/);

const compatible = fixture(repaired.replace('DSH_SESSION_CONTROL_BASELINE_COMPAT_V1', 'UPSTREAM'));
const before = readFileSync(path.join(compatible.moduleRoot, 'index.js'), 'utf8');
assert.match(run(compatible), /PASS session-control compatibility/);
assert.equal(readFileSync(path.join(compatible.moduleRoot, 'index.js'), 'utf8'), before);

const unknown = fixture('baseline() { return { jobs: {}, projections: {} }; }');
const rejected = spawnSync(process.execPath, [REPAIR_SCRIPT], {
	encoding: 'utf8',
	env: { ...process.env, DSH_ROOT: unknown.root, DSH_COMPAT_BACKUP_DIR: unknown.backups },
});
assert.notEqual(rejected.status, 0);
assert.match(rejected.stderr, /session-controller baseline anchor does not match/);

console.log('PASS dsh session-control compatibility repair');
