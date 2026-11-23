# Android release signing (ONAY Demo)

The Android release workflow is `.github/workflows/android-release.yml`.

Before running it, add these **repository Actions secrets** under
Settings → Secrets and variables → Actions:

- `ONAY_KEYSTORE_BASE64`: Base64 text of the release JKS file
- `ONAY_KEYSTORE_PASSWORD`: keystore password
- `ONAY_KEY_ALIAS`: `onay-demo`
- `ONAY_KEY_PASSWORD`: key password

Do not commit the JKS file, passwords, or Base64 keystore contents.

On Windows PowerShell, create the Base64 value with:

```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("$HOME\Downloads\ONAY-DEMO-RELEASE.jks")
) | Set-Clipboard
```

The workflow builds a signed release APK on pushes to `main` and on manual
dispatch, verifies the APK signature, and publishes it as
`ONAY-Demo.apk` in a GitHub Release.

**Important:** the first install signed with this permanent key must replace
any prior debug-signed build (uninstall the debug build first). Later releases
must keep the same applicationId (`kz.onay.demo`) and keystore, and increase
versionCode. Android still requires the user to confirm installation.
