<!-- ai-collab:start -->
# Automatic model routing (ai-collab)

For normal project requests use the installed `ai-collab` skill
(`~/.claude/skills/ai-collab/SKILL.md`, Codex: `~/.codex/skills/ai-collab/SKILL.md`) and run its
`router.py --root <this project> dispatch --request-file <UTF-8 file under .orca-routing/>`
before implementation. `.orca-routing/runtime.json` (local, git-ignored) holds executable paths;
recreate it with `ai-workspace/setup/enable-project.ps1 -Project <this project>`.

A prompt marked `[ORCA_ROUTED:...]`, an Orca Task/Dispatch preamble, or a trivial question the
coordinator can answer directly is already assigned: do not route it again.
If a worker hits a usage limit, use the skill's `failover` (Claude <-> Codex) instead of stopping.
Project rules elsewhere in this file still apply to the executing agent.
<!-- ai-collab:end -->

# Shared workflow (all Orca workspaces)

This project runs in several Orca workspaces (git worktrees on separate branches) with both Claude
and Codex. Chats cannot see each other, and worktrees do not share uncommitted files. Keep them
connected through `main` and `docs/WORKLOG.md`:

1. Start: `git fetch origin` and bring your branch up to date with `origin/main`
   (fast-forward or rebase; stop and report on conflicts). Then read `docs/WORKLOG.md`.
2. Finish: commit only your own changes, push them to `main`, and add a line to the WORKLOG
   change log in the form `date [workspace] what changed`. Update its status and open items.
3. Rules every agent must follow (real-order ban, new-address-only, memo rule) are listed in the
   WORKLOG section "반드시 지킬 규칙". Claude's private memory is not visible to Codex.
4. The repository is public: never write secrets, recipient data, vendor contacts, or internal
   system URLs into tracked files.
