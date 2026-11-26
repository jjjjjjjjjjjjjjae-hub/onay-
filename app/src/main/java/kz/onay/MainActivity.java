package kz.onay;

import android.Manifest;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.fragment.app.FragmentActivity;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends FragmentActivity {
    private static final String RELEASE_API =
            "https://api.github.com/repos/jjjjjjjjjjjjjjae-hub/onay-/releases/latest";
    private static final String RELEASE_LATEST_APK_URL =
            "https://github.com/jjjjjjjjjjjjjjae-hub/onay-/releases/latest/download/ONAY-Demo.apk";
    private static final String APK_ASSET_NAME = "ONAY-Demo.apk";
    // Releases below this version are blocked until the user installs the
    // current signed APK. This prevents old local-account behavior from
    // continuing after the account reset migration.
    private static final long MINIMUM_SUPPORTED_VERSION_CODE = 84L;
    private static final String MINIMUM_SUPPORTED_VERSION_NAME = "1.0.84";
    private static final int CAMERA_PERMISSION_REQUEST = 702;
    private static final int FILE_CHOOSER_REQUEST = 703;
    private static final String APP_ASSET_HOST = "appassets.androidplatform.net";
    private static final String UPDATE_APK_FILE_NAME = "ONAY-Demo-update.apk";
    private static final String UPDATE_APK_PART_FILE_NAME = "ONAY-Demo-update.apk.part";
    private static final String SAFE_INSTALL_PACKAGE = "kz.safeinstall.app";

    private WebView web;
    private WebViewAssetLoader assetLoader;
    private PermissionRequest pendingWebPermissionRequest;
    private boolean cameraPermissionRequestInFlight = false;
    private ValueCallback<Uri[]> pendingFileChooserCallback;
    private Uri pendingCameraUri;
    private File pendingCameraFile;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private File updateApkFile;
    private ProgressDialog downloadDialog;
    private boolean updateCheckScheduled = false;
    private volatile boolean updateCheckInFlight = false;
    private volatile boolean updateCheckFinished = false;
    private boolean updatePromptShown = false;
    private final Object torchLock = new Object();
    private CameraManager cameraManager;
    private static final long EXIT_BACK_PRESS_WINDOW_MS = 2000L;
    private long lastBackPressAt = 0L;
    private boolean backDispatchInFlight = false;
    private String torchCameraId;
    private int safeBottomInsetPx;
    private static final long SPLASH_FIRST_STAGE_DURATION_MS = 1400L;
    private static final long SPLASH_MIN_DURATION_MS = 2500L;
    private View splashView;
    private View splashFirstStage;
    private View splashVersionStage;
    private View splashVersionPatch;
    private TextView splashVersionText;
    private long splashStartedAt;
    private boolean splashPageReady = false;
    private boolean splashVersionStageReady = false;
    private boolean splashDismissScheduled = false;
    private boolean splashDismissed = false;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);

        // Android 15 enforces edge-to-edge for this app's target SDK. Keep
        // every WebView screen below the system status bar and above the
        // navigation area, rather than trying to offset each header/button in
        // the HTML separately.
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets systemBars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());
            Insets navigationBars = insets.getInsets(
                    WindowInsetsCompat.Type.navigationBars());
            Insets systemGestures = insets.getInsets(
                    WindowInsetsCompat.Type.systemGestures());
            // Three-button navigation reports a navigation-bar inset, while
            // gesture navigation can report only a bottom system-gesture
            // inset. Use the larger value for the HTML safe-area variable.
            int safeBottom = Math.max(systemBars.bottom,
                    Math.max(navigationBars.bottom, systemGestures.bottom));
            safeBottomInsetPx = safeBottom;
            // Let the WebView draw the navigation panel into the system area;
            // the panel itself adds this inset as bottom padding so its icons
            // remain above the gesture handle or three-button bar.
            view.setPadding(systemBars.left, systemBars.top,
                    systemBars.right, 0);
            syncNativeBottomInset();
            return insets;
        });

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadsImagesAutomatically(true);
        settings.setBlockNetworkImage(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Keep the live camera preview on the accelerated WebView surface.
        web.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);
        web.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);

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
                    installFastCameraDefaults(view);
                    syncNativeBottomInset();
                    splashPageReady = true;
                    scheduleSplashDismissal();
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

        web.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void requestCameraPermission() {
                runOnUiThread(() -> requestCameraPermissionOnEntry());
            }

            @JavascriptInterface
            public boolean setTorch(boolean enabled) {
                return setTorchEnabled(enabled);
            }

            @JavascriptInterface
            public boolean isBiometricAvailable() {
                return canUseBiometric();
            }

            @JavascriptInterface
            public void authenticateBiometric() {
                runOnUiThread(MainActivity.this::authenticateWithBiometric);
            }
        }, "OnayNative");

        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        splashView = createSplashView();
        splashStartedAt = SystemClock.uptimeMillis();
        setSplashSystemBars(true);
        root.addView(splashView, new FrameLayout.LayoutParams(-1, -1));
        mainHandler.postDelayed(this::showSplashVersionStage,
                SPLASH_FIRST_STAGE_DURATION_MS);
        mainHandler.postDelayed(() -> {
            // Do not leave the user on the splash if a WebView callback is
            // interrupted by a device-specific startup issue.
            splashPageReady = true;
            scheduleSplashDismissal();
        }, 5000L);

        setContentView(root);
        ViewCompat.requestApplyInsets(root);
        web.loadUrl("https://" + APP_ASSET_HOST + "/assets/index.html");
        requestCameraPermissionOnEntry();
    }

    private View createSplashView() {
        FrameLayout splash = new FrameLayout(this);
        splash.setBackgroundColor(Color.rgb(255, 216, 0));
        splash.setClickable(true);

        ImageView firstReferenceImage = new ImageView(this);
        firstReferenceImage.setImageResource(R.drawable.onay_splash_reference);
        firstReferenceImage.setScaleType(ImageView.ScaleType.CENTER_CROP);
        splashFirstStage = firstReferenceImage;
        splash.addView(firstReferenceImage, new FrameLayout.LayoutParams(-1, -1));

        ImageView versionReferenceImage = new ImageView(this);
        versionReferenceImage.setImageResource(R.drawable.onay_splash_version_reference);
        versionReferenceImage.setScaleType(ImageView.ScaleType.CENTER_CROP);
        versionReferenceImage.setAlpha(0f);
        splashVersionStage = versionReferenceImage;
        splash.addView(versionReferenceImage, new FrameLayout.LayoutParams(-1, -1));

        // The supplied second reference image contains its sample version.
        // Cover the entire lower strip so the sample "v 3.6.5" embedded in
        // the supplied image can never show through on another screen size.
        View versionPatch = new View(this);
        versionPatch.setBackgroundColor(Color.rgb(255, 216, 0));
        versionPatch.setAlpha(0f);
        splashVersionPatch = versionPatch;
        FrameLayout.LayoutParams patchParams = new FrameLayout.LayoutParams(
                -1, dp(180), Gravity.BOTTOM);
        splash.addView(versionPatch, patchParams);

        TextView version = new TextView(this);
        version.setText("v " + getInstalledVersionName());
        version.setTextColor(Color.rgb(25, 25, 25));
        version.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        version.setGravity(Gravity.CENTER);
        version.setAlpha(0f);
        splashVersionText = version;
        FrameLayout.LayoutParams versionTextParams = new FrameLayout.LayoutParams(
                dp(82), dp(30), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        versionTextParams.bottomMargin = dp(42);
        splash.addView(version, versionTextParams);
        return splash;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String getInstalledVersionName() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null || info.versionName.trim().isEmpty()
                    ? "1.0" : info.versionName;
        } catch (Exception ignored) {
            return "1.0";
        }
    }

    private void setSplashSystemBars(boolean splashVisible) {
        // Keep the system/status bars white. The supplied yellow image is
        // shown only inside the branded content area below the system UI.
        int barColor = Color.WHITE;
        getWindow().setStatusBarColor(barColor);
        getWindow().setNavigationBarColor(barColor);
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    private void showSplashVersionStage() {
        if (splashVersionStageReady || splashDismissed) return;
        splashVersionStageReady = true;
        if (splashVersionPatch != null) splashVersionPatch.setAlpha(1f);
        if (splashVersionStage != null) {
            splashVersionStage.animate().alpha(1f).setDuration(180L).start();
        }
        if (splashFirstStage != null) {
            splashFirstStage.animate().alpha(0f).setDuration(180L).start();
        }
        if (splashVersionText != null) {
            splashVersionText.animate().alpha(1f).setDuration(120L).start();
        }
        scheduleSplashDismissal();
    }

    private void scheduleSplashDismissal() {
        if (!splashPageReady || !splashVersionStageReady || splashView == null || splashDismissed
                || splashDismissScheduled) return;
        long remaining = splashStartedAt + SPLASH_MIN_DURATION_MS
                - SystemClock.uptimeMillis();
        if (remaining > 0) {
            splashDismissScheduled = true;
            mainHandler.postDelayed(() -> {
                splashDismissScheduled = false;
                scheduleSplashDismissal();
            }, remaining);
            return;
        }

        splashDismissed = true;
        View view = splashView;
        view.animate().alpha(0f).setDuration(180L).withEndAction(() -> {
            if (view.getParent() instanceof ViewGroup) {
                ((ViewGroup) view.getParent()).removeView(view);
            }
            if (splashView == view) splashView = null;
            setSplashSystemBars(false);
        }).start();
    }

    private void syncNativeBottomInset() {
        if (web == null) return;
        float density = getResources().getDisplayMetrics().density;
        int cssInset = Math.max(0, Math.round(safeBottomInsetPx / density));
        String script = "document.documentElement.style.setProperty('--onay-native-bottom-inset','"
                + cssInset + "px')";
        web.evaluateJavascript(script, null);
    }

    private int getAllowedAuthenticators() {
        int authenticators = BiometricManager.Authenticators.BIOMETRIC_WEAK;
        // Android 9+ can also use the phone's PIN, pattern, or password.
        // Older Android versions keep the biometric-only path for compatibility.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            authenticators |= BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        }
        return authenticators;
    }

    private boolean canUseBiometric() {
        return BiometricManager.from(this).canAuthenticate(getAllowedAuthenticators())
                == BiometricManager.BIOMETRIC_SUCCESS;
    }

    private void authenticateWithBiometric() {
        if (!canUseBiometric()) {
            dispatchBiometricResult(false,
                    "Телефонда саусақ ізі, Face ID немесе экран құлпы бапталмаған. Қолданба PIN-кодын енгізіңіз.");
            return;
        }

        BiometricPrompt prompt = new BiometricPrompt(this,
                ContextCompat.getMainExecutor(this),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(
                            BiometricPrompt.AuthenticationResult result) {
                        dispatchBiometricResult(true, "");
                    }

                    @Override
                    public void onAuthenticationError(int errorCode,
                            CharSequence errString) {
                        dispatchBiometricResult(false,
                                "Биометрия немесе телефон құлпы расталмады. Қолданба PIN-кодын енгізіңіз.");
                    }
                });

        int allowedAuthenticators = getAllowedAuthenticators();
        BiometricPrompt.PromptInfo.Builder promptBuilder =
                new BiometricPrompt.PromptInfo.Builder()
                        .setTitle("ONAY қолданбасын ашу")
                        .setSubtitle("Саусақ ізі, Face ID немесе телефон құлпы арқылы растаңыз")
                        .setAllowedAuthenticators(allowedAuthenticators);
        // Device credential replaces the negative button in the system prompt.
        if ((allowedAuthenticators & BiometricManager.Authenticators.DEVICE_CREDENTIAL) == 0) {
            promptBuilder.setNegativeButtonText("Қолданба PIN-кодымен кіру");
        }
        prompt.authenticate(promptBuilder.build());
    }

    private void dispatchBiometricResult(boolean success, String message) {
        if (web == null) return;
        String script = "window.onayNativeBiometricResult && window.onayNativeBiometricResult("
                + success + "," + JSONObject.quote(message == null ? "" : message) + ")";
        web.evaluateJavascript(script, null);
    }

    /**
     * WebView camera tracks do not consistently expose the torch constraint on
     * Android devices. Use the platform camera service for the rear-camera
     * flash, while the page retains its WebRTC implementation as a browser
     * fallback.
     */
    private boolean setTorchEnabled(boolean enabled) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || checkSelfPermission(Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            return false;
        }

        synchronized (torchLock) {
            try {
                if (cameraManager == null) {
                    cameraManager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
                }
                if (cameraManager == null) return false;

                if (torchCameraId == null) {
                    String fallbackId = null;
                    for (String cameraId : cameraManager.getCameraIdList()) {
                        CameraCharacteristics characteristics =
                                cameraManager.getCameraCharacteristics(cameraId);
                        if (!Boolean.TRUE.equals(characteristics.get(
                                CameraCharacteristics.FLASH_INFO_AVAILABLE))) {
                            continue;
                        }
                        if (fallbackId == null) fallbackId = cameraId;
                        Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
                        if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                            torchCameraId = cameraId;
                            break;
                        }
                    }
                    if (torchCameraId == null) torchCameraId = fallbackId;
                }
                if (torchCameraId == null) return false;

                cameraManager.setTorchMode(torchCameraId, enabled);
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }
    }

    private void installFastCameraDefaults(WebView view) {
        // Tune the page's own live getUserMedia stream; do not open another
        // camera activity. Preserve explicit constraints already set by HTML.
        String script =
                "(function(){"
                + "const media=navigator.mediaDevices;"
                + "if(!media||!media.getUserMedia||media.__onayFastCamera)return;"
                + "const original=media.getUserMedia.bind(media);"
                + "media.getUserMedia=function(constraints){"
                + "if(!constraints||!constraints.video)return original(constraints);"
                + "const video=constraints.video===true?{}:{...constraints.video};"
                + "if(!video.deviceId&&!video.facingMode)video.facingMode={ideal:'environment'};"
                + "if(!video.width)video.width={ideal:960};"
                + "if(!video.height)video.height={ideal:540};"
                + "if(!video.frameRate)video.frameRate={ideal:30,max:30};"
                + "return original({...constraints,video:video});"
                + "};"
                + "const prepare=function(v){"
                + "if(!(v instanceof HTMLVideoElement))return;"
                + "v.setAttribute('playsinline','');"
                + "v.setAttribute('webkit-playsinline','');"
                + "v.autoplay=true;v.muted=true;"
                + "};"
                + "document.querySelectorAll('video').forEach(prepare);"
                + "if(document.documentElement){"
                + "new MutationObserver(function(records){"
                + "records.forEach(function(record){"
                + "record.addedNodes.forEach(function(node){"
                + "prepare(node);"
                + "if(node.querySelectorAll)node.querySelectorAll('video').forEach(prepare);"
                + "});"
                + "});"
                + "}).observe(document.documentElement,{childList:true,subtree:true});"
                + "}"
                + "media.__onayFastCamera=true;"
                + "})();";
        view.evaluateJavascript(script, null);
    }

    private void requestCameraPermissionOnEntry() {
        if (Build.VERSION.SDK_INT < 23
                || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        if (cameraPermissionRequestInFlight) return;

        cameraPermissionRequestInFlight = true;
        requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
    }

    private void handleWebCameraPermission(PermissionRequest request) {
        if (request == null) return;

        boolean trustedOrigin = request.getOrigin() != null
                && APP_ASSET_HOST.equals(request.getOrigin().getHost());
        String[] resources = request.getResources();
        boolean requestsVideo = false;
        if (resources != null) {
            for (String resource : resources) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                    requestsVideo = true;
                    break;
                }
            }
        }

        // Only the bundled HTTPS page may access the live camera. Never grant
        // microphone access or camera access to remote pages.
        if (!trustedOrigin || !requestsVideo) {
            request.deny();
            return;
        }

        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            return;
        }

        if (pendingWebPermissionRequest != null) {
            pendingWebPermissionRequest.deny();
        }
        pendingWebPermissionRequest = request;

        // Avoid opening a second Android permission dialog if the launch-time
        // permission prompt is already visible.
        if (!cameraPermissionRequestInFlight) {
            cameraPermissionRequestInFlight = true;
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
        }
    }

    private boolean handleWebFileChooser(ValueCallback<Uri[]> callback,
            WebChromeClient.FileChooserParams params) {
        if (pendingFileChooserCallback != null) {
            pendingFileChooserCallback.onReceiveValue(null);
        }

        pendingFileChooserCallback = callback;
        pendingCameraUri = null;
        pendingCameraFile = null;

        // The QR scanner uses the WebView live camera stream and never opens
        // the external camera app. Launch the native camera only for an
        // explicit HTML capture input used to take a registration photo.
        if (params != null && params.isCaptureEnabled()) {
            launchNativeCamera();
            return true;
        }

        try {
            Intent pickerIntent = params != null
                    ? params.createIntent()
                    : new Intent(Intent.ACTION_GET_CONTENT).setType("image/*");
            startActivityForResult(pickerIntent, FILE_CHOOSER_REQUEST);
            return true;
        } catch (Exception error) {
            finishFileChooser(null);
            Toast.makeText(this, "Файл таңдау терезесін ашу мүмкін болмады.",
                    Toast.LENGTH_LONG).show();
            return true;
        }
    }

    private void launchNativeCamera() {
        Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        try {
            pendingCameraFile = File.createTempFile("onay-registration-photo-", ".jpg", getCacheDir());
            pendingCameraUri = FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", pendingCameraFile);

            cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri);
            cameraIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            cameraIntent.setClipData(
                    android.content.ClipData.newRawUri("onay-registration-photo", pendingCameraUri));

            // The external camera is opened only when HTML explicitly marks an
            // input as capture-enabled (registration photo capture).
            startActivityForResult(cameraIntent, FILE_CHOOSER_REQUEST);
        } catch (android.content.ActivityNotFoundException error) {
            deletePendingCameraFile();
            finishFileChooser(null);
            Toast.makeText(this, "Телефонда камера қолданбасы табылмады.",
                    Toast.LENGTH_LONG).show();
        } catch (Exception error) {
            deletePendingCameraFile();
            finishFileChooser(null);
            Toast.makeText(this, "Тіркелу фотосына камераны ашу мүмкін болмады.",
                    Toast.LENGTH_LONG).show();
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

        cameraPermissionRequestInFlight = false;
        boolean granted = checkSelfPermission(Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;

        PermissionRequest request = pendingWebPermissionRequest;
        pendingWebPermissionRequest = null;
        if (request != null) {
            if (granted && request.getOrigin() != null
                    && APP_ASSET_HOST.equals(request.getOrigin().getHost())) {
                request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else {
                request.deny();
            }
        } else if (!granted) {
            Toast.makeText(this,
                    "QR сканері үшін камераға рұқсат қажет. Рұқсатты қолданба баптауынан қосыңыз.",
                    Toast.LENGTH_LONG).show();
        }
        scheduleUpdateCheck();
    }

    private void scheduleUpdateCheck() {
        if (updateCheckScheduled || updateCheckInFlight || updateCheckFinished || updatePromptShown) {
            return;
        }
        updateCheckScheduled = true;
        mainHandler.postDelayed(() -> {
            updateCheckScheduled = false;
            if (isFinishing() || isDestroyed()) return;
            // Do not try to place an update dialog behind Android's camera
            // permission dialog. onRequestPermissionsResult() retries here.
            if (!hasWindowFocus()) {
                scheduleUpdateCheck();
                return;
            }
            checkForUpdates();
        }, 900L);
    }

    private static final class UpdateInfo {
        final String tag;
        final String releaseName;
        final String downloadUrl;
        final String expectedDigest;

        UpdateInfo(String tag, String releaseName, String downloadUrl, String expectedDigest) {
            this.tag = tag;
            this.releaseName = releaseName;
            this.downloadUrl = downloadUrl;
            this.expectedDigest = expectedDigest;
        }
    }

    private void checkForUpdates() {
        if (updateCheckInFlight || updateCheckFinished || updatePromptShown) return;
        updateCheckInFlight = true;
        new Thread(() -> {
            boolean completed = false;
            try {
                // GitHub's REST API is rate-limited for unauthenticated phones.
                // The latest-download endpoint redirects to the current release
                // tag and does not require the API quota.
                UpdateInfo update = fetchLatestReleaseRedirect();
                if (update == null) update = fetchLatestReleaseFromApi();
                if (update == null) {
                    if (getInstalledVersionCode() < MINIMUM_SUPPORTED_VERSION_CODE) {
                        mainHandler.post(this::showMandatoryUpdateUnavailable);
                    }
                    return;
                }

                long currentVersion = getInstalledVersionCode();
                completed = true;
                long remoteVersion = versionFromTag(update.tag);
                if (currentVersion < MINIMUM_SUPPORTED_VERSION_CODE) {
                    if (remoteVersion < MINIMUM_SUPPORTED_VERSION_CODE) {
                        mainHandler.post(this::showMandatoryUpdateUnavailable);
                        return;
                    }
                    final UpdateInfo latest = update;
                    mainHandler.post(() -> showUpdateDialog(
                            latest.releaseName, latest.downloadUrl, latest.expectedDigest, true));
                    return;
                }
                if (remoteVersion <= currentVersion) return;
                final UpdateInfo latest = update;
                mainHandler.post(() -> showUpdateDialog(
                        latest.releaseName, latest.downloadUrl, latest.expectedDigest, false));
            } catch (Exception ignored) {
                if (getInstalledVersionCode() < MINIMUM_SUPPORTED_VERSION_CODE) {
                    mainHandler.post(this::showMandatoryUpdateUnavailable);
                }
            } finally {
                updateCheckFinished = completed;
                updateCheckInFlight = false;
            }
        }).start();
    }

    private UpdateInfo fetchLatestReleaseRedirect() throws Exception {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(RELEASE_LATEST_APK_URL);
            connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("HEAD");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setRequestProperty("User-Agent", "ONAY-Demo-Android-Updater");

            int responseCode = connection.getResponseCode();
            if (responseCode < 300 || responseCode >= 400) return null;

            String location = connection.getHeaderField("Location");
            if (location == null || location.trim().isEmpty()) return null;
            URL releaseUrl = new URL(location);
            if (!"github.com".equalsIgnoreCase(releaseUrl.getHost())) return null;

            Matcher matcher = Pattern.compile(
                    "/releases/download/([^/]+)/" + Pattern.quote(APK_ASSET_NAME))
                    .matcher(releaseUrl.getPath());
            if (!matcher.find()) return null;

            String tag = matcher.group(1);
            return new UpdateInfo(tag, "ONAY Demo " + tag, location, null);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private UpdateInfo fetchLatestReleaseFromApi() throws Exception {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(RELEASE_API);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("User-Agent", "ONAY-Demo-Android-Updater");

            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;

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
            JSONArray assets = release.optJSONArray("assets");
            if (tag.trim().isEmpty() || assets == null) return null;

            String downloadUrl = null;
            String expectedDigest = null;
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.optJSONObject(i);
                if (asset != null && APK_ASSET_NAME.equals(asset.optString("name"))) {
                    downloadUrl = asset.optString("browser_download_url", null);
                    expectedDigest = asset.optString("digest", null);
                    break;
                }
            }
            if (downloadUrl == null || downloadUrl.trim().isEmpty()) return null;

            return new UpdateInfo(tag, release.optString("name", tag), downloadUrl, expectedDigest);
        } finally {
            if (connection != null) connection.disconnect();
        }
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

    private void showMandatoryUpdateUnavailable() {
        if (isFinishing() || isDestroyed() || updatePromptShown) return;
        updatePromptShown = true;
        new AlertDialog.Builder(this)
                .setTitle("Жаңарту міндетті")
                .setMessage("Қолданбаны жалғастыру үшін " + MINIMUM_SUPPORTED_VERSION_NAME
                        + " нұсқасын орнату керек. Интернетті қосып, қайта тексеріңіз.")
                .setPositiveButton("Қайта тексеру", (dialog, which) -> {
                    updatePromptShown = false;
                    updateCheckFinished = false;
                    scheduleUpdateCheck();
                })
                .setCancelable(false)
                .show();
    }

    private void showUpdateDialog(String releaseName, String downloadUrl,
                                  String expectedDigest, boolean mandatory) {
        if (isFinishing() || isDestroyed()) return;
        updatePromptShown = true;
        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle(mandatory ? "Жаңарту міндетті" : "Жаңа нұсқа қолжетімді")
                .setMessage(mandatory
                        ? releaseName + " нұсқасын орнатпай қолданбаны пайдалану мүмкін емес."
                        : releaseName + " нұсқасы шықты. APK тексеріліп, Android қолданбаны өшірмей үстінен жаңартады.")
                .setPositiveButton("Жаңартуға рұқсат беру", (dialog, which) -> downloadUpdate(downloadUrl, expectedDigest))
                .setCancelable(!mandatory);
        if (!mandatory) builder.setNegativeButton("Кейін", null);
        builder.show();
    }

    private void downloadUpdate(String downloadUrl, String expectedDigest) {
        downloadDialog = new ProgressDialog(this);
        downloadDialog.setTitle("Жаңарту жүктелуде");
        downloadDialog.setMessage("Жүктелуде...");
        downloadDialog.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        downloadDialog.setIndeterminate(true);
        downloadDialog.setCancelable(false);
        downloadDialog.show();

        new Thread(() -> {
            HttpURLConnection connection = null;
            File partFile = new File(getCacheDir(), UPDATE_APK_PART_FILE_NAME);
            updateApkFile = new File(getCacheDir(), UPDATE_APK_FILE_NAME);
            try {
                if (partFile.exists() && !partFile.delete()) {
                    throw new IllegalStateException("Алдыңғы жаңарту файлын тазалау мүмкін болмады.");
                }
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
                verifyDownloadedApk(partFile, expectedDigest);
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
                    boolean mandatory = getInstalledVersionCode() < MINIMUM_SUPPORTED_VERSION_CODE;
                    AlertDialog.Builder builder = new AlertDialog.Builder(this)
                            .setTitle("Жаңарту орындалмады")
                            .setMessage(error.getMessage() == null
                                    ? "Интернетті тексеріп, қайта көр."
                                    : error.getMessage())
                            .setPositiveButton(mandatory ? "Қайта көру" : "Жарайды", (dialog, which) -> {
                                if (mandatory) {
                                    updatePromptShown = false;
                                    updateCheckFinished = false;
                                    scheduleUpdateCheck();
                                }
                            })
                            .setCancelable(!mandatory);
                    builder.show();
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
        if (updateApkFile == null) {
            updateApkFile = new File(getCacheDir(), UPDATE_APK_FILE_NAME);
        }
        if (updateApkFile == null || !updateApkFile.exists()) {
            Toast.makeText(this, "Жаңарту файлы табылмады.", Toast.LENGTH_LONG).show();
            return;
        }

        try {
            Uri apkUri = FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", updateApkFile);
            // Every in-app update must pass through SafeInstall's inspection screen.
            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setPackage(SAFE_INSTALL_PACKAGE);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.setClipData(android.content.ClipData.newRawUri("onay-update", apkUri));
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            // If the user cancels Android's installer, onResume() must show
            // the mandatory update prompt again instead of reopening the old app.
            updatePromptShown = false;
            updateCheckFinished = false;
            startActivity(installIntent);
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this,
                    "Жаңартуды жалғастыру үшін алдымен SafeInstall орнат.",
                    Toast.LENGTH_LONG).show();
        } catch (Exception error) {
            Toast.makeText(this, "SafeInstall арқылы жаңарту терезесін ашу мүмкін болмады.",
                    Toast.LENGTH_LONG).show();
        }
    }

    private void verifyDownloadedApk(File apkFile, String expectedDigest) throws Exception {
        if (expectedDigest != null && !expectedDigest.trim().isEmpty()) {
            String normalizedExpected = expectedDigest.trim().toLowerCase(Locale.US);
            if (normalizedExpected.startsWith("sha256:")) {
                normalizedExpected = normalizedExpected.substring("sha256:".length());
            }
            String actualDigest = sha256(apkFile);
            if (!normalizedExpected.equals(actualDigest)) {
                throw new IllegalStateException("Жаңарту файлының SHA-256 қолтаңбасы сәйкес емес.");
            }
        }

        int flags = Build.VERSION.SDK_INT >= 28
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        PackageInfo archiveInfo = getPackageManager().getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
        if (archiveInfo == null || !getPackageName().equals(archiveInfo.packageName)) {
            throw new IllegalStateException("Бұл APK ONAY Demo қолданбасына арналмаған.");
        }
        if (packageVersionCode(archiveInfo) <= getInstalledVersionCode()) {
            throw new IllegalStateException("Жүктелген APK нұсқасы ескірек немесе бірдей.");
        }

        PackageInfo installedInfo = getPackageManager().getPackageInfo(getPackageName(), flags);
        String installedSigner = signerDigest(installedInfo);
        String archiveSigner = signerDigest(archiveInfo);
        if (installedSigner == null || !installedSigner.equals(archiveSigner)) {
            throw new IllegalStateException("APK signing key сәйкес емес. Қолданбаны өшірмей жаңарту мүмкін емес.");
        }
    }

    private long packageVersionCode(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= 28) return info.getLongVersionCode();
        return info.versionCode;
    }

    private String signerDigest(PackageInfo info) throws Exception {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            // Compare the certificate that signs the APK contents. This keeps
            // the check aligned with Android's in-place update requirement.
            signatures = info.signingInfo.getApkContentsSigners();
        } else {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length == 0) return null;

        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        String first = null;
        for (Signature signature : signatures) {
            String current = toHex(digest.digest(signature.toByteArray()));
            if (first == null) first = current;
        }
        return first;
    }

    private String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[16 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                digest.update(buffer, 0, count);
            }
        }
        return toHex(digest.digest());
    }

    private String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            result.append(String.format(Locale.US, "%02x", value & 0xff));
        }
        return result.toString();
    }

    @Override
    protected void onResume() {
        super.onResume();
        scheduleUpdateCheck();
    }

    @Override
    protected void onPause() {
        setTorchEnabled(false);
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (backDispatchInFlight) return;
        if (web == null) {
            super.onBackPressed();
            return;
        }

        // Let the bundled UI close an open screen (for example, Толықтыру)
        // before Android considers leaving the activity.
        backDispatchInFlight = true;
        web.evaluateJavascript(
                "(function(){try{return !!(window.onayHandleNativeBack "
                        + "&& window.onayHandleNativeBack());}catch(e){return false;}})();",
                value -> {
                    backDispatchInFlight = false;
                    if (isFinishing() || web == null) return;
                    if ("true".equals(value)) {
                        lastBackPressAt = 0L;
                        return;
                    }
                    if (web.canGoBack()) {
                        lastBackPressAt = 0L;
                        web.goBack();
                        return;
                    }

                    long now = SystemClock.uptimeMillis();
                    if (now - lastBackPressAt < EXIT_BACK_PRESS_WINDOW_MS) {
                        lastBackPressAt = 0L;
                        super.onBackPressed();
                    } else {
                        lastBackPressAt = now;
                        Toast.makeText(MainActivity.this,
                                "Шығу үшін артқа тағы бір рет басыңыз",
                                Toast.LENGTH_SHORT).show();
                    }
                });
    }

    @Override
    protected void onDestroy() {
        setTorchEnabled(false);
        closeDownloadDialog();
        if (pendingWebPermissionRequest != null) {
            pendingWebPermissionRequest.deny();
            pendingWebPermissionRequest = null;
        }
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

