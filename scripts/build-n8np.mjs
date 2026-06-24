#!/usr/bin/env node
// Builds an .n8np package from n8n Source Control workflow files.
//
// Source Control commits workflows as `workflows/{id}.json` in the
// ExportableWorkflow shape. The .n8np package expects a manifest.json plus
// `workflows/<slug>/workflow.json` in the SerializedWorkflow shape. This
// script does that conversion + tar/gzip so CI can promote exactly what is in
// git (not a live instance's state).
//
// Usage:
//   node build-n8np.mjs [workflowsDir] [outFile]
// Env (override args):
//   WORKFLOWS_DIR, OUT_FILE, SOURCE_ID, SOURCE_VERSION
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';

const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR ?? process.argv[2] ?? 'workflows';
const OUT_FILE = process.env.OUT_FILE ?? process.argv[3] ?? 'out.n8np';
const SOURCE_ID = process.env.SOURCE_ID ?? 'git-source';
const SOURCE_VERSION = process.env.SOURCE_VERSION ?? '0.0.0';

// Mirror packages/cli/src/modules/n8n-packages/io/slug.utils.ts
function generateSlug(name, fallback = 'workflow') {
	const slug = String(name)
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	return slug || fallback;
}

const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
	console.error(`No *.json workflow files found in ${WORKFLOWS_DIR}`);
	process.exit(1);
}

const build = mkdtempSync(join(tmpdir(), 'n8np-'));
const manifestWorkflows = [];
const usedTargets = new Set();

for (const file of files) {
	const sc = JSON.parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf-8'));
	if (!sc.id || !sc.name) {
		console.error(`Skipping ${file}: missing id/name`);
		continue;
	}

	// ExportableWorkflow -> SerializedWorkflow (drop owner/triggerCount/nodeGroups;
	// add isPublished, which the importer only reads for the match-source policy).
	const serialized = {
		id: sc.id,
		name: sc.name,
		nodes: sc.nodes ?? [],
		connections: sc.connections ?? {},
		...(sc.settings !== undefined ? { settings: sc.settings } : {}),
		versionId: sc.versionId ?? '',
		parentFolderId: sc.parentFolderId ?? null,
		isPublished: false,
		isArchived: sc.isArchived ?? false,
	};

	let slug = generateSlug(sc.name);
	let target = `workflows/${slug}`;
	let n = 2;
	while (usedTargets.has(target)) target = `workflows/${slug}-${n++}`;
	usedTargets.add(target);

	mkdirSync(join(build, target), { recursive: true });
	writeFileSync(join(build, target, 'workflow.json'), JSON.stringify(serialized, null, 2));
	manifestWorkflows.push({ id: sc.id, name: sc.name, target });
}

const manifest = {
	packageFormatVersion: '1',
	exportedAt: new Date().toISOString(),
	sourceN8nVersion: SOURCE_VERSION,
	sourceId: SOURCE_ID,
	workflows: manifestWorkflows,
};
writeFileSync(join(build, 'manifest.json'), JSON.stringify(manifest, null, 2));

// manifest.json MUST be the first file entry (reader enforces this).
const fileList = ['manifest.json', ...manifestWorkflows.map((w) => `${w.target}/workflow.json`)];
await create({ gzip: true, file: OUT_FILE, cwd: build, portable: true }, fileList);
rmSync(build, { recursive: true, force: true });

console.log(`Built ${OUT_FILE} with ${manifestWorkflows.length} workflow(s):`);
for (const w of manifestWorkflows) console.log(`  - ${w.id}  ${w.name}  -> ${w.target}`);
