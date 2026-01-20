 have completed the configuration for both the local environment and GitHub Actions CI.

Summary of Changes:

Package Correction:
Use @jkang1643/caption-engine in frontend/package.json, frontend/.npmrc, and ListenerPage.jsx.
CI / GitHub Actions:
Modified deploy-frontend.yml and lint.yml to include the Configure npm for GitHub Packages step.
This step sets up ~/.npmrc on the CI runner using the NPM_TOKEN secret.
Next Steps for You:

Local Install:
bash
cd frontend
npm install
(Ensure your local ~/.npmrc has the auth token for npm.pkg.github.com and always-auth=true if needed).
GitHub Secrets:
Go to your web repo settings on GitHub.
Add a new Repository Secret: NPM_TOKEN (Value: your PAT with read:packages scope).
Test Feature Flag:
To test the new engine locally, set VITE_USE_SHARED_ENGINE=true in frontend/.env.
Watch the console logs for [ListenerPage] Initializing Shared Engine.
Commit & Push:
Once verified, you can commit all changes and push. The CI should now pass.
deploy-frontend.yml
Open
lint.yml
Open
Good
Bad

Yes — **a couple things can change in prod**, and it depends on **how you build/deploy the frontend**.

If your prod server **builds the frontend** (runs `npm ci && npm run build` on the server), then you **must** handle GitHub Packages auth in prod/CI.
If you build elsewhere (CI) and only upload `dist/` to prod, then prod **doesn’t need npm or .npmrc at all**.

## Decide which deployment model you’re using

### Model A (recommended): Build in CI, deploy static `dist/`

**Prod changes:** basically none.

* Prod server just hosts built assets (S3/CloudFront, Nginx static, etc.)
* No `.npmrc` needed on the prod server
* No tokens on prod server

✅ This is the cleanest and safest.

### Model B: Build on prod server

**Prod changes:** you must add GitHub Packages config + token on the server.

* `.npmrc` must exist in the build environment
* You need `NPM_TOKEN` (read:packages) available during install
* CI/build logs must not leak tokens

---

## What you need for prod/CI if using GitHub Packages

### 1) `.npmrc` in the repo (safe to commit)

Keep only the registry mapping (no token):

```ini
@jkang1643:registry=https://npm.pkg.github.com
always-auth=true
```

✅ Safe to commit.

### 2) Token injection (never commit)

On the **build machine** (CI runner or prod server), inject:

* environment variable: `NPM_TOKEN`
* and write token into npm config at build time, e.g.:

```bash
echo "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}" >> ~/.npmrc
```

### 3) If you use GitHub Actions for prod build

Add a step (before `npm ci`) like:

```yaml
- name: Configure npm for GitHub Packages
  run: |
    echo "@jkang1643:registry=https://npm.pkg.github.com" >> ~/.npmrc
    echo "//npm.pkg.github.com/:_authToken=${{ secrets.NPM_TOKEN }}" >> ~/.npmrc
    echo "always-auth=true" >> ~/.npmrc
```

And store `NPM_TOKEN` in repo secrets (PAT with `read:packages`, plus `repo` if private).

---

## Files you might need to edit for prod

### ✅ `.env` / runtime config

Make sure your prod build uses correct values:

* `VITE_USE_SHARED_ENGINE` (probably leave **false** until fully verified, then set **true**)
* `VITE_API_URL`, `VITE_WS_URL` (prod endpoints)

**Important:** Vite env vars are **build-time**. Changing `.env` on the server after build won’t change the already-built JS.

### ✅ Dependency scope

If you switched to `@jkang1643/caption-engine`, ensure:

* `frontend/.npmrc` matches `@jkang1643`
* `frontend/package.json` depends on `@jkang1643/caption-engine`

### ✅ Lockfile

Commit the updated `package-lock.json` after successful install so CI/prod builds are deterministic.

---

## What does *not* change in prod

* The engine is bundled into your frontend build like any other dependency.
* At runtime, users’ browsers do not fetch from GitHub Packages.
* `.npmrc` is only relevant during `npm install`.

---

## Quick “prod readiness” checklist

* [ ] Frontend build happens in CI (preferred) OR token is available on prod build host
* [ ] `frontend/.npmrc` uses correct scope (`@jkang1643`)
* [ ] `NPM_TOKEN` configured in CI/prod (only if building there)
* [ ] `VITE_USE_SHARED_ENGINE` set intentionally (false until you flip it)
* [ ] `VITE_API_URL` and `VITE_WS_URL` point to prod
* [ ] `package-lock.json` committed

---

If you tell me how you deploy your frontend today (S3/CloudFront via GitHub Actions? EC2 Nginx? Vercel?), I’ll give you the exact minimal changes for that pipeline so you don’t over-configure anything.
