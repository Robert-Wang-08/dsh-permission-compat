import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Carry the child agent's own terminal failure text out of an in-process
 * subagent run.
 *
 * Upstream defect (dsh 0.2.0-rc.2): `readResult()` in
 * `@deepseek-ai/dsh-subagent-in-process-driver` maps the child's `turn/end`
 * reason to a bare `stopReason` and never fills `SubagentResult.diagnostic`.
 * The message exists in the child's terminal event — measured 2026-10-16 on
 * session c5e961a4, whose `turn/end` carried
 * `{"kind":"error","error":{"message":"codex-relay API error (502): 502 status code (no body)","code":"SERVER"}}`
 * and `{"message":"403 ... weekly (7-day) usage limit ...","code":"AUTH"}` —
 * but it was dropped in the driver. `dsh-tool-subagent`
 * (`stopReasonError()` + `withDiagnosticAndPartialText()`) can then only emit
 * the fixed headline `subagent run failed` plus partial output, so every
 * in-process subagent failure reaches the caller with no cause at all.
 *
 * This patch threads the message through as `diagnostic`, bounded exactly like
 * the out-of-process seam does (4096 UTF-8 bytes, `[diagnostic truncated]`).
 * It only ever attaches a diagnostic when the resulting `stopReason` is
 * `error`: `aborted` / `completed` / `max-tokens` / `refusal` keep their
 * current shape, so cancellation-settles-as-killed semantics and the seam's
 * `stopReason === "aborted" && diagnostic === undefined` distinction are
 * untouched.
 *
 * Modes:
 *   (default)   apply, idempotent, refuses when the anchor does not match
 *   --revert    restore the newest versioned backup for the installed dsh
 *   --verify    read-only assertions that the patch is installed and correct
 *
 * The patch is a whole-function replacement, not a line edit: the anchor must
 * match byte-for-byte or nothing is written. That is what makes a dsh upgrade
 * fail loudly here instead of silently producing a broken half-patch.
 */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const MARKER = 'DSH_SUBAGENT_DIAGNOSTIC_COMPAT_V1';

const TARGET = { module: 'dsh-subagent-in-process-driver', file: ['lib', 'index.js'] };

/** The unpatched function, verbatim from dsh 0.2.0-rc.2. */
const ORIGINAL = `/** Read one settled child's result from events after its activation boundary. */
function readResult(child, boundary, cancelled, structured) {
	const own = child.session.snapshotEvents(boundary);
	const lastEnd = foldConsumedWork(own).end;
	const output = finalAssistantOutput(own) ?? [];
	const recorded = toStopReason(lastEnd?.data.reason);
	const stopReason = cancelled && recorded !== "completed" ? "aborted" : recorded;
	if (structured !== void 0) {
		if (structured.captured !== void 0) return {
			output,
			structured: structured.captured.value,
			stopReason
		};
		if (stopReason === "completed") return {
			output,
			stopReason: cancelled ? "aborted" : "error"
		};
	}
	return {
		output,
		stopReason
	};
}`;

/** The replacement: one bounded reader plus the same function carrying `diagnostic`. */
const PATCHED = `/**
 * ${MARKER}
 * Read the child's own terminal failure text out of its \`turn/end\` reason.
 *
 * Upstream dropped this message, so every in-process subagent failure surfaced
 * as a bare \`subagent run failed\`. Keep it, bounded like the out-of-process
 * seam (\`MAX_SUBAGENT_DIAGNOSTIC_BYTES\` = 4096).
 */
const MAX_TERMINAL_DIAGNOSTIC_BYTES = 4096;
const TERMINAL_DIAGNOSTIC_SUFFIX = "\\n[diagnostic truncated]";
function terminalDiagnostic(reason) {
	const error = reason?.error;
	if (error === void 0 || error === null) return void 0;
	const message = typeof error === "string" ? error : typeof error.message === "string" ? error.message : "";
	const code = typeof error === "object" && typeof error.code === "string" ? error.code : "";
	const text = message.length === 0 ? code : code.length === 0 ? message : \`\${code}: \${message}\`;
	if (text.length === 0) return void 0;
	const encoder = new TextEncoder();
	const bytes = encoder.encode(text);
	if (bytes.byteLength <= MAX_TERMINAL_DIAGNOSTIC_BYTES) return text;
	let prefixBytes = MAX_TERMINAL_DIAGNOSTIC_BYTES - encoder.encode(TERMINAL_DIAGNOSTIC_SUFFIX).byteLength;
	while (prefixBytes > 0 && (bytes[prefixBytes] & 192) === 128) prefixBytes -= 1;
	return new TextDecoder().decode(bytes.subarray(0, prefixBytes)) + TERMINAL_DIAGNOSTIC_SUFFIX;
}
/** Read one settled child's result from events after its activation boundary. */
function readResult(child, boundary, cancelled, structured) {
	const own = child.session.snapshotEvents(boundary);
	const lastEnd = foldConsumedWork(own).end;
	const output = finalAssistantOutput(own) ?? [];
	const reason = lastEnd?.data.reason;
	const recorded = toStopReason(reason);
	const stopReason = cancelled && recorded !== "completed" ? "aborted" : recorded;
	const diagnostic = stopReason === "error" ? terminalDiagnostic(reason) : void 0;
	const carried = diagnostic === void 0 ? {} : { diagnostic };
	if (structured !== void 0) {
		if (structured.captured !== void 0) return {
			output,
			structured: structured.captured.value,
			stopReason,
			...carried
		};
		if (stopReason === "completed") return {
			output,
			stopReason: cancelled ? "aborted" : "error",
			...carried
		};
	}
	return {
		output,
		stopReason,
		...carried
	};
}`;

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
	if (!source.includes(PATCHED)) problems.push('patched readResult body is not present verbatim');
	if (source.includes(ORIGINAL)) problems.push('unpatched readResult body is still present (child diagnostic is still dropped)');
	if (!source.includes('const diagnostic = stopReason === "error" ? terminalDiagnostic(reason) : void 0;')) problems.push('diagnostic is not gated on the error stop reason');
	const check = spawnSync(process.execPath, ['--check', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
	if (check.error) console.log(`SKIP syntax check: cannot spawn node in this environment (${check.error.code ?? check.error.message})`);
	else if (check.status !== 0) problems.push(`node --check failed: ${String(check.stderr).trim().split('\n')[0]}`);
	if (problems.length > 0) {
		for (const problem of problems) console.error(`FAIL ${TARGET.module}: ${problem}`);
		throw new Error(`${TARGET.module} diagnostic compat is NOT correctly installed (dsh ${packageJson.version})`);
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
		throw new Error(`Refusing to patch dsh ${packageJson.version}: ${TARGET.module} readResult anchor does not match ${filePath}`);
	}
	if (source.indexOf(ORIGINAL, index + 1) >= 0) {
		throw new Error(`Refusing to patch dsh ${packageJson.version}: ${TARGET.module} readResult anchor is not unique in ${filePath}`);
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
