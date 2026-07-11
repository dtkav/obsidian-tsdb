# Contributing

TSDB is an Obsidian community plugin. The release artifact is the bundled plugin
loaded by Obsidian: `main.js`, `manifest.json`, and `styles.css`.

## Development Setup

Use npm and the Node.js LTS release.

```bash
npm install
npm run build:tsdb-wasm
npm run build
```

For watch builds:

```bash
npm run dev
```

## Checks

Run the local gates before opening a pull request or cutting a release:

```bash
npm run check
npm run check:no-node
npm test
npm run verify-release
```

`npm run release` runs the production build, tests, and release artifact
verification in one command.

## Obsidian Testing

For manual testing, copy the release artifacts into a vault plugin directory:

```text
<vault>/.obsidian/plugins/tsdb/
```

The required files are:

- `main.js`
- `manifest.json`
- `styles.css`

Reload Obsidian and enable **TSDB** in **Settings -> Community plugins**.

## Compatibility

The plugin must remain usable in Obsidian's renderer environment. Keep Node-only
APIs out of the browser/mobile path and run:

```bash
npm run check:no-node
```

The default storage backend is worker OPFS through `wa-sqlite`. Non-OPFS
storage paths are fallback/diagnostic paths and should not become the normal
desktop or mobile path.

## Releases

Release tags must exactly match `manifest.json` and `package.json`, with no
leading `v`.

1. Bump `package.json`, `package-lock.json`, `manifest.json`, and
   `versions.json`.
2. Run `npm run release`.
3. Commit the version bump.
4. Tag the release with the exact version, for example `1.0.13`.
5. Push `main` and the tag.

The GitHub release workflow builds from the tag, verifies that the tag matches
`manifest.json`, generates GitHub artifact attestations for `main.js`,
`styles.css`, and `manifest.json`, and uploads those files as release assets.

To verify a downloaded release asset attestation:

```bash
gh attestation verify main.js --repo dtkav/obsidian-tsdb
```

Release assets should not be edited by hand after publication. If a release
asset must be corrected, cut a new release so the uploaded assets and their
attestations are produced by the same workflow run.
