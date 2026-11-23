# Android release signing (ONAY Demo)

The single Android build and release workflow is
`.github/workflows/build-android.yml`.

## Required repository secrets

Add these under **Settings → Secrets and variables → Actions**:

- `ONAY_KEYSTORE_BASE64`: Base64 text of the permanent release JKS file
- `ONAY_KEYSTORE_PASSWORD`: keystore password
- `ONAY_KEY_ALIAS`: `onay-demo`
- `ONAY_KEY_PASSWORD`: key password

On Windows PowerShell, copy the Base64 value to the clipboard:

```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("$HOME\Downloads\ONAY-DEMO-RELEASE.jks")
) | Set-Clipboard
```

Never commit the JKS file, its passwords, or its Base64 contents. Keep a secure backup of the original keystore. Losing it means future APKs cannot be signed as updates to the already-installed app.

## Build and publish

After all four secrets are set, run **Actions → Build Android APK → Run workflow**.
The workflow:

1. Copies the current HTML page and launcher icon into Android assets.
2. Builds the APK with Java 17 and Android SDK 35.
3. Verifies the APK signature.
4. Uploads `ONAY-Demo.apk` as a 30-day workflow artifact and publishes it in a GitHub Release.

The workflow uses the same number for Android `versionCode` and the `v1.0.N` release tag. This is required by the in-app updater.

The first permanent-key build must replace any earlier debug-signed build: uninstall the debug build once, then install the signed APK. Later releases must keep the same `applicationId` (`kz.onay.demo`) and the same keystore, and must have a higher `versionCode`. Android still requires the user to confirm each installation.
