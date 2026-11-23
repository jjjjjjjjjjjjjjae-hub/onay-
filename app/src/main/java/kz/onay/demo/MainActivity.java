package kz.onay.demo;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final String RELEASE_API =
            "https://api.github.com/repos/jjjjjjjjjjjjjjae-hub/onay-/releases/latest";
    private static final String APK_ASSET_NAME = "ONAY-Demo.apk";

    private WebView web;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private File updateApkFile;
    private boolean waitingForInstallPermission = false;
    private ProgressDialog downloadDialog;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);

        web.setWebViewClient(new WebViewClient());
        web.loadUrl("file:///android_asset/index.html");
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        TextView demo = new TextView(this);
        demo.setText("DEMO • РЕСМИ ЕМЕС • ТӨЛЕМ ҚҰЖАТЫ ЕМЕС");
        demo.setTextColor(Color.WHITE);
        demo.setTextSize(11);
        demo.setGravity(Gravity.CENTER);
        demo.setPadding(8, 8, 8, 8);
        demo.setBackgroundColor(Color.rgb(160, 35, 35));
        FrameLayout.LayoutParams bannerParams = new FrameLayout.LayoutParams(
                -1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
        root.addView(demo, bannerParams);

        setContentView(root);
        checkForUpdates();
    }

    private void checkForUpdates() {
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(RELEASE_API);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(10000);
                connection.setRequestProperty("Accept", "application/vnd.github+json");
                connection.setRequestProperty("User-Agent", "ONAY-Demo-Android-Updater");

                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return;

                StringBuilder response = new StringBuilder();
                try (InputStream input = connection.getInputStream()) {
                    byte[] buffer = new byte[4096];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        response.append(new String(buffer, 0, count, "UTF-8"));
                    }
                }

                JSONObject release = new JSONObject(response.toString());
                String tag = release.optString("tag_name", "");
                long remoteVersion = versionFromTag(tag);
                long currentVersion = getInstalledVersionCode();
                if (remoteVersion <= currentVersion) return;

                JSONArray assets = release.optJSONArray("assets");
                if (assets == null) return;

                String downloadUrl = null;
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject asset = assets.optJSONObject(i);
                    if (asset != null && APK_ASSET_NAME.equals(asset.optString("name"))) {
                        downloadUrl = asset.optString("browser_download_url", null);
                        break;
                    }
                }
                if (downloadUrl == null || downloadUrl.trim().isEmpty()) return;

                final String assetUrl = downloadUrl;
                final String releaseName = release.optString("name", tag);
                mainHandler.post(() -> showUpdateDialog(releaseName, assetUrl));
            } catch (Exception ignored) {
                // Update checks are optional; the app remains usable offline.
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    private long versionFromTag(String tag) {
        Matcher matcher = Pattern.compile("(\\d+)$").matcher(tag == null ? "" : tag);
        if (!matcher.find()) return -1;
        try {
            return Long.parseLong(matcher.group(1));
        } catch (NumberFormatException ignored) {
            return -1;
        }
    }

    private long getInstalledVersionCode() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= 28) return info.getLongVersionCode();
            return info.versionCode;
        } catch (Exception ignored) {
            return 1;
        }
    }

    private void showUpdateDialog(String releaseName, String downloadUrl) {
        if (isFinishing() || isDestroyed()) return;
        new AlertDialog.Builder(this)
                .setTitle("Жаңа нұсқа қолжетімді")
                .setMessage(releaseName + " нұсқасы шықты. Қолданбаны жаңарту үшін APK жүктеліп, Android орнату терезесі ашылады.")
                .setPositiveButton("Жаңарту", (dialog, which) -> downloadUpdate(downloadUrl))
                .setNegativeButton("Кейін", null)
                .show();
    }

    private void downloadUpdate(String downloadUrl) {
        downloadDialog = new ProgressDialog(this);
        downloadDialog.setTitle("Жаңарту жүктелуде");
        downloadDialog.setMessage("Жүктелуде...");
        downloadDialog.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        downloadDialog.setIndeterminate(true);
        downloadDialog.setCancelable(false);
        downloadDialog.show();

        new Thread(() -> {
            HttpURLConnection connection = null;
            File partFile = new File(getCacheDir(), "ONAY-Demo-update.apk.part");
            updateApkFile = new File(getCacheDir(), "ONAY-Demo-update.apk");
            try {
                URL url = new URL(downloadUrl);
                connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setRequestProperty("User-Agent", "ONAY-Demo-Android-Updater");
                connection.connect();

                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    throw new IllegalStateException("Жүктеу қатесі: HTTP " + status);
                }

                long totalBytes = connection.getContentLengthLong();
                long downloadedBytes = 0;
                try (InputStream input = connection.getInputStream();
                     FileOutputStream output = new FileOutputStream(partFile)) {
                    byte[] buffer = new byte[16 * 1024];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        output.write(buffer, 0, count);
                        downloadedBytes += count;
                        if (totalBytes > 0) {
                            final int percent = (int) Math.min(100, downloadedBytes * 100 / totalBytes);
                            mainHandler.post(() -> {
                                if (downloadDialog != null) {
                                    downloadDialog.setIndeterminate(false);
                                    downloadDialog.setMax(100);
                                    downloadDialog.setProgress(percent);
                                }
                            });
                        }
                    }
                }

                if (partFile.length() < 100_000) {
                    throw new IllegalStateException("Жүктелген APK файлы жарамсыз.");
                }
                if (updateApkFile.exists() && !updateApkFile.delete()) {
                    throw new IllegalStateException("Ескі уақытша файлды өшіру мүмкін болмады.");
                }
                if (!partFile.renameTo(updateApkFile)) {
                    throw new IllegalStateException("APK файлын дайындау мүмкін болмады.");
                }

                mainHandler.post(() -> {
                    closeDownloadDialog();
                    installDownloadedUpdate();
                });
            } catch (Exception error) {
                partFile.delete();
                mainHandler.post(() -> {
                    closeDownloadDialog();
                    new AlertDialog.Builder(this)
                            .setTitle("Жаңарту орындалмады")
                            .setMessage(error.getMessage() == null
                                    ? "Интернетті тексеріп, кейін қайталап көр."
                                    : error.getMessage())
                            .setPositiveButton("Жарайды", null)
                            .show();
                });
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    private void closeDownloadDialog() {
        if (downloadDialog != null && downloadDialog.isShowing()) {
            downloadDialog.dismiss();
        }
        downloadDialog = null;
    }

    private void installDownloadedUpdate() {
        if (updateApkFile == null || !updateApkFile.exists()) {
            Toast.makeText(this, "Жаңарту файлы табылмады.", Toast.LENGTH_LONG).show();
            return;
        }

        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            waitingForInstallPermission = true;
            new AlertDialog.Builder(this)
                    .setTitle("Орнатуға рұқсат керек")
                    .setMessage("Android баптауынан ONAY Demo қолданбасына осы көзден орнатуға рұқсат бер. Содан кейін орнату терезесі ашылады.")
                    .setPositiveButton("Баптауларды ашу", (dialog, which) -> {
                        Intent settingsIntent = new Intent(
                                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + getPackageName()));
                        startActivity(settingsIntent);
                    })
                    .setNegativeButton("Кейін", (dialog, which) -> waitingForInstallPermission = false)
                    .show();
            return;
        }

        try {
            Uri apkUri = FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", updateApkFile);
            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(installIntent);
        } catch (Exception error) {
            Toast.makeText(this, "Орнату терезесін ашу мүмкін болмады.", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (waitingForInstallPermission && Build.VERSION.SDK_INT >= 26
                && getPackageManager().canRequestPackageInstalls()) {
            waitingForInstallPermission = false;
            installDownloadedUpdate();
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        closeDownloadDialog();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
