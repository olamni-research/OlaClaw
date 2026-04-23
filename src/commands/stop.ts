import { writeFile, unlink, readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { getPidPath, cleanupPidFile } from "../pid";

// Extra sanity check before sending SIGTERM to a PID discovered via
// ~/.claude/projects/ directory enumeration. Ensures the path really looks
// like an OlaClaw project (has settings.json next to daemon.pid) — otherwise
// a malicious fake project could be used to have us kill an unrelated PID.
async function looksLikeOlaclawProject(projectPath: string): Promise<boolean> {
  try {
    const settingsPath = join(projectPath, ".claude", "olaclaw", "settings.json");
    const s = await stat(settingsPath);
    return s.isFile();
  } catch {
    return false;
  }
}

const CLAUDE_DIR = join(process.cwd(), ".claude");
const HEARTBEAT_DIR = join(CLAUDE_DIR, "olaclaw");
const STATUSLINE_FILE = join(CLAUDE_DIR, "statusline.cjs");
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");

async function teardownStatusline() {
  try {
    const settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
    delete settings.statusLine;
    await writeFile(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // file doesn't exist, nothing to clean up
  }

  try {
    await unlink(STATUSLINE_FILE);
  } catch {
    // already gone
  }
}

export async function stop() {
  const pidFile = getPidPath();
  let pid: string;
  try {
    pid = (await Bun.file(pidFile).text()).trim();
  } catch {
    console.log("No daemon is running (PID file not found).");
    process.exit(0);
  }

  try {
    process.kill(Number(pid), "SIGTERM");
    console.log(`Stopped daemon (PID ${pid}).`);
  } catch {
    console.log(`Daemon process ${pid} already dead.`);
  }

  await cleanupPidFile();
  await teardownStatusline();

  try {
    await unlink(join(HEARTBEAT_DIR, "state.json"));
  } catch {
    // already gone
  }

  process.exit(0);
}

export async function stopAll() {
  const projectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    console.log("No projects found.");
    process.exit(0);
  }

  let found = 0;
  for (const dir of dirs) {
    const projectPath = "/" + dir.slice(1).replace(/-/g, "/");
    const pidFile = join(projectPath, ".claude", "olaclaw", "daemon.pid");

    // Skip anything that isn't clearly an OlaClaw project. Without this
    // check, a malicious ~/.claude/projects/<name>/ entry could point our
    // SIGTERM at an unrelated PID.
    if (!(await looksLikeOlaclawProject(projectPath))) continue;

    let pid: string;
    try {
      pid = (await readFile(pidFile, "utf-8")).trim();
      const pidNum = Number(pid);
      if (!Number.isInteger(pidNum) || pidNum <= 1) continue;
      process.kill(pidNum, 0);
    } catch {
      continue;
    }

    found++;
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`\x1b[33m■ Stopped\x1b[0m PID ${pid} — ${projectPath}`);
      try { await unlink(pidFile); } catch {}
    } catch {
      console.log(`\x1b[31m✗ Failed to stop\x1b[0m PID ${pid} — ${projectPath}`);
    }
  }

  if (found === 0) {
    console.log("No running daemons found.");
  }

  process.exit(0);
}
