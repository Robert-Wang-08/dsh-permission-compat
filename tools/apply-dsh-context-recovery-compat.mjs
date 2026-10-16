import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * DSH_SUBMIT_CONTEXT_RECOVERY_COMPAT_V1
 *
 * DSH 0.2.0-rc.2 only dispatches agent/request-error after an assistant stream
 * has started. pi-ai can detect CONTEXT_WINDOW_EXCEEDED before yielding the
 * first chunk, so compaction-basic never gets a chance to compact and retry.
 * This patch routes pre-first-chunk failures through the same recovery waterfall.
 *
 * The patch is version/anchor guarded, creates a timestamped backup, and never
 * kills or restarts the running DSH process. A new DSH instance is required to
 * load the patched module.
 */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const MARKER = 'DSH_SUBMIT_CONTEXT_RECOVERY_COMPAT_V1';
const TARGET = { module: 'dsh-agent-loop', file: ['lib', 'index.js'] };

const ORIGINAL = `\t\t\ttry {\n\t\t\t\tconst stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request);\n\t\t\t\tsignal.throwIfAborted();\n\t\t\t\tlive.start();\n\t\t\t\tstarted = true;\n\t\t\t\tfor await (const chunk of stream) {\n\t\t\t\t\tsignal.throwIfAborted();\n\t\t\t\t\tlive.push(chunk);\n\t\t\t\t}\n\t\t\t\tsignal.throwIfAborted();\n\t\t\t} catch (error) {\n\t\t\t\tif (!started) throw error;`;

const PATCHED = `\t\t\ttry {\n\t\t\t\tconst stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request);\n\t\t\t\tsignal.throwIfAborted();\n\t\t\t\tlive.start();\n\t\t\t\tstarted = true;\n\t\t\t\tfor await (const chunk of stream) {\n\t\t\t\t\tsignal.throwIfAborted();\n\t\t\t\t\tlive.push(chunk);\n\t\t\t\t}\n\t\t\t\tsignal.throwIfAborted();\n\t\t\t} catch (error) {\n\t\t\t\tif (!started) {\n\t\t\t\t\tconst failure = error instanceof LlmError ? error.failure : {\n\t\t\t\t\t\tmessage: errorChain(error),\n\t\t\t\t\t\tcode: \"UNKNOWN\"\n\t\t\t\t\t};\n\t\t\t\t\tconst action = await this.dispatch.waterfall(\"agent/request-error\", {\n\t\t\t\t\t\tturn,\n\t\t\t\t\t\tstep,\n\t\t\t\t\t\tprovider: request.provider,\n\t\t\t\t\t\tfailure,\n\t\t\t\t\t\tretryPolicy: preparedCall?.retryPolicy,\n\t\t\t\t\t\tsignal\n\t\t\t\t\t}, () => Promise.resolve(void 0));\n\t\t\t\t\tsignal.throwIfAborted();\n\t\t\t\t\tif (action?.kind === \"retry\") continue;\n\t\t\t\t\tthrow error;\n\t\t\t\t}`;

function findDshRoot() {
  const roots = [];
  if (process.env.DSH_ROOT) roots.push(path.resolve(process.env.DSH_ROOT));
  if (process.env.NVM_SYMLINK) roots.push(path.join(process.env.NVM_SYMLINK, 'node_modules'));
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (npmRoot.status === 0 && npmRoot.stdout) roots.push(npmRoot.stdout.trim());
  for (const root of [...new Set(roots.filter(Boolean))]) {
    const candidate = path.join(root, '@deepseek-ai', 'dsh');
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`Cannot locate @deepseek-ai/dsh; set DSH_ROOT explicitly`);
}

const dshRoot = findDshRoot();
const packageJson = JSON.parse(readFileSync(path.join(dshRoot, 'package.json'), 'utf8'));
const filePath = path.join(dshRoot, 'node_modules', '@deepseek-ai', TARGET.module, ...TARGET.file);
const backupDir = path.join(PROJECT_DIR, 'backups');
const prefix = `${TARGET.module}-${TARGET.file.at(-1)}-${packageJson.version}-`;

function source() {
  if (!existsSync(filePath)) throw new Error(`Target is missing: ${filePath}`);
  return readFileSync(filePath, 'utf8');
}
function backupName() {
  return `${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}.js`;
}
function verify() {
  const text = source();
  const problems = [];
  if (!text.includes(MARKER)) problems.push(`missing ${MARKER}`);
  if (!text.includes(PATCHED)) problems.push('pre-first-chunk recovery body is absent');
  if (text.includes(ORIGINAL)) problems.push('original non-recovering catch anchor remains');
  const check = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  if (check.error) problems.push(`node --check could not start: ${check.error.message}`);
  else if (check.status !== 0) problems.push(`node --check failed: ${check.stderr || check.stdout || `exit ${check.status}`}`);
  if (problems.length) throw new Error(`context recovery compat verification failed: ${problems.join('; ')}`);
  console.log(`VERIFIED ${MARKER} on dsh ${packageJson.version}`);
}
function apply() {
  const text = source();
  if (text.includes(MARKER)) return console.log(`SKIP ${MARKER} already applied`);
  const index = text.indexOf(ORIGINAL);
  if (index < 0 || text.indexOf(ORIGINAL, index + 1) >= 0) throw new Error(`Refusing patch: unique anchor not found in ${filePath}`);
  mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, backupName());
  copyFileSync(filePath, backup);
  const stamped = `/* ${MARKER}: route pre-first-chunk LLM failures through agent/request-error. */\n${PATCHED}`;
  writeFileSync(filePath, text.slice(0, index) + stamped + text.slice(index + ORIGINAL.length), 'utf8');
  console.log(`APPLIED ${MARKER} to dsh ${packageJson.version}`);
  console.log(`BACKUP ${backup}`);
}
function revert() {
  mkdirSync(backupDir, { recursive: true });
  const names = readdirSync(backupDir).filter((name) => name.startsWith(prefix) && name.endsWith('.js')).sort();
  if (!names.length) throw new Error(`No backup found for ${prefix}`);
  copyFileSync(path.join(backupDir, names.at(-1)), filePath);
  console.log(`REVERTED ${TARGET.module} from ${names.at(-1)}`);
}

if (process.argv.includes('--revert')) revert();
else if (process.argv.includes('--verify')) verify();
else { apply(); verify(); }
