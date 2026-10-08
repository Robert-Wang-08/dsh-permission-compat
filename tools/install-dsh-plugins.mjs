import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const profileIndex = args.indexOf('--profile');
const PROFILE = profileIndex >= 0 && args[profileIndex + 1] ? args[profileIndex + 1] : 'web';

const PINS = {
	'@deepseek-ai/dsh-subagent-claude-code': '0.2.0-rc.2',
	'@deepseek-ai/dsh-subagent-codex': '0.2.0-rc.2',
	'@deepseek-ai/dsh-subagent-acp': '0.2.0-rc.2',
	'@deepseek-ai/dsh-mcp-client': '0.2.0-rc.2',
	'dsh-chat-import': '0.25.2',
};

const dshHome = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh');
const profilesDir = path.join(dshHome, 'profiles');
const profileDir = path.join(profilesDir, PROFILE);
const manifestPath = path.join(profileDir, 'package.json');
if (!existsSync(manifestPath)) {
	console.error(`[dsh-plugins] profile manifest not found: ${manifestPath}`);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.dependencies ??= {};

function installedVersion(name) {
	const candidates = [
		path.join(profileDir, 'node_modules', name, 'package.json'),
		path.join(profilesDir, 'node_modules', name, 'package.json'),
	];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			return JSON.parse(readFileSync(candidate, 'utf8')).version;
		} catch {
			// fall through to the next candidate
		}
	}
	return undefined;
}

const pending = [];
for (const [name, version] of Object.entries(PINS)) {
	const declared = manifest.dependencies[name];
	if (declared === undefined) {
		console.log(`[dsh-plugins] skip ${name} (not part of profile "${PROFILE}")`);
		continue;
	}
	const installed = installedVersion(name);
	if (declared === version && installed !== undefined) {
		console.log(`[dsh-plugins] ok ${name}@${installed}`);
		continue;
	}
	console.log(`[dsh-plugins] need ${name} -> ${version} (declared=${declared ?? 'none'}, installed=${installed ?? 'none'})`);
	pending.push(`${name}@${version}`);
}

if (pending.length === 0) {
	console.log(`[dsh-plugins] profile "${PROFILE}" already pinned at the 0.2 plugin set`);
	process.exit(0);
}

console.log(`[dsh-plugins] upgrading ${pending.length} plugin(s) in profile "${PROFILE}"`);
const result = spawnSync('dsh', ['plugin', '--profile', PROFILE, 'add', ...pending], { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
