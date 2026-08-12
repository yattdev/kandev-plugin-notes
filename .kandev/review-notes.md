# Review notes

These notes cover **both** PRs on `feature/per-workspace-notes-ac1`: this plugin
repo (`yattdev/kandev-plugin-notes`) and the host repo (`yattdev/kandev`). They
live here because `kandev-source` gitignores `/.kandev/` by design, so the file
cannot be committed there — fold the entry below into the host PR description
as well as this one.

## Known issue found during review (out of scope for these PRs)

- **Plugin webhooks are reachable without authentication** — tracked in task
  `51781b28-0580-48e7-ac31-a732b07e3ddb`.
  Host file `apps/backend/internal/auth/httpmw/middleware.go:120`. The auth
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

- **Confirm the webhook finding's tracking task is the one you want to keep.**
  It now lives in task `51781b28-0580-48e7-ac31-a732b07e3ddb`, which carries the
  full repro, the cause, and three suggested remedies. An earlier task for the
  same finding was opened and then deleted mid-cycle, so if this one is closed
  without action too, this PR description becomes its only surviving record.

- **Release trigger matters for this branch.** `manifest.yaml` and `Makefile`
  are hand-set to `0.3.0` and `CHANGELOG.md` carries a hand-written
  `## [0.3.0]` section, which is correct for the tag-push path only: push
  `v0.3.0` and `.github/workflows/release.yml` skips its `prepare` job and
  publishes 0.3.0 straight from this metadata. Dispatching the same workflow
  manually instead computes `max(manifest, latest tag)` and then bumps past it,
  so the default `patch` choice would publish **0.3.1**, rewrite the version in
  `manifest.yaml`, `Makefile` and the `README.md` tarball name, and prepend a
  generated `## [0.3.1]` section above the hand-written
  `## [0.3.0]` one, leaving two changelog entries for one set of changes and no
  0.3.0 release. Push the tag.
