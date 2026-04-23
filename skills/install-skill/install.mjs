// Download a skill from GitHub into the project's skills/ directory
// Usage: node install.mjs <owner/repo> <skill-name> [target-dir]
// Works with Node 18+, Bun, Deno

import { mkdirSync, writeFileSync } from "fs";
import { basename, join, resolve, sep } from "path";

// Accept `owner/repo` or `owner/repo@<ref>` where <ref> is a commit SHA,
// tag, or branch. Unpinned installs emit a warning because a compromised
// upstream account can replace skill contents without the user noticing.
const repoSpec = process.argv[2];
const skillName = process.argv[3];
const targetDir = process.argv[4] || join(process.cwd(), "skills");

if (!repoSpec || !skillName) {
  console.log(JSON.stringify({ error: "Usage: node install.mjs <owner/repo[@sha]> <skill-name> [target-dir]" }));
  process.exit(1);
}

// Reject traversal and absolute paths in skillName — it becomes a directory.
if (/[\\/]/.test(skillName) || skillName === "." || skillName === ".." || skillName !== basename(skillName)) {
  console.log(JSON.stringify({ error: `Invalid skill name: ${skillName}` }));
  process.exit(1);
}

const [repo, ref] = repoSpec.split("@");
if (!ref) {
  console.error(
    `WARNING: ${repo} is unpinned. A compromised upstream can change this skill's contents. ` +
    `Pass ${repo}@<commit-sha> to pin.`
  );
}

const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
const headers = { "User-Agent": "olaclaw-skill-installer" };

try {
  // List files in the skill directory via GitHub API
  const apiUrl = `https://api.github.com/repos/${repo}/contents/skills/${skillName}${refQuery}`;
  const res = await fetch(apiUrl, { headers });

  let files;
  if (!res.ok) {
    // Try root-level skill (some repos put SKILL.md at root)
    const rootRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${skillName}${refQuery}`,
      { headers }
    );
    if (!rootRes.ok) {
      console.log(JSON.stringify({ error: `Skill not found at skills/${skillName} or ${skillName} in ${repo}` }));
      process.exit(1);
    }
    files = await rootRes.json();
  } else {
    files = await res.json();
  }

  if (!Array.isArray(files)) files = [files];

  const destDir = resolve(join(targetDir, skillName));
  mkdirSync(destDir, { recursive: true });

  const downloaded = [];
  for (const file of files) {
    if (file.type !== "file") continue;
    // Defensively strip any directory component GitHub might return and
    // confirm the final path stays inside destDir.
    const safeName = basename(String(file.name ?? ""));
    if (!safeName || safeName === "." || safeName === "..") continue;
    const filePath = resolve(join(destDir, safeName));
    if (!filePath.startsWith(destDir + sep) && filePath !== destDir) continue;
    const raw = await fetch(file.download_url);
    const content = await raw.text();
    writeFileSync(filePath, content);
    downloaded.push(safeName);
  }

  console.log(JSON.stringify({
    ok: true,
    skill: skillName,
    source: repo,
    ref: ref ?? null,
    pinned: Boolean(ref),
    path: destDir,
    files: downloaded,
  }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
}
