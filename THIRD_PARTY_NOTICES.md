# Third-party notices

## Vendored TeXPage helpers

- Source: [dull-bird/opencli-plugin-texpage](https://github.com/dull-bird/opencli-plugin-texpage)
- Pinned revision: `a751f0d867c83079794513de00c4e740b4b0ae44`
- Local file: `scripts/vendor/texpage/utils.js`
- License: MIT, Copyright (c) 2026 dull-bird
- The original license is retained at [`scripts/vendor/texpage/LICENSE`](scripts/vendor/texpage/LICENSE).

Local adaptations add the pre-write original-text check, project-join and document-response validation, acknowledgment phase handling, Unicode-safe chunking, and warning-first log classification. See [`references/backends.md`](references/backends.md).

## Runtime dependencies

- [`claudeleaf@0.3.0`](https://github.com/lonetis/claudeleaf): MIT, Copyright (c) 2026 Louis Jannett. Used through its SDK for the Overleaf adapter.
- [`playwright-core@1.56.1`](https://github.com/microsoft/playwright): Apache-2.0. Used for installed-browser login and authenticated request contexts.

Dependency packages retain their own licenses. Exact direct and transitive versions, source URLs, integrity hashes and available license metadata are recorded in `package-lock.json`.

## Design reference

The CLI-backed skill organization was informed by [`aloth/overleaf-skill`](https://github.com/aloth/overleaf-skill). Its skill text is not copied into this repository.
