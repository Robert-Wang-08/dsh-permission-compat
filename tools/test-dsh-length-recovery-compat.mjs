import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Behavioural regression for DSH_LENGTH_OVERFLOW_COMPAT_V1.
 *
 * The patch lives in one line of a large module, so a string check is not
 * enough: this executes the *installed* `mapStopReason` against the exact usage
 * vectors recorded in DSH session logs, with the real upstream
 * `isContextOverflow()` from pi-ai, and asserts what the harness will classify.
 *
 * Vectors are the five `turn/end` reasons that produced the misleading
 * "已达到输出 token 上限…发送『继续』" notice, plus controls that must keep
 * their old classification:
 *
 *   session-d88fa8d4 (2026-10-16, ais-2dsglm/deepseek-v4.1-flash, 262144)
 *     input 315414 + cacheRead 14336, output 1
 *     input   7343 + cacheRead 329728, output 1
 *     input   2100 + cacheRead 337024, output 1
 *     input   8882 + cacheRead 339072, output 1
 *   session-01b651bf (2026-10-17, claudetokeniss25/claude-haiku-5-5, 262144)
 *     input      4 + cacheWrite 647097, output 1
 *
 * Usage: node test-dsh-length-recovery-compat.mjs
 */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const MARKER = 'DSH_LENGTH_OVERFLOW_COMPAT_V1';
const TARGET = { module: 'dsh-llm-pi-ai', file: ['lib', 'index.js'] };
const TAIL_ANCHOR = '\n/**\n* Translate the pi-ai event stream';

function findDshRoot() {
	if (process.env.DSH_ROOT) {
		const explicit = path.resolve(process.env.DSH_ROOT);
		if (existsSync(path.join(explicit, 'package.json'))) return explicit;
		throw new Error(`DSH_ROOT does not contain package.json: ${explicit}`);
	}
	const roots = [];
	if (process.env.NVM_SYMLINK) roots.push(path.join(process.env.NVM_SYMLINK, 'node_modules'));
	if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
	for (const root of roots) {
		const candidate = path.join(root, '@deepseek-ai', 'dsh');
		if (existsSync(path.join(candidate, 'package.json'))) return candidate;
	}
	throw new Error(`Cannot locate global @deepseek-ai/dsh under: ${roots.join(', ')} (set DSH_ROOT)`);
}

const dshRoot = findDshRoot();
const packageJson = JSON.parse(readFileSync(path.join(dshRoot, 'package.json'), 'utf8'));
const filePath = path.join(dshRoot, 'node_modules', '@deepseek-ai', TARGET.module, ...TARGET.file);
const patchedSource = readFileSync(filePath, 'utf8');

if (!patchedSource.includes(MARKER)) {
	throw new Error(`${MARKER} is not installed in ${filePath} — run apply-dsh-length-recovery-compat.mjs first`);
}

/** The real upstream predicate, imported from the installed pi-ai. */
const overflowModule = await import(pathToFileURL(path.join(dshRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'overflow.js')).href);
const { isContextOverflow } = overflowModule;

/**
 * Build `mapStopReason` out of a module's own source, with its neighbours stubbed.
 * @param source - full module text (patched or a pre-patch backup).
 * @returns the module's `mapStopReason`.
 */
function makeMapStopReason(source) {
	const fnStart = source.indexOf('function mapStopReason(message, contextWindow) {');
	const fnEnd = source.indexOf(TAIL_ANCHOR, fnStart);
	if (fnStart < 0 || fnEnd < 0) throw new Error(`Cannot extract mapStopReason from candidate source`);
	const helperStart = source.indexOf('const LENGTH_OVERFLOW_TINY_OUTPUT');
	const helper = helperStart >= 0 && helperStart < fnStart ? source.slice(helperStart, fnStart) : '';
	const body = source.slice(fnStart, fnEnd);
	const factory = new Function(
		'isContextOverflow',
		'isContextWindowExceededError',
		'CONTEXT_WINDOW_EXCEEDED_CODE',
		'EMPTY_RESPONSE_CODE',
		'classifyPiAiError',
		`${helper}\n${body}\nreturn mapStopReason;`,
	);
	return factory(
		isContextOverflow,
		(text) => /context window|too long|maximum context/i.test(String(text)),
		'CONTEXT_WINDOW_EXCEEDED',
		'EMPTY_RESPONSE',
		() => 'PI_AI_ERROR',
	);
}

/** Newest pre-patch backup for the installed dsh, when one exists. */
function newestBackup() {
	const dir = process.env.DSH_COMPAT_BACKUP_DIR ? path.resolve(process.env.DSH_COMPAT_BACKUP_DIR) : path.join(PROJECT_DIR, 'backups');
	if (!existsSync(dir)) return undefined;
	const prefix = `${TARGET.module}-${TARGET.file[TARGET.file.length - 1]}-${packageJson.version}-`;
	const names = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.js')).sort();
	return names.length === 0 ? undefined : path.join(dir, names[names.length - 1]);
}

const patched = makeMapStopReason(patchedSource);
const backupPath = newestBackup();
const unpatched = backupPath === undefined ? undefined : makeMapStopReason(readFileSync(backupPath, 'utf8'));

/** `usage` mirrors pi-ai's AssistantMessage usage: input / output / cacheRead / cacheWrite. */
const VECTORS = [
	{
		name: 'session-d88fa8d4 turn 29 step 1 (ais-2dsglm, window 262144)',
		message: { stopReason: 'length', model: 'deepseek-v4.1-flash', usage: { input: 315414, output: 1, cacheRead: 14336 } },
		contextWindow: 262144,
		expectBefore: { kind: 'max-tokens' },
		expectAfter: { kind: 'error', code: 'CONTEXT_WINDOW_EXCEEDED' },
	},
	{
		name: 'session-d88fa8d4 turn 30 step 3',
		message: { stopReason: 'length', model: 'deepseek-v4.1-flash', usage: { input: 7343, output: 1, cacheRead: 329728 } },
		contextWindow: 262144,
		expectBefore: { kind: 'max-tokens' },
		expectAfter: { kind: 'error', code: 'CONTEXT_WINDOW_EXCEEDED' },
	},
	{
		name: 'session-d88fa8d4 turn 31 step 2',
		message: { stopReason: 'length', model: 'deepseek-v4.1-flash', usage: { input: 2100, output: 1, cacheRead: 337024 } },
		contextWindow: 262144,
		expectBefore: { kind: 'max-tokens' },
		expectAfter: { kind: 'error', code: 'CONTEXT_WINDOW_EXCEEDED' },
	},
	{
		name: 'session-d88fa8d4 turn 32 step 7',
		message: { stopReason: 'length', model: 'deepseek-v4.1-flash', usage: { input: 8882, output: 1, cacheRead: 339072 } },
		contextWindow: 262144,
		expectBefore: { kind: 'max-tokens' },
		expectAfter: { kind: 'error', code: 'CONTEXT_WINDOW_EXCEEDED' },
	},
	{
		name: 'session-01b651bf turn 9 step 1 (prompt parked in cacheWrite)',
		message: { stopReason: 'length', model: 'claude-haiku-5-5', usage: { input: 4, output: 1, cacheWrite: 647097 } },
		contextWindow: 262144,
		expectBefore: { kind: 'max-tokens' },
		expectAfter: { kind: 'error', code: 'CONTEXT_WINDOW_EXCEEDED' },
	},
	{
		name: 'wide window: 995k of 1M with a single trailing token',
		message: { stopReason: 'length', model: 'deepseek-v4.1-flash', usage: { input: 995000, output: 1 } },
		contextWindow: 1000000,
		expectBefore: { kind: 'max-tokens' },
		expectAfter: { kind: 'error', code: 'CONTEXT_WINDOW_EXCEEDED' },
	},
	// ---- controls: classification must not move ----
	{
		name: 'control: genuine output cap, roomy prompt (30k of 32k used)',
		message: { stopReason: 'length', model: 'deepseek-v4.1-flash', usage: { input: 120000, output: 30000 } },
		contextWindow: 262144,
		expectBefore: { kind: 'max-tokens' },
		expectAfter: { kind: 'max-tokens' },
	},
	{
		name: 'control: full prompt but a large output (not a no-room stop)',
		message: { stopReason: 'length', model: 'deepseek-v4.1-flash', usage: { input: 260000, output: 2000 } },
		contextWindow: 262144,
		expectBefore: { kind: 'max-tokens' },
		expectAfter: { kind: 'max-tokens' },
	},
	{
		name: 'control: one trailing token with a small prompt',
		message: { stopReason: 'length', model: 'deepseek-v4.1-flash', usage: { input: 65000, output: 1 } },
		contextWindow: 262144,
		expectBefore: { kind: 'max-tokens' },
		expectAfter: { kind: 'max-tokens' },
	},
	{
		name: 'boundary: 512 trailing tokens at a full prompt (inside the tiny-output bound)',
		message: { stopReason: 'length', model: 'deepseek-v4.1-flash', usage: { input: 262000, output: 512 } },
		contextWindow: 262144,
		expectBefore: { kind: 'max-tokens' },
		expectAfter: { kind: 'error', code: 'CONTEXT_WINDOW_EXCEEDED' },
	},
	{
		name: 'boundary: 513 tokens at a full prompt is no longer "no room to generate"',
		message: { stopReason: 'length', model: 'deepseek-v4.1-flash', usage: { input: 262000, output: 513 } },
		contextWindow: 262144,
		expectBefore: { kind: 'max-tokens' },
		expectAfter: { kind: 'max-tokens' },
	},
	{
		name: 'control: ordinary completed stop',
		message: { stopReason: 'stop', model: 'deepseek-v4.1-flash', content: [{ type: 'text', text: 'done' }], usage: { input: 1000, output: 200 } },
		contextWindow: 262144,
		expectBefore: { kind: 'stop' },
		expectAfter: { kind: 'stop' },
	},
	{
		name: 'control: empty completed stop stays an empty-response error',
		message: { stopReason: 'stop', model: 'deepseek-v4.1-flash', content: [], usage: { input: 1000, output: 0 } },
		contextWindow: 262144,
		expectBefore: { kind: 'error', code: 'EMPTY_RESPONSE' },
		expectAfter: { kind: 'error', code: 'EMPTY_RESPONSE' },
	},
];

/** Compare a produced reason against an expectation ({kind} or {kind, code}). */
function matches(reason, expected) {
	if (reason === undefined || reason.kind !== expected.kind) return false;
	if (expected.code === undefined) return true;
	return reason.failure?.code === expected.code;
}

let failures = 0;
for (const vector of VECTORS) {
	const after = patched({ ...vector.message, usage: vector.message.usage }, vector.contextWindow);
	const afterOk = matches(after, vector.expectAfter);
	let beforeNote = '';
	if (unpatched !== undefined) {
		const before = unpatched({ ...vector.message, usage: vector.message.usage }, vector.contextWindow);
		const beforeOk = matches(before, vector.expectBefore);
		if (!beforeOk) failures += 1;
		beforeNote = ` [pre-patch ${beforeOk ? 'ok' : 'MISMATCH'}: ${before.kind}${before.failure ? `/${before.failure.code}` : ''}]`;
	}
	if (!afterOk) failures += 1;
	const shown = `${after.kind}${after.failure ? `/${after.failure.code}` : ''}`;
	console.log(`${afterOk ? 'PASS' : 'FAIL'} ${vector.name} -> ${shown}${beforeNote}`);
}

const controls = VECTORS.filter((vector) => vector.name.startsWith('control:'));
if (unpatched !== undefined) {
	const changed = VECTORS.filter((vector) => {
		const before = unpatched({ ...vector.message, usage: vector.message.usage }, vector.contextWindow);
		const after = patched({ ...vector.message, usage: vector.message.usage }, vector.contextWindow);
		return before.kind !== after.kind || before.failure?.code !== after.failure?.code;
	});
	const unexpected = changed.filter((vector) => vector.name.startsWith('control:'));
	if (unexpected.length > 0) failures += 1;
	console.log(`${unexpected.length === 0 ? 'PASS' : 'FAIL'} controls unchanged: ${controls.length} control vectors, ${changed.length} reclassified total`);
} else {
	console.log(`SKIP pre-patch comparison: no versioned backup for dsh ${packageJson.version} in the backup dir`);
}

console.log(`${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — ${VECTORS.length} vectors against dsh ${packageJson.version} ${TARGET.module}`);
process.exit(failures === 0 ? 0 : 1);
