import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Behavioural regression for DSH_SUBAGENT_DIAGNOSTIC_COMPAT_V1.
 *
 * The patch is a whole-function replacement inside a larger module, so the only
 * honest check is to execute the patched `readResult` against the child
 * terminal events that actually occur in a DSH V4 session log, and assert on
 * the resulting `SubagentResult`:
 *
 *   - `turn/end` reason `{kind:"error", error:{message,code}}` (measured
 *     2026-10-16: `codex-relay API error (502): 502 status code (no body)` /
 *     `403 ... weekly (7-day) usage limit ...`) must surface as `diagnostic`,
 *     which is exactly the text `dsh-tool-subagent` prints behind
 *     `Diagnostic:` instead of a bare `subagent run failed`;
 *   - every other stop reason (`completed` / `max-tokens` / `aborted` /
 *     `blocked`) must keep its current shape — in particular a cancelled child
 *     stays `aborted` with NO diagnostic, so the seam's
 *     "aborted without diagnostic settles as killed" semantics are unchanged;
 *   - the diagnostic must stay within the 4096-byte seam limit.
 *
 * Usage: node test-dsh-subagent-diagnostic-compat.mjs
 */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TARGET = { module: 'dsh-subagent-in-process-driver', file: ['lib', 'index.js'] };
const BYTE_LIMIT = 4096;

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
const filePath = path.join(dshRoot, 'node_modules', '@deepseek-ai', TARGET.module, ...TARGET.file);
const source = readFileSync(filePath, 'utf8');

const readResultHeader = "/** Read one settled child's result from events after its activation boundary. */";
const helperStart = source.indexOf('const MAX_TERMINAL_DIAGNOSTIC_BYTES');
const readResultStart = source.indexOf(readResultHeader);
const readResultEnd = source.indexOf('\n//#endregion', readResultStart);
if (helperStart < 0 || readResultStart < 0 || readResultEnd < 0) {
	throw new Error(`Cannot extract patched ${TARGET.module} functions from ${filePath} — is DSH_SUBAGENT_DIAGNOSTIC_COMPAT_V1 applied?`);
}

/** Build `readResult` with the real patched source and the real neighbours stubbed. */
function makeReadResult({ reason, cancelled, structured, output = [{ type: 'text', text: 'partial answer' }] }) {
	const helper = source.slice(helperStart, readResultStart);
	const body = source.slice(readResultStart, readResultEnd);
	const factory = new Function('toStopReason', 'foldConsumedWork', 'finalAssistantOutput', `${helper}\n${body}\nreturn readResult;`);
	const toStopReason = (value) => {
		switch (value?.kind) {
			case 'completed': return 'completed';
			case 'max-tokens': return 'max-tokens';
			case 'aborted': return 'aborted';
			case 'blocked': return 'refusal';
			default: return 'error';
		}
	};
	const child = { session: { snapshotEvents: () => [] } };
	return factory(toStopReason, () => ({ end: { data: { reason } } }), () => output)(child, 0, cancelled, structured);
}

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`ok   ${name}`);
		return;
	}
	failures += 1;
	console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const relay502 = makeReadResult({
	reason: { kind: 'error', error: { code: 'SERVER', message: 'codex-relay API error (502): 502 status code (no body)' } },
	cancelled: false
});
check('502 error surfaces code + message as diagnostic', relay502.diagnostic === 'SERVER: codex-relay API error (502): 502 status code (no body)', JSON.stringify(relay502));
check('502 error keeps stopReason error', relay502.stopReason === 'error', JSON.stringify(relay502));
check('partial output is preserved unchanged', JSON.stringify(relay502.output) === JSON.stringify([{ type: 'text', text: 'partial answer' }]), JSON.stringify(relay502.output));

const kimi403 = makeReadResult({
	reason: { kind: 'error', error: { code: 'AUTH', message: "403 {\"error\":{\"type\":\"permission_error\",\"message\":\"You've reached your weekly (7-day) usage limit.\"}}" } },
	cancelled: false
});
check('403 quota error surfaces as diagnostic', typeof kimi403.diagnostic === 'string' && kimi403.diagnostic.startsWith('AUTH: 403 '), JSON.stringify(kimi403));

const messageOnly = makeReadResult({ reason: { kind: 'error', error: { message: 'server_error: Our servers are currently overloaded.' } }, cancelled: false });
check('error without a code still surfaces the message', messageOnly.diagnostic === 'server_error: Our servers are currently overloaded.', JSON.stringify(messageOnly));

const codeOnly = makeReadResult({ reason: { kind: 'error', error: { code: 'TRANSPORT' } }, cancelled: false });
check('error without a message falls back to the code', codeOnly.diagnostic === 'TRANSPORT', JSON.stringify(codeOnly));

const noDetail = makeReadResult({ reason: { kind: 'error' }, cancelled: false });
check('error with no detail stays diagnostic-free', noDetail.diagnostic === undefined && noDetail.stopReason === 'error', JSON.stringify(noDetail));

const cancelledWithError = makeReadResult({
	reason: { kind: 'error', error: { code: 'SERVER', message: 'codex-relay API error (502)' } },
	cancelled: true
});
check('cancellation still settles as aborted', cancelledWithError.stopReason === 'aborted', JSON.stringify(cancelledWithError));
check('cancellation carries NO diagnostic (killed semantics preserved)', cancelledWithError.diagnostic === undefined, JSON.stringify(cancelledWithError));

const completed = makeReadResult({ reason: { kind: 'completed' }, cancelled: false });
check('completed stays clean', completed.stopReason === 'completed' && completed.diagnostic === undefined, JSON.stringify(completed));

const maxTokens = makeReadResult({ reason: { kind: 'max-tokens' }, cancelled: false });
check('max-tokens stays clean', maxTokens.stopReason === 'max-tokens' && maxTokens.diagnostic === undefined, JSON.stringify(maxTokens));

const blocked = makeReadResult({ reason: { kind: 'blocked' }, cancelled: false });
check('blocked still maps to refusal without diagnostic', blocked.stopReason === 'refusal' && blocked.diagnostic === undefined, JSON.stringify(blocked));

const structuredOk = makeReadResult({ reason: { kind: 'completed' }, cancelled: false, structured: { captured: { value: { answer: 42 } } } });
check('structured result is still captured-first', structuredOk.structured?.answer === 42 && structuredOk.stopReason === 'completed', JSON.stringify(structuredOk));

const long = makeReadResult({
	reason: { kind: 'error', error: { code: 'SERVER', message: 'x'.repeat(9000) } },
	cancelled: false
});
check('oversized diagnostic is truncated within the seam limit', new TextEncoder().encode(long.diagnostic).byteLength <= BYTE_LIMIT, `bytes=${new TextEncoder().encode(long.diagnostic).byteLength}`);
check('truncation is visible in the text', long.diagnostic.endsWith('[diagnostic truncated]'), long.diagnostic.slice(-40));

console.log(`\n${failures === 0 ? 'ALL PASSED' : `FAILURES: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
