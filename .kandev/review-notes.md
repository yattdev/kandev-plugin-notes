# Review notes

These notes cover **both** PRs on `feature/per-workspace-notes-ac1`: this plugin
repo (`yattdev/kandev-plugin-notes`) and the host repo (`yattdev/kandev`). They
live here because `kandev-source` gitignores `/.kandev/` by design, so the file
cannot be committed there — fold the entry below into the host PR description
as well as this one.

## Known issue found during review (out of scope for these PRs)

- **A pre-existing authentication weakness in the host's plugin-webhook
  routing.** Confirmed live during QA. Location, mechanism, reproduction, blame,
  and three suggested remedies are recorded in task
  `51781b28-0580-48e7-ac31-a732b07e3ddb`.

  The specifics are deliberately withheld here. `kdlbs/kandev`,
  `yattdev/kandev` and this repo are all public and the issue is unpatched
  upstream, so a PR description is both the wrong place to publish it and the
  wrong channel to notify the blamed author through. Route it upstream
  privately — a GitHub security advisory on `kdlbs/kandev`, or a direct message
  to the maintainers — rather than by @-mentioning anyone in this PR.

  Pre-existing and **not introduced by this branch**; the code it lives in is
  untouched by either PR. Observed on `feature/per-workspace-notes-ac1` at
  plugin `777992c` / host `0f8c8f4cb`. The author reviewed it this cycle and
  decided to ship as-is and track it separately, so nothing on either branch
  changes for it.

## Action required by author

- **Confirm the webhook finding's tracking task is the one you want to keep.**
  It now lives in task `51781b28-0580-48e7-ac31-a732b07e3ddb`, which carries the
  full repro, the cause, and three suggested remedies. An earlier task for the
  same finding was opened and then deleted mid-cycle. Because the detail is now
  deliberately kept out of this PR text, that task is the **only** record of it
  — if it is closed without action, nothing preserves the finding.

- **Veto QA's redaction if you disagree with it.** QA removed the file, line,
  mechanism and blame attribution from the entry above because all three repos
  are public and the issue is unpatched upstream. That was QA's call, not a
  decision you made — if you would rather the PR carry the full description,
  revert that hunk; nothing else in the entry changed.

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
