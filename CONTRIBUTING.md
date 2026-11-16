# Contributing

Issues and pull requests are welcome. The project's principle is **a dependency-free shell with predictable behavior**, so please read the conventions below first.

## Development environment

- Windows 10/11 x64
- Node.js >= 20
- `npm install && npm start`

## Before you submit

```powershell
npm test          # Plain Node unit tests + engine pipeline tests (no network, no VM needed)
```

For UI changes, also take a smoke screenshot to make sure the layout hasn't collapsed (check both English and Arabic/RTL):

```powershell
electron . --smoke test\shot.png
```

## Code conventions

- **The shell adds no third-party runtime dependencies.** The ZIP / AXML / ARSC / PNG / ICO parsers in `src/core/` are hand-written;
  for new features, first ask "can this be done with Node's built-in modules?" rather than pulling in a big package for a small feature.
- The renderer is plain HTML/CSS/JS, no front-end framework.
- All interaction with Android goes through `src/core/adb.js`; don't build adb commands ad hoc elsewhere.
- Main and renderer processes talk only through the allow-listed channels exposed by `preload.js`; keep `contextIsolation` on.
- Comments and identifiers are in English. User-facing text is written in English and wrapped in `t()`
  (see `src/i18n/index.js`), with an Arabic entry in `src/i18n/ar/*.json` keyed by the exact English string.

## Test conventions

- Without a real APK, the APK parsing tests are skipped automatically; to cover them, point an environment variable at any APK:

```powershell
$env:APKSTART_TEST_APK="C:\path\to\any.apk"; npm test
```

- Don't access the internet in tests. Tests that need network behavior should start a local `http` server (see `test/engine-test.js`).

## Commit messages

Use the Conventional Commits style, for example:

```
feat(engine): support importing a qcow2 disk from a custom path
fix(axml): correct the attribute table base offset
docs: explain how to enable WHPX
```

## Legal and scope

- This project doesn't distribute any Android system image, QEMU binary or Google component; they are all downloaded on the user's machine as needed.
- Don't commit commercial APKs, cracking tools, or anything that infringes third-party copyright.
