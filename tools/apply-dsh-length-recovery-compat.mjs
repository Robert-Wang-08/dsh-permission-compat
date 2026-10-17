import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reclassify a `length` stop that has no room left to generate as context
 * overflow, so the harness compacts and retries instead of telling the user to
 * send "继续".
 *
 * Upstream defect (dsh 0.2.0-rc.2 + @earendil-works/pi-ai 0.87.1, still present
 * in pi-ai 1.3.0 and dsh 0.2.1-rc.1): `isContextOverflow()` detects "prompt
 * filled the window, nothing left to say" only when `usage.output === 0`
 * (pi-ai `dist/utils/overflow.js`, "Case 3"). Providers that emit one trailing
 * token therefore arrive at `mapStopReason()`'s `case "length": return
 * { kind: "max-tokens" }` and the chat UI renders
 *
 *   已达到输出 token 上限 / 回答被截断…发送"继续"可让模型接着输出。
 *
 * Measured on this machine:
 *   session-d88fa8d4 (2026-10-16, ais-2dsglm/deepseek-v4.1-flash, window 262144)
 *     turn 29 step 1  input 315414 + cacheRead  14336 = 329750  output 1
 *     turn 30 step 3  input   7343 + cacheRead 329728 = 337071  output 1
 *     turn 31 step 2  input   2100 + cacheRead 337024 = 339124  output 1
 *     turn 32 step 7  input   8882 + cacheRead 339072 = 347954  output 1
 *   session-01b651bf (2026-10-17, claudetokeniss25/claude-haiku-5-5, window 262144)
 *     turn  9 step 1  input      4 + cacheWrite 647097 = 647101  output 1
 * All five were reported as `max-tokens`; none of them was an output cap, and
 * "继续" re-sent the same oversized prompt every time.
 *
 * The patch adds one predicate ahead of the existing classification. When the
 * stop is `length`, the prompt already fills >= 99% of the window, and the
 * emitted output is tiny (<= 512 tokens), the window — not the completion
 * budget — is what ended the stream: with 1% of the window left, the remaining
 * room is far below any model's `maxTokens` (32768 of 262144 is 12.5%), so this
 * is exactly pi-ai's "recoverable length" shape. Returning the existing
 * `CONTEXT_WINDOW_EXCEEDED` failure plugs it into machinery that already
 * exists, with no loop or compaction change:
 *
 *   dsh-llm-pi-ai   finish.kind === "error", code CONTEXT_WINDOW_EXCEEDED
 *   dsh-agent-loop  dispatches `agent/request-error`; on {kind:"retry"} it
 *                   `continue`s the step (backed by the pre-first-chunk
 *                   recovery patch, same waterfall)
 *   dsh-compaction-basic  compacts on that code and returns {kind:"retry"},
 *                   bounded by `maxOverflowRetries` (default 1)
 *
 * Result: one bounded compact-and-retry that continues the answer, and — when
 * the single retry is not enough — an accurate "context overflow" failure
 * instead of a wrong output-cap notice. Genuine output-cap truncation keeps its
 * `max-tokens` rendering because the prompt is not filling the window.
 *
 * Also counts `cacheWrite`: providers that report a cached prefix park nearly
 * the whole prompt there (session-01b651bf: input 4, cacheWrite 647097), and
 * pi-ai's own arm only sums input + cacheRead.
 *
 * Modes:
 *   (default)   apply, idempotent, refuses when the anchor does not match
 *   --revert    restore the newest versioned backup for the installed dsh
 *   --verify    read-only assertions that the patch is installed and correct
 *
 * The patch is a byte-exact anchor replacement, not a heuristic edit: if a dsh
 * or pi-ai upgrade changes those two lines, this fails loudly instead of
 * writing a half-patch. Only code loaded by the NEXT dsh start is affected; the
 * running process keeps its already-imported module and is never restarted.
 */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const MARKER = 'DSH_LENGTH_OVERFLOW_COMPAT_V1';
const TARGET = { module: 'dsh-llm-pi-ai', file: ['lib', 'index.js'] };

/** The unpatched anchor, verbatim from dsh 0.2.0-rc.2. */
const ORIGINAL = [
	'function mapStopReason(message, contextWindow) {',
	'\tconst piAiOverflow = isContextOverflow(message, contextWindow);',
].join('\n');

/** The replacement: one predicate plus the same function probing it. */
const PATCHED = [
	'/* DSH_LENGTH_OVERFLOW_COMPAT_V1: a `length` stop with no room left is context overflow, not an output cap. */',
	'/**',
	'* Detect a `length` stop that is really prompt exhaustion: the request filled',
	'* the context window, so the provider had almost no room to generate and',
	'* closed the stream after a handful of tokens.',
	'*',
	'* `isContextOverflow()` misses exactly this shape because its usage-based arm',
	'* requires `usage.output === 0`; with one trailing token the harness reports',
	'* `max-tokens`, and the UI then advises sending "继续" — which cannot help,',
	'* because the prompt alone exceeds the window.',
	'*',
	'* Occupancy is measured over input + cacheRead + cacheWrite: providers that',
	'* report a cached prefix park nearly the whole prompt in the cache fields.',
	'*',
	'* @param message - the terminal pi-ai assistant message.',
	'* @param contextWindow - resolved catalog capacity for the routed model.',
	'* @returns whether the stop is prompt exhaustion rather than an output cap.',
	'*/',
	'const LENGTH_OVERFLOW_TINY_OUTPUT = 512;',
	'const LENGTH_OVERFLOW_PROMPT_RATIO = 0.99;',
	'function isLengthAtExhaustedWindow(message, contextWindow) {',
	'\tif (message.stopReason !== "length") return false;',
	'\tif (!(contextWindow > 0)) return false;',
	'\tconst usage = message.usage;',
	'\tif (usage === void 0 || usage === null) return false;',
	'\tif (!(usage.output <= LENGTH_OVERFLOW_TINY_OUTPUT)) return false;',
	'\tconst promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);',
	'\treturn promptTokens >= contextWindow * LENGTH_OVERFLOW_PROMPT_RATIO;',
	'}',
	'function mapStopReason(message, contextWindow) {',
	'\tconst piAiOverflow = isContextOverflow(message, contextWindow) || isLengthAtExhaustedWindow(message, contextWindow);',
].join('\n');

/** The single line that proves the predicate is actually consulted. */
const WIRED = '\tconst piAiOverflow = isContextOverflow(message, contextWindow) || isLengthAtExhaustedWindow(message, contextWindow);';

function findDshRoot() {
	if (process.env.DSH_ROOT) {
		const explicit = path.resolve(process.env.DSH_ROOT);
		if (existsSync(path.join(explicit, 'package.json'))) return explicit;
		throw new Error(`DSH_ROOT does not contain package.json: ${explicit}`);
	}
	const roots = [];
	if (process.env.NVM_SYMLINK) roots.push(path.join(process.env.NVM_SYMLINK, 'node_modules'));
	try {
		roots.push(spawnSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout?.trim());
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
const filePath = path.join(dshRoot, 'node_modules', '@deepseek-ai', TARGET.module, ...TARGET.file);

function backupPrefix() {
	return `${TARGET.module}-${TARGET.file[TARGET.file.length - 1]}-${packageJson.version}-`;
}

function backupDir() {
	const dir = process.env.DSH_COMPAT_BACKUP_DIR ? path.resolve(process.env.DSH_COMPAT_BACKUP_DIR) : path.join(PROJECT_DIR, 'backups');
	mkdirSync(dir, { recursive: true });
	return dir;
}

function stamp() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

function readTarget() {
	if (!existsSync(filePath)) throw new Error(`Refusing to touch dsh ${packageJson.version}: ${TARGET.module} is missing at ${filePath}`);
	return readFileSync(filePath, 'utf8');
}

function revert() {
	const dir = backupDir();
	const prefix = backupPrefix();
	const candidates = readdirSync(dir)
		.filter((name) => name.startsWith(prefix) && name.endsWith('.js'))
		.sort();
	if (candidates.length === 0) throw new Error(`Nothing to revert: no versioned backups matching ${prefix}* in ${dir}`);
	const latest = candidates[candidates.length - 1];
	copyFileSync(path.join(dir, latest), filePath);
	console.log(`REVERTED ${TARGET.module} from ${latest}`);
}

function verify() {
	const source = readTarget();
	const problems = [];
	if (!source.includes(MARKER)) problems.push(`marker ${MARKER} is absent`);
	if (!source.includes(PATCHED)) problems.push('patched mapStopReason body is not present verbatim');
	if (source.includes(ORIGINAL)) problems.push('unpatched mapStopReason anchor is still present (length stops are still misreported as max-tokens)');
	if (!source.includes(WIRED)) problems.push('isLengthAtExhaustedWindow is not wired into the overflow test');
	const check = spawnSync(process.execPath, ['--check', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
	if (check.error) console.log(`SKIP syntax check: cannot spawn node in this environment (${check.error.code ?? check.error.message})`);
	else if (check.status !== 0) problems.push(`node --check failed: ${String(check.stderr).trim().split('\n')[0]}`);
	if (problems.length > 0) {
		for (const problem of problems) console.error(`FAIL ${TARGET.module}: ${problem}`);
		throw new Error(`${TARGET.module} length recovery compat is NOT correctly installed (dsh ${packageJson.version})`);
	}
	console.log(`VERIFIED ${MARKER} on ${TARGET.module} (dsh ${packageJson.version})`);
}

function apply() {
	const source = readTarget();
	if (source.includes(MARKER)) {
		console.log(`SKIP ${MARKER} already applied to ${TARGET.module} (dsh ${packageJson.version})`);
		return false;
	}
	const index = source.indexOf(ORIGINAL);
	if (index < 0) {
		throw new Error(`Refusing to patch dsh ${packageJson.version}: ${TARGET.module} mapStopReason anchor does not match ${filePath}`);
	}
	if (source.indexOf(ORIGINAL, index + 1) >= 0) {
		throw new Error(`Refusing to patch dsh ${packageJson.version}: ${TARGET.module} mapStopReason anchor is not unique in ${filePath}`);
	}
	const backupPath = path.join(backupDir(), `${backupPrefix()}${stamp()}.js`);
	copyFileSync(filePath, backupPath);
	writeFileSync(filePath, source.slice(0, index) + PATCHED + source.slice(index + ORIGINAL.length), 'utf8');
	console.log(`APPLIED ${MARKER} to ${TARGET.module} (dsh ${packageJson.version})`);
	console.log(`BACKUP ${backupPath}`);
	return true;
}

if (process.argv.includes('--revert')) {
	revert();
	process.exit(0);
}
if (process.argv.includes('--verify')) {
	verify();
	process.exit(0);
}
const patched = apply();
if (patched) verify();
console.log(`${patched ? 'patched' : 'already in place'}: ${TARGET.module} for dsh ${packageJson.version}`);
