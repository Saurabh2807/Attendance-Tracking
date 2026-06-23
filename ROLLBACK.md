# AttendEase Rollback and Recovery Instructions

This document provides step-by-step instructions on how to restore the project back to the stable checkpoint created on 2026-06-23.

## Checkpoint Information
- **Stable Backup Branch**: `backup/stable-version`
- **Stable Git Tag**: `v1.0-stable`
- **Backup Commit SHA**: `e72c631979b2f07be67877f3c195cb549fd0d845` (base codebase state)

---

## 1. How to Restore the Backup Branch

To discard current changes and restore the state of the repository to the `backup/stable-version` branch:

```bash
# 1. Fetch all updates from the remote repository
git fetch origin

# 2. Reset the current branch (e.g. main) to match the backup branch exactly
git reset --hard origin/backup/stable-version

# 3. Force push the reset branch to origin (if you need to update the remote main branch)
# WARNING: This overwrites history on origin/main!
git push origin main --force
```

---

## 2. How to Restore the Tagged Version (`v1.0-stable`)

To checkout the code at the exact tag `v1.0-stable`:

```bash
# 1. Checkout the tag as a detached HEAD (view-only or read-only mode)
git checkout tags/v1.0-stable

# 2. If you want to create a new active branch starting from this tag
git checkout -b restore/stable-version tags/v1.0-stable
```

To reset your current branch (e.g., `main`) to the tag `v1.0-stable`:

```bash
# 1. Reset your local branch
git reset --hard v1.0-stable

# 2. Force push the change to remote
git push origin main --force
```

---

## 3. General Recovery Commands

### Discarding Uncommitted Local Changes
If you have edited files but have not committed them, and want to discard all local modifications:
```bash
# Discard changes to existing tracked files
git restore .

# Discard all changes including untracked files/directories
git clean -fd
```

### Undoing the Last Commit (Before Pushing)
```bash
# Keep changes in working directory (soft reset)
git reset --soft HEAD~1

# Discard changes completely (hard reset)
git reset --hard HEAD~1
```

---

## 4. Deployment Rollback Instructions

### Frontend (GitHub Pages / Static Hosting)
Since the frontend is deployed to GitHub Pages, pushing a rolled-back commit/branch to the `main` branch will automatically trigger the GitHub Actions workflow to rebuild and deploy the older stable code.
1. Perform the Git restore using the Git restore instructions above.
2. Push or force-push the restored commit to `main`.
3. Check the **GitHub Actions** tab in the repository to verify that the build and deploy pipeline completes successfully.

### Sync Service (Railway)
If the backend `sync-service` needs to be rolled back to the stable state:
1. Since Railway is connected to the GitHub repository, it automatically redeploys when commits are pushed to the target branch (e.g., `main`).
2. If you force-push the rollback to `main`, Railway will trigger a new deployment for that commit.
3. Alternatively, you can log into the **Railway Dashboard** (https://railway.app):
   - Select your **Attendance-Tracking** project.
   - Select the `sync-service` service.
   - Go to the **Deployments** tab.
   - Find the deployment corresponding to the backup commit (`e72c631979b2f07be67877f3c195cb549fd0d845` or older stable commits).
   - Click the **three dots (...)** next to it and select **Redeploy** or **Rollback** to set it as active.
