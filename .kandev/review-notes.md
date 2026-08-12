# Review notes

These notes cover **both** PRs on `feature/per-workspace-notes-ac1`: this plugin
repo (`yattdev/kandev-plugin-notes`) and the host repo (`yattdev/kandev`). They
live here because `kandev-source` gitignores `/.kandev/` by design, so the file
cannot be committed there — fold the entry below into the host PR description
as well as this one.

## Follow-up tasks created (out of scope for these PRs)

- **Plugin webhooks are reachable without authentication** (task
  `9d9ed505-12fe-405f-8efb-32b50c58593b`, opened against `kdlbs/kandev`) —
  host file `apps/backend/internal/auth/httpmw/middleware.go:120`. The auth
  allowlist exempts every `/api/plugins/*/webhooks/*` path on the rationale that
  "the plugin subprocess owns signature validation". This plugin's `enhance`
  webhook performs no signature validation, so on an auth-enabled instance an
  unauthenticated POST reaches it and can drive a utility-agent invocation.
  Confirmed live over HTTP during QA.

  Pre-existing and **not introduced by this branch** — the allowlist entry was
  added in host commit `919a39e49a` (2026-07-25) by João Salavisa; the
  surrounding block was last touched in `5f99e0fd9d` by Alassane. Observed on
  `feature/per-workspace-notes-ac1` at plugin `777992c` / host `0f8c8f4cb`. The
  author reviewed it this cycle and decided to ship as-is and track it
  separately, so nothing on either branch changes for it.

## Action required by author

- The follow-up task above is in state `FAILED`, not parked in Backlogs as
  intended: an agent auto-started on it at 05:26 UTC on 2026-08-12 and its
  session died on a workspace bootstrap error (`mise ERROR ... Config files in
  /data/tasks/plugin-webhooks-are_gp4sb4ll/kdlbs-kandev/mise.toml are not
  trusted` → `failed to initialize ACP: context canceled`). The failure is
  environmental and unrelated to either branch's code, but the task will not
  read as a clean open backlog item until it is reset.
