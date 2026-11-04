# Releasing Murre

How a new version gets from your Mac to everyone's Murre.

## How it works

1. You run one command. It sets the new version, commits, and makes a tag such as `v0.2.0`.
2. You push. GitHub Actions sees the tag and builds Murre on a Mac in the cloud (about 15 to 30 minutes).
3. The build goes into a **draft** release on GitHub. Nobody sees it yet.
4. You download it, try it, and press **Publish**.
5. Every copy of Murre checks for updates on launch and once a day. It finds the new version and asks “Install and restart?”

The updater only trusts files signed with your private key. If someone swaps the file on GitHub, Murre refuses it.

## One-time setup

Do this once. Then each release is just the steps under “Every release”.

### 1. Make the signing key

In Terminal:

```bash
npm run tauri signer generate -- -w ~/.tauri/murre.key
```

It asks for a password. Pick one and save it in your password manager.

This makes two files:

- `~/.tauri/murre.key`: the **private key**. Never commit or share it.
- `~/.tauri/murre.key.pub`: the **public key**. Safe to share.

> Back up both the key file and the password. If you lose either, copies of Murre already out there can’t update any more. People would have to download a new build by hand.

### 2. Put the public key in the app

Copy the whole contents of `~/.tauri/murre.key.pub`:

```bash
cat ~/.tauri/murre.key.pub | pbcopy
```

In `src-tauri/tauri.conf.json`, replace `PASTE_PUBLIC_KEY_HERE` with it. Commit and push.

### 3. Give GitHub the private key

On GitHub, open the repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add two:

| Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | The whole contents of `~/.tauri/murre.key` (run `cat ~/.tauri/murre.key \| pbcopy`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password from step 1 |

GitHub keeps secrets hidden. Not even you can read them back.

### 4. Make the repo public

The updater downloads without signing in, so the releases have to be public. Repo → **Settings** → **General** → **Danger Zone** → **Change visibility**.

Before you do, check nothing private is committed. Anyone will be able to read the code and its history.

## Every release

### 1. Update the Companion, if it changed

If you changed anything in `murre-ae/`, bump its version in `murre-ae/package.json`, then build and sign it:

```bash
cd murre-ae && MURRE_ZXP_PASSWORD='any-password' npm run bundle:signed
```

The password is for the Companion's signing certificate. Any password works, because a new self-signed certificate is made on every signed build. It’s kept out of the repo, so the build stops with a message if you leave it out. It shows in the build output, so don’t reuse a password you care about.

Commit the new `src-tauri/companion-bundle/com.murre.cep.zxp`. The release build uses that file as it is.

### 2. Make the release

With everything committed:

```bash
npm run release -- 0.2.0 "Fixes the calendar swipe. Faster scans."
```

Use a version newer than the current one (it’s in `src-tauri/tauri.conf.json`). The text is what people see in the update dialog.

The script updates the version in `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, `package.json` and `package-lock.json`, commits, and tags. It doesn’t push.

### 3. Push

```bash
git push --follow-tags
```

VS Code’s Sync button doesn’t push tags by default, so use this command. (Or turn on `git.followTagsWhenSync` in VS Code settings.)

### 4. Watch the build

GitHub repo → **Actions** → **Release**. Green tick: done. Red cross: open it to see which step failed.

### 5. Try it, then publish

GitHub repo → **Releases**. The draft has:

- `Murre_0.2.0_aarch64.dmg`: what new people download
- `Murre.app.tar.gz` and its `.sig`: what the updater downloads
- `latest.json`: what the updater reads to learn there’s a new version

Download the `.dmg` and check it opens. Then press **Edit** → **Publish release**.

Copies of Murre see the update on their next launch, or straight away from **Murre → Check for updates…**.

## Version numbers

`MAJOR.MINOR.PATCH`, for example `0.2.0`:

- Fixes only: bump the last number (`0.2.0` → `0.2.1`)
- New features: bump the middle one (`0.2.1` → `0.3.0`)

The updater only offers a version that is higher than the one installed.

## When something goes wrong

- **“Tag doesn’t match version”**: the tag and the version in `tauri.conf.json` differ. Use `npm run release`, which sets both.
- **“The updater public key isn’t in tauri.conf.json yet”**: do one-time setup step 2.
- **Fails at the signing step**: check both secrets are set and the password is right.
- **Made a bad tag before pushing it**: `git tag -d v0.2.0`, then `git reset --hard HEAD~1` to undo the release commit.
- **Pushed a broken release but didn’t publish it**: delete the draft on GitHub, delete the tag (`git push --delete origin v0.2.0`), fix, and release a new version.
- **Published a broken release**: you can’t take back what people installed. Release a fixed, higher version as soon as you can.

## Building on your own Mac

`npm run tauri build` signs the update files too, so it needs the key:

```bash
TAURI_SIGNING_PRIVATE_KEY=~/.tauri/murre.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD='your password' npm run tauri build
```

`npm run tauri dev` doesn’t need it.

## Limits

- **Apple Silicon only.** Intel Macs can’t run these builds.
- **Not signed by Apple.** The app has an ad-hoc signature, so on first open macOS says it can’t check the app. People open it once from **System Settings → Privacy & Security → Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/Murre.app`. Updates installed by Murre itself shouldn’t show this, because they aren’t downloaded through a browser. Removing the warning needs a paid Apple Developer account ($99 a year) and notarization.
- **Builds made before this setup can’t update themselves.** Testers need to install one build from a release by hand. After that, updates arrive in the app.
