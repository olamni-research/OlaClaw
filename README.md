<p align="center">
  <img src="images/02-classic-terminal@2x.png" alt="OlaClaw Banner" />
</p>


<p align="center">
  <img src="https://awesome.re/badge.svg" alt="Awesome" />
  <a href="https://github.com/moazbuilds/OlaClaw/stargazers">
    <img src="https://img.shields.io/github/stars/moazbuilds/OlaClaw?style=flat-square&color=f59e0b" alt="GitHub Stars" />
  </a>
  <a href="https://github.com/moazbuilds/OlaClaw">
    <img src="https://img.shields.io/static/v1?label=downloads&message=~15k%20every%2014%20days&color=2da44e&style=flat-square" alt="Downloads ~15k every 14 days" />
  </a>
  <a href="https://github.com/moazbuilds/OlaClaw/commits/master">
    <img src="https://img.shields.io/github/last-commit/moazbuilds/OlaClaw?style=flat-square&color=0ea5e9" alt="Last Commit" />
  </a>
  <a href="https://github.com/moazbuilds/OlaClaw/graphs/contributors">
    <img src="https://img.shields.io/github/contributors/moazbuilds/OlaClaw?style=flat-square&color=a855f7" alt="Contributors" />
  </a>
  <a href="https://x.com/moazbuilds">
    <img src="https://img.shields.io/badge/X-%40moazbuilds-000000?style=flat-square&logo=x" alt="X @moazbuilds" />
  </a>
</p>

<p align="center"><b>A lightweight, open-source OpenClaw version built into your Claude Code.</b></p>

OlaClaw turns your Claude Code into a personal assistant that never sleeps. It runs as a background daemon, executing tasks on a schedule, responding to messages on Telegram and Discord, transcribing voice commands, and integrating with any service you need.

> Note: Please don't use OlaClaw for hacking any bank system or doing any illegal activities. Thank you.

## Why OlaClaw?

| Category | OlaClaw | OpenClaw |
| --- | --- | --- |
| Anthropic Will Come After You | No | Yes |
| API Overhead | Directly uses your Claude Code subscription | Nightmare |
| Setup & Installation | ~5 minutes | Nightmare |
| Deployment | Install Claude Code on any device or VPS and run | Nightmare |
| Isolation Model | Folder-based and isolated as needed | Global by default (security nightmare) |
| Reliability | Simple reliable system for agents | Bugs nightmare |
| Feature Scope | Lightweight features you actually use | 600k+ LOC nightmare |
| Security | Average Claude Code usage | Nightmare |
| Cost Efficiency | Efficient usage | Nightmare |
| Memory | Uses Claude internal memory system + `CLAUDE.md` | Nightmare |

## Getting Started in 5 Minutes

```bash
/plugin marketplace add olamni-research/OlaClaw
/plugin install olaclaw@olaclaw
```
Then open a Claude Code session and run:
```
/olaclaw:start
```
The setup wizard walks you through model, heartbeat, Telegram, Discord, and security, then your daemon is live with a web dashboard.


## Features

### Automation
- **Heartbeat:** Periodic check-ins with configurable intervals, quiet hours, and editable prompts.
- **Cron Jobs:** Timezone-aware schedules for repeating or one-time tasks with reliable execution.

### Communication
- **Telegram:** Text, image, and voice support.
- **Discord:** DMs, server mentions/replies, slash commands, voice messages, and image attachments.
- **Time Awareness:** Message time prefixes help the agent understand delays and daily patterns.

### Multi-Session Threads (Discord)
- **Independent Thread Sessions:** Each Discord thread gets its own Claude CLI session, fully isolated from the main channel.
- **Parallel Processing:** Thread conversations run concurrently — messages in different threads don't block each other.
- **Auto-Create:** First message in a new thread automatically bootstraps a fresh session. No setup needed.
- **Session Cleanup:** Thread sessions are automatically cleaned up when threads are deleted or archived.
- **Backward Compatible:** DMs and main channel messages continue using the global session.

See [docs/MULTI_SESSION.md](docs/MULTI_SESSION.md) for technical details.

### Reliability and Control
- **GLM Fallback:** Automatically continue with GLM models if your primary limit is reached.
- **Web Dashboard:** Manage jobs, monitor runs, and inspect logs in real time.
- **Security Levels:** Four access levels from read-only to full system access.
- **Model Selection:** Switch models based on your workload.

## FAQ

<details open>
  <summary><strong>Can OlaClaw do &lt;something&gt;?</strong></summary>
  <p>
    If Claude Code can do it, OlaClaw can do it too. OlaClaw adds cron jobs,
    heartbeats, and Telegram/Discord bridges on top. You can also give your OlaClaw new
    skills and teach it custom workflows.
  </p>
</details>


