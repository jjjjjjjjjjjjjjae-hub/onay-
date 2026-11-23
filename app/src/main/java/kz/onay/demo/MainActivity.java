package kz.onay.demo;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.util.Base64;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
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
    private static final int CAMERA_PERMISSION_REQUEST = 702;
    private static final int FILE_CHOOSER_REQUEST = 703;
    private static final int NATIVE_QR_CAMERA_REQUEST = 704;
    private static final String APP_ASSET_HOST = "appassets.androidplatform.net";

    private WebView web;
    private WebViewAssetLoader assetLoader;
    private PermissionRequest pendingWebPermissionRequest;
    private ValueCallback<Uri[]> pendingFileChooserCallback;
    private Uri pendingCameraUri;
    private File pendingCameraFile;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private File updateApkFile;
    private File nativeQrCameraFile;
    private Uri nativeQrCameraUri;
    private boolean nativeQrCameraInProgress = false;
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
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Load the bundled page from a secure local HTTPS origin so getUserMedia works.
        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClientCompat() {
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (url != null && url.startsWith("https://" + APP_ASSET_HOST + "/assets/")) {
                    installNativeCameraCallbacks(view);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleWebCameraPermission(request));
            }

            @Override
            public boolean onShowFileChooser(WebView view,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {
                return handleWebFileChooser(filePathCallback, fileChooserParams);
            }
        });

        web.loadUrl("https://" + APP_ASSET_HOST + "/assets/index.html");
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

    private void handleWebCameraPermission(PermissionRequest request) {
        if (request == null) return;

        boolean trustedOrigin = request.getOrigin() != null
                && APP_ASSET_HOST.equals(request.getOrigin().getHost());
        String[] resources = request.getResources();
        boolean videoOnly = resources != null && resources.length == 1
                && PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resources[0]);

        // Only this bundled demo page may request the native camera fallback.
        // Remote pages and microphone requests are always denied.
        if (!trustedOrigin || !videoOnly) {
            request.deny();
            return;
        }

        // The Android camera app handles the camera permission itself. We return
        // a captured photo to the bundled page, avoiding WebView getUserMedia
        // permission differences across Android/WebView versions.
        request.deny();
        launchNativeQrCamera();
    }

    private void installNativeCameraCallbacks(WebView view) {
        String script =
                "(function(){"
                + "if(window.__onayNativeCameraCallbacksInstalled)return;"
                + "window.__onayNativeCameraCallbacksInstalled=true;"
                + "window.onayNativeCameraError=function(message){"
                + "try{if(typeof cameraTabIsOpen==='function'&&cameraTabIsOpen())"
                + "qrCameraMessage(message||'Камера ашылмады. Қайталап көріңіз.');"
                + "else if(typeof familyScannerIsOpen==='function'&&familyScannerIsOpen())"
                + "familyCameraStatus(message||'Камера ашылмады. Қайталап көріңіз.');"
                + "}catch(e){console.warn(e);}};"
                + "window.onayNativeCameraPhoto=async function(dataUrl){"
                + "try{"
                + "const image=new Image();"
                + "image.onload=async function(){"
                + "try{"
                + "if(typeof familyScannerIsOpen==='function'&&familyScannerIsOpen()){"
                + "let detector=typeof prepareFamilyBarcodeDetector==='function'?"
                + "await prepareFamilyBarcodeDetector():null;"
                + "if(detector){"
                + "const codes=await detector.detect(image);"
                + "if(codes&&codes.length){"
                + "const code=codes[0];"
                + "const result=document.getElementById('family-scan-result');"
                + "if(result){result.hidden=false;result.textContent='Штрих-код оқылды: '+"
                + "(code.rawValue||'Код анықталды')+' ('+(code.format||'barcode')+')';}"
                + "if(typeof familyCameraStatus==='function')familyCameraStatus('Штрих-код сәтті оқылды.',false);"
                + "}else if(typeof familyCameraStatus==='function'){"
                + "familyCameraStatus('Штрих-код анықталмады. Камерамен жақынырақ түсіріп, қайта көріңіз.');}"
                + "return;}"
                + "}"
                + "const maxSide=1280,scale=Math.min(1,maxSide/Math.max(image.naturalWidth,image.naturalHeight));"
                + "const canvas=document.createElement('canvas');"
                + "canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));"
                + "canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));"
                + "const context=canvas.getContext('2d',{willReadFrequently:true});"
                + "context.drawImage(image,0,0,canvas.width,canvas.height);"
                + "const pixels=context.getImageData(0,0,canvas.width,canvas.height);"
                + "const decoded=window.jsQR?window.jsQR(pixels.data,canvas.width,canvas.height,{inversionAttempts:'attemptBoth'}):null;"
                + "if(typeof cameraTabIsOpen==='function'&&cameraTabIsOpen()){"
                + "if(decoded&&typeof parseOnayTransportCode==='function'){"
                + "const parsed=parseOnayTransportCode(decoded.data);"
                + "if(parsed&&typeof showTransportQrResult==='function'){showTransportQrResult(parsed,'scan');return;}}"
                + "if(typeof qrCameraMessage==='function')qrCameraMessage(decoded?'Бұл ONAY көлік QR-коды емес. Қайта түсіріңіз.':'QR-код табылмады. Телефон камерасымен кодты анық түсіріңіз.');"
                + "return;}"
                + "if(typeof familyScannerIsOpen==='function'&&familyScannerIsOpen()&&typeof familyCameraStatus==='function'){"
                + "familyCameraStatus(decoded?'QR-код табылды, бірақ штрих-код форматы сәйкес емес.':'Штрих-код табылмады. Қайта түсіріңіз.');return;}"
                + "}catch(error){console.warn('Native camera image decode:',error);"
                + "if(typeof cameraTabIsOpen==='function'&&cameraTabIsOpen())qrCameraMessage('Фотоны оқу мүмкін болмады. Қайта түсіріңіз.');"
                + "else if(typeof familyScannerIsOpen==='function'&&familyScannerIsOpen())familyCameraStatus('Фотоны оқу мүмкін болмады. Қайта түсіріңіз.');}"
                + "};"
                + "image.onerror=function(){window.onayNativeCameraError('Камера фотосын ашу мүмкін болмады.');};"
                + "image.src=dataUrl;"
                + "};"
                + "})();";
        view.evaluateJavascript(script, null);
    }

    private void launchNativeQrCamera() {
        if (nativeQrCameraInProgress || isFinishing() || isDestroyed()) return;
        Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (cameraIntent.resolveActivity(getPackageManager()) == null) {
            notifyNativeCameraError("Телефонда жергілікті камера қолданбасы табылмады.");
            return;
        }

        try {
            nativeQrCameraFile = File.createTempFile("onay-native-scan-", ".jpg", getCacheDir());
            nativeQrCameraUri = FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", nativeQrCameraFile);
            cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, nativeQrCameraUri);
            cameraIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            cameraIntent.setClipData(
                    android.content.ClipData.newRawUri("onay-native-scan", nativeQrCameraUri));
            nativeQrCameraInProgress = true;
            startActivityForResult(cameraIntent, NATIVE_QR_CAMERA_REQUEST);
        } catch (Exception error) {
            nativeQrCameraInProgress = false;
            deleteNativeQrCameraFile();
            notifyNativeCameraError("Жергілікті камераны ашу мүмкін болмады.");
        }
    }

    private void notifyNativeCameraError(String message) {
        if (web == null || isFinishing() || isDestroyed()) return;
        String quoted = JSONObject.quote(message);
        web.evaluateJavascript(
                "if(window.onayNativeCameraError)window.onayNativeCameraError(" + quoted + ");",
                null);
    }

    private String cameraFileAsDataUrl(File file) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IllegalStateException("Камера фотосының өлшемі оқылмады.");
        }

        int sample = 1;
        while (Math.max(bounds.outWidth / sample, bounds.outHeight / sample) > 1280) {
            sample *= 2;
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        if (bitmap == null) throw new IllegalStateException("Камера фотосын декодтау мүмкін болмады.");

        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            bitmap.compress(Bitmap.CompressFormat.JPEG, 84, output);
            return "data:image/jpeg;base64,"
                    + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
        } finally {
            bitmap.recycle();
        }
    }

    private void deliverNativeCameraPhoto() {
        if (web == null || nativeQrCameraFile == null || !nativeQrCameraFile.exists()
                || nativeQrCameraFile.length() == 0) {
            notifyNativeCameraError("Камерадан фото алынбады. Қайталап көріңіз.");
            return;
        }
        try {
            String dataUrl = cameraFileAsDataUrl(nativeQrCameraFile);
            web.evaluateJavascript(
                    "if(window.onayNativeCameraPhoto)window.onayNativeCameraPhoto("
                            + JSONObject.quote(dataUrl) + ");",
                    null);
        } catch (Exception error) {
            notifyNativeCameraError("Камера фотосын өңдеу мүмкін болмады.");
        } finally {
            deleteNativeQrCameraFile();
        }
    }

    private void deleteNativeQrCameraFile() {
        if (nativeQrCameraFile != null && nativeQrCameraFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            nativeQrCameraFile.delete();
        }
        nativeQrCameraFile = null;
        nativeQrCameraUri = null;
        nativeQrCameraInProgress = false;
    }

    private boolean handleWebFileChooser(ValueCallback<Uri[]> callback,
            WebChromeClient.FileChooserParams params) {
        if (pendingFileChooserCallback != null) {
            pendingFileChooserCallback.onReceiveValue(null);
        }

        pendingFileChooserCallback = callback;
        pendingCameraUri = null;
        pendingCameraFile = null;

        // For scanner/photo inputs, open the phone's native camera directly,
        // even when the HTML input forgot to include the capture attribute.
        if (shouldOpenNativeCamera(params)) {
            if (launchNativeCamera()) {
                return true;
            }
            return launchImagePicker();
        }

        return launchImagePicker();
    }

    private boolean shouldOpenNativeCamera(WebChromeClient.FileChooserParams params) {
        if (params == null) return false;
        if (params.isCaptureEnabled()) return true;

        String[] acceptTypes = params.getAcceptTypes();
        if (acceptTypes == null || acceptTypes.length == 0) return false;

        for (String acceptType : acceptTypes) {
            if (acceptType == null) continue;
            String type = acceptType.trim().toLowerCase(java.util.Locale.ROOT);
            if (type.startsWith("image/") || type.equals(".jpg")
                    || type.equals(".jpeg") || type.equals(".png")
                    || type.equals(".webp")) {
                return true;
            }
        }
        return false;
    }

    private boolean launchNativeCamera() {
        Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (cameraIntent.resolveActivity(getPackageManager()) == null) {
            Toast.makeText(this, "Телефоннан камера қолданбасы табылмады. Галерея ашылады.",
                    Toast.LENGTH_LONG).show();
            return false;
        }

        try {
            pendingCameraFile = File.createTempFile("onay-camera-", ".jpg", getCacheDir());
            pendingCameraUri = FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", pendingCameraFile);

            cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri);
            cameraIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            cameraIntent.setClipData(
                    android.content.ClipData.newRawUri("onay-camera-photo", pendingCameraUri));

            startActivityForResult(cameraIntent, FILE_CHOOSER_REQUEST);
            return true;
        } catch (Exception error) {
            deletePendingCameraFile();
            Toast.makeText(this, "Жергілікті камераны ашу мүмкін болмады. Галерея ашылады.",
                    Toast.LENGTH_LONG).show();
            return false;
        }
    }

    private boolean launchImagePicker() {
        try {
            Intent pickerIntent = new Intent(Intent.ACTION_GET_CONTENT);
            pickerIntent.addCategory(Intent.CATEGORY_OPENABLE);
            pickerIntent.setType("image/*");
            startActivityForResult(pickerIntent, FILE_CHOOSER_REQUEST);
            return true;
        } catch (Exception error) {
            finishFileChooser(null);
            Toast.makeText(this, "Камераны немесе галереяны ашу мүмкін болмады.",
                    Toast.LENGTH_LONG).show();
            return true;
        }
    }

    private void deletePendingCameraFile() {
        if (pendingCameraFile != null && pendingCameraFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            pendingCameraFile.delete();
        }
        pendingCameraUri = null;
        pendingCameraFile = null;
    }

    private void finishFileChooser(Uri[] results) {
        if (pendingFileChooserCallback != null) {
            pendingFileChooserCallback.onReceiveValue(results);
            pendingFileChooserCallback = null;
        }
        // Keep successful camera images in cache so WebView can read the returned URI.
        if (results == null || results.length == 0) {
            deletePendingCameraFile();
        } else {
            pendingCameraUri = null;
            pendingCameraFile = null;
        }
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == NATIVE_QR_CAMERA_REQUEST) {
            nativeQrCameraInProgress = false;
            if (resultCode == RESULT_OK && nativeQrCameraFile != null
                    && nativeQrCameraFile.exists() && nativeQrCameraFile.length() > 0) {
                deliverNativeCameraPhoto();
            } else {
                deleteNativeQrCameraFile();
                notifyNativeCameraError("Фото түсіру тоқтатылды. Сканерлеуді қайта бастауға болады.");
            }
            return;
        }

        if (requestCode != FILE_CHOOSER_REQUEST) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK) {
            if (pendingCameraUri != null && pendingCameraFile != null
                    && pendingCameraFile.exists() && pendingCameraFile.length() > 0) {
                results = new Uri[]{pendingCameraUri};
            } else if (data != null && data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        finishFileChooser(results);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_PERMISSION_REQUEST) return;

        PermissionRequest request = pendingWebPermissionRequest;
        pendingWebPermissionRequest = null;
        if (request == null) return;

        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        if (granted && request.getOrigin() != null
                && APP_ASSET_HOST.equals(request.getOrigin().getHost())) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            request.deny();
        }
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

                int totalBytes = connection.getContentLength();
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
        if (pendingWebPermissionRequest != null) {
            pendingWebPermissionRequest.deny();
            pendingWebPermissionRequest = null;
        }
        deleteNativeQrCameraFile();
        if (pendingFileChooserCallback != null) {
            pendingFileChooserCallback.onReceiveValue(null);
            pendingFileChooserCallback = null;
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
