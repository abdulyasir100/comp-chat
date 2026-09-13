package com.ryza.chat;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Thin WebView shell. No androidx — the whole app is the bundled web build
 * served from AssetServer on 127.0.0.1 (Spine cannot load from file://).
 */
public class MainActivity extends Activity {
    private AssetServer server;
    private WebView web;
    /* <input type=file> support: the WebView does nothing on its own; the
       character importer (a .zip) and the portrait picker need this. */
    private static final int REQ_FILE = 7001;
    private ValueCallback<Uri[]> pendingFile;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        server = new AssetServer(getAssets(), 8765);
        server.start();

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        /* console.* -> logcat (tag CompanionChat) always; chrome://inspect only
           for a debuggable build (scripts/build_apk.ps1 -DebugBuild), never in
           a release APK. */
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i("CompanionChat", m.messageLevel() + " " + m.sourceId() + ":" + m.lineNumber() + " " + m.message());
                return true;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (pendingFile != null) pendingFile.onReceiveValue(null);
                pendingFile = cb;
                Intent intent = params.createIntent();
                /* accept lists like ".zip,application/zip" confuse some pickers; ask for anything */
                intent.setType("*/*");
                try { startActivityForResult(intent, REQ_FILE); }
                catch (Exception e) { pendingFile = null; return false; }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient());
        /* window.companionShell.setFullscreen(bool) — immersive mode; the
           HTML fullscreen API is a no-op in a WebView without host support. */
        web.addJavascriptInterface(new ShellBridge(), "companionShell");
        web.loadUrl("http://127.0.0.1:8765/");
    }

    private class ShellBridge {
        @JavascriptInterface
        public void setFullscreen(final boolean on) {
            runOnUiThread(new Runnable() { @Override public void run() { applyImmersive(on); } });
        }
    }

    @SuppressWarnings("deprecation")
    private void applyImmersive(boolean on) {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            if (on) {
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsets.Type.systemBars());
            } else {
                c.show(WindowInsets.Type.systemBars());
            }
        } else {
            View v = getWindow().getDecorView();
            v.setSystemUiVisibility(on
                ? (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                   | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
                : View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        if (req != REQ_FILE) { super.onActivityResult(req, result, data); return; }
        if (pendingFile == null) return;
        Uri[] out = null;
        if (result == RESULT_OK && data != null && data.getData() != null) out = new Uri[] { data.getData() };
        pendingFile.onReceiveValue(out);
        pendingFile = null;
    }

    @Override public void onPause()  { super.onPause();  if (web != null) web.onPause(); }
    @Override public void onResume() { super.onResume(); if (web != null) web.onResume(); }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stopServer();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
