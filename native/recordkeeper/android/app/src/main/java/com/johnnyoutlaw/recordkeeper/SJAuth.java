package com.johnnyoutlaw.recordkeeper;

import android.content.Intent;
import android.net.Uri;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;

/** System-browser OAuth with the PKCE verifier retained by the bundled web app. */
@CapacitorPlugin(name="SJAuth")
public class SJAuth extends Plugin {
    private PluginCall pending;
    @PluginMethod public void signIn(PluginCall call) {
        if(pending!=null) {call.reject("Sign-in already in progress");return;}
        Uri url=Uri.parse(call.getString("url",""));
        if(!"https".equals(url.getScheme())||!"recordkeeper.stream".equals(url.getHost())||!"/api/sj-auth-start".equals(url.getPath())
            ||!"com.johnnyoutlaw.recordkeeper".equals(call.getString("callbackScheme"))) {call.reject("Invalid sign-in URL");return;}
        pending=call;
        getActivity().runOnUiThread(()->new CustomTabsIntent.Builder().build().launchUrl(getActivity(),url));
    }
    @Override protected void handleOnNewIntent(Intent intent) {
        Uri uri=intent.getData(); if(pending==null||uri==null) return;
        if("com.johnnyoutlaw.recordkeeper".equals(uri.getScheme())&&"auth".equals(uri.getHost())) {
            PluginCall call=pending;pending=null;call.resolve(new JSObject().put("url",uri.toString()));
        }
    }
    @Override protected void handleOnResume() {
        // A cancelled Custom Tab must allow the listener to start a new attempt.
        if(pending!=null) getActivity().getWindow().getDecorView().postDelayed(()-> {
            if(pending!=null && getActivity().hasWindowFocus()) {PluginCall call=pending;pending=null;call.reject("Sign-in cancelled","cancelled");}
        },750);
    }
}
