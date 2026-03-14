# skillapp Release Checklist

Use this checklist before running `npm publish` to confirm the npm package contents, runtime behavior, and sensitive-data boundaries are ready for release.

## Scope

- Publish the `skillapp` npm CLI package
- Generate a publicly installable npm tarball
- Verify that the `runtime/` directory is suitable for distribution

## Required Checks Before Release

### 1. Confirm Version and Package Name

Check [package.json](/Users/yava/myspace/finpeak/skill-pack/package.json):

- `name` matches the intended package name
- `version` has been incremented
- `bin.skillapp` points to `dist/cli.js`
- `license`, `repository`, `bugs`, and `homepage` are correct

Useful command:

```bash
node -p "const p=require('./package.json'); ({name:p.name, version:p.version, bin:p.bin})"
```

### 2. Confirm Build Artifacts

```bash
npm run check
npm run build
```

Pass criteria:

- TypeScript completes without errors
- `dist/cli.js` is generated successfully

### 3. Inspect Published Package Contents

Always inspect one dry run before publishing:

```bash
npm pack --dry-run
```

Make sure the tarball:

- Includes `dist/`
- Includes `runtime/`
- Includes `README.md` and `LICENSE`
- Does not include `src/`, `docs/`, or `output/`
- Does not include `runtime/server/node_modules/`
- Does not include log files or local build artifacts

If the dry run is wrong, fix `.npmignore`, the `files` field, or leftover workspace artifacts before continuing.

### 4. Check for Sensitive Data

Scan the current workspace first:

```bash
rg -n --hidden -S "(OPENAI_API_KEY|API_KEY|SECRET|TOKEN|sk-[A-Za-z0-9_-]{20,}|BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY|aws_access_key_id|aws_secret_access_key)"
```

Confirm that:

- No repository file contains a hard-coded API key
- No `.env` files, logs, or debug outputs are packaged
- No example configuration includes real credentials

To inspect Git history as well, optionally run:

```bash
gitleaks detect .
```

Or:

```bash
trufflehog git file://$(pwd)
```

### 5. Verify Runtime Security Defaults

Confirm that the runtime server listens only on localhost by default:

- [runtime/server/index.js](/Users/yava/myspace/finpeak/skill-pack/runtime/server/index.js) should default to `127.0.0.1`
- Documentation should state that API keys are only stored in runtime memory on the local machine

Review the launcher scripts:

- [runtime/scripts/start.sh](/Users/yava/myspace/finpeak/skill-pack/runtime/scripts/start.sh)
- [runtime/scripts/start.bat](/Users/yava/myspace/finpeak/skill-pack/runtime/scripts/start.bat)

They should install dependencies with a lockfile-backed command so users get reproducible results.

### 6. Run a Real Install Smoke Test

Test in a clean directory:

```bash
npm pack
mkdir -p /tmp/skillapp-smoke
cd /tmp/skillapp-smoke
npm init -y
npm install /Users/yava/myspace/finpeak/skill-pack/skillapp-*.tgz
npx skillapp --version
```

Confirm that:

- The CLI runs
- The `create` and `build` commands start successfully
- Generated zip files include `runtime/` and the launcher scripts correctly

## Recommended Release Flow

Run:

```bash
npm run verify-release
npm publish
```

`verify-release` should run:

```bash
npm run check && npm run build && npm pack --dry-run
```

## Post-Release Verification

After publishing, verify at least once:

```bash
npm view skillapp version
npx skillapp --version
```

For a first release, also verify:

- The npm page renders the README correctly
- `npx skillapp create` launches normally
- The package does not include unexpectedly large directories

## Notes

- The Git repository does not need to be public; `npm publish` can run from a private repo or a local workspace.
- If you want to improve external trust, publishing the repository with an issues page and clear README examples is still recommended.
