import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const branch = (process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || '').trim();
const repository = (process.env.GITHUB_REPOSITORY || '').trim();
const commit = (process.env.GITHUB_SHA || '').trim().toLowerCase();

if (!branch) {
    throw new Error('GITHUB_HEAD_REF or GITHUB_REF_NAME is required.');
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must contain a GitHub owner and repository.');
}
if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('GITHUB_SHA must contain a full 40-character commit SHA.');
}

const outputPath = path.join(process.cwd(), 'electron-src', 'assets', 'prerelease.json');
const payload = {
    branch,
    repository,
    commit,
    generatedAt: new Date().toISOString(),
};

fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`[write-prerelease-metadata] ${repository}@${commit} (${branch}) -> ${outputPath}`);
