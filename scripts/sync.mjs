// Copies factiii.com's approved skills into this repo as SKILL.md folders.
// Run by .github/workflows/sync.yml every 15 minutes; the workflow commits
// whatever this changed. No dependencies, so the run needs no install step.
//
// The server decides what a skill is (skills.export returns only approved
// ones); this script decides only where each one lives. A skill keeps the
// folder it was first given, found again by the uuid in its frontmatter, so
// an install command survives the author renaming the skill.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const EXPORT_URL =
  process.env.SKILLS_EXPORT_URL ?? 'https://api.factiii.com/trpc/skills.export';
const ROOT = process.env.SKILLS_ROOT ?? process.cwd();
const SKILLS_DIR = join(ROOT, 'skills');
const REPO = 'factiii/skills';

// The format's limit on `name`, which is also the folder.
const NAME_MAX = 64;
// Removing more than this share of the repo in one run is a broken export far
// more often than a real purge, so the run fails instead and a person looks.
const MAX_REMOVED_SHARE = 0.5;
const MIN_REMOVALS_TO_CHECK = 5;

const fetchExport = async () => {
  const res = await fetch(EXPORT_URL, {
    headers: { 'user-agent': `${REPO} sync (github actions)` }
  });
  if (!res.ok) throw new Error(`export answered ${res.status}`);
  const body = await res.json();
  const data = body?.result?.data?.json;
  if (!data || !Array.isArray(data.skills) || !Array.isArray(data.pending))
    throw new Error('export is not in the expected shape');
  return data;
};

/** uuid → folder, for every skill already in the repo. */
const readExisting = async () => {
  const byUuid = new Map();
  const names = await readdir(SKILLS_DIR).catch(() => []);
  for (const name of names) {
    const text = await readFile(
      join(SKILLS_DIR, name, 'SKILL.md'),
      'utf8'
    ).catch(() => null);
    const uuid = text?.match(/^\s+uuid:\s*"?([0-9a-f-]{36})"?\s*$/m)?.[1];
    if (uuid) byUuid.set(uuid, name);
  }
  return byUuid;
};

const slugOf = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/, '');

/** A folder nobody holds yet: the title's slug, numbered if it is taken. */
const claimName = (skill, taken) => {
  const base = slugOf(skill.title) || `skill-${skill.uuid.slice(0, 8)}`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) {
    const suffix = `-${n}`;
    name = `${base.slice(0, NAME_MAX - suffix.length)}${suffix}`;
  }
  taken.add(name);
  return name;
};

// JSON's string form is also a valid YAML double-quoted scalar, which keeps a
// title holding a colon or a quote from breaking the frontmatter.
const skillFile = (name, skill) =>
  [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(skill.title)}`,
    'metadata:',
    `  author: ${JSON.stringify(skill.author)}`,
    `  uuid: ${skill.uuid}`,
    '---',
    '',
    `# ${skill.title}`,
    '',
    skill.body,
    ''
  ].join('\n');

const readme = (entries) =>
  [
    '# Factiii skills',
    '',
    'Skills written and reviewed on [factiii.com/s/skills](https://factiii.com/s/skills). A moderator reads every one before it is listed. This repo is a copy, refreshed every 15 minutes; to add or change a skill, submit it there.',
    '',
    '## Install',
    '',
    '```bash',
    `npx skills add ${REPO}                    # choose from the list`,
    `npx skills add ${REPO} --skill <name>     # one skill`,
    '```',
    '',
    'In Claude Code:',
    '',
    '```',
    `/plugin marketplace add ${REPO}`,
    '```',
    '',
    `## Skills (${entries.length})`,
    '',
    ...entries.map(
      ({ name, skill }) =>
        `- [${name}](skills/${name}/SKILL.md): ${skill.title} (by @${skill.author})`
    ),
    ''
  ].join('\n');

const main = async () => {
  const data = await fetchExport();
  const existing = await readExisting();
  const approved = new Set(data.skills.map((s) => s.uuid));
  const kept = new Set([...approved, ...data.pending]);

  const removals = [...existing].filter(([uuid]) => !kept.has(uuid));
  if (removals.length > 0 && !data.complete)
    throw new Error('export was cut short, so nothing can safely be removed');
  if (
    removals.length >= MIN_REMOVALS_TO_CHECK &&
    removals.length > existing.size * MAX_REMOVED_SHARE
  )
    throw new Error(
      `export would remove ${removals.length} of ${existing.size} skills; run by hand if that is right`
    );
  for (const [, name] of removals)
    await rm(join(SKILLS_DIR, name), { recursive: true });

  const taken = new Set(existing.values());
  const entries = [];
  for (const skill of data.skills) {
    const name = existing.get(skill.uuid) ?? claimName(skill, taken);
    await mkdir(join(SKILLS_DIR, name), { recursive: true });
    await writeFile(join(SKILLS_DIR, name, 'SKILL.md'), skillFile(name, skill));
    entries.push({ name, skill });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(join(ROOT, 'README.md'), readme(entries));

  console.log(
    `${entries.length} skills written, ${removals.length} removed, ${data.pending.length} in review`
  );
};

await main();
