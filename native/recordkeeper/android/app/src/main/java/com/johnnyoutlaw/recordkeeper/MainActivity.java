package com.johnnyoutlaw.recordkeeper;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

@androidx.media3.common.util.UnstableApi
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(SJNativeAudio.class);registerPlugin(SJAuth.class);
        super.onCreate(state);
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent);setIntent(intent); }
}
