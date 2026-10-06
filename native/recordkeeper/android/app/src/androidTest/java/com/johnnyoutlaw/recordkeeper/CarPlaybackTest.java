package com.johnnyoutlaw.recordkeeper;

import android.content.ComponentName;
import android.content.Context;
import androidx.media3.common.*;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.*;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.google.common.util.concurrent.ListenableFuture;
import org.junit.*;
import org.junit.runner.RunWith;
import java.util.concurrent.*;
import static org.junit.Assert.*;

/** Exercises the same service protocol Android Auto uses, against the live authorized catalog. */
@UnstableApi
@RunWith(AndroidJUnit4.class)
public class CarPlaybackTest {
    private MediaBrowser browser;
    private interface Request<T> { ListenableFuture<T> run(); }
    private <T> T request(Request<T> action) throws Exception {
        final ListenableFuture<?>[] pending=new ListenableFuture<?>[1];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->pending[0]=action.run());
        return (T)pending[0].get(45,TimeUnit.SECONDS);
    }
    @Before public void connect() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        browser=request(()->new MediaBrowser.Builder(context,new SessionToken(context,new ComponentName(context,PlaybackService.class))).buildAsync());
    }
    @After public void close() { if(browser!=null)InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{browser.pause();browser.release();}); }
    @Test public void browseSearchAndPlayLicensedAudioWithNoPhoneActivity() throws Exception {
        LibraryResult<MediaItem> root=request(()->browser.getLibraryRoot(null));assertEquals("root",root.value.mediaId);
        LibraryResult<com.google.common.collect.ImmutableList<MediaItem>> tabs=request(()->browser.getChildren("root",0,20,null));assertEquals(4,tabs.value.size());
        LibraryResult<com.google.common.collect.ImmutableList<MediaItem>> songs=request(()->browser.getChildren("songs",0,100,null));assertNotNull(songs.value);assertFalse(songs.value.isEmpty());
        MediaItem song=songs.value.get(0);assertTrue(song.mediaMetadata.isPlayable);assertNull("Browsing must not leak a signed stream URL",song.localConfiguration);
        LibraryResult<Void> search=request(()->browser.search(String.valueOf(song.mediaMetadata.title),null));assertEquals(0,search.resultCode);
        LibraryResult<com.google.common.collect.ImmutableList<MediaItem>> matches=request(()->browser.getSearchResult(String.valueOf(song.mediaMetadata.title),0,100,null));assertFalse(matches.value.isEmpty());
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{browser.setMediaItem(song);browser.prepare();browser.play();});
        boolean[] playing={false};long deadline=System.currentTimeMillis()+30000;
        while(System.currentTimeMillis()<deadline) {
            InstrumentationRegistry.getInstrumentation().runOnMainSync(()->playing[0]=browser.isPlaying());
            if(playing[0])break;Thread.sleep(250);
        }
        assertTrue("Native audio must play with no Activity or WebView",playing[0]);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{assertEquals(song.mediaId,browser.getCurrentMediaItem().mediaId);browser.pause();assertFalse(browser.getPlayWhenReady());});
    }
    @Test public void encryptedCarCredentialRoundTripAndSignOut() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();CarCredentials credentials=new CarCredentials(context);
        String old=credentials.get(),email=credentials.email();
        try {credentials.set("test-device-car-key-for-keystore-validation","test@example.invalid");assertEquals("test-device-car-key-for-keystore-validation",credentials.get());
            String stored=context.getSharedPreferences("car-credentials",0).getString("encrypted","");assertFalse(stored.contains("test-device-car-key"));
            credentials.clear();assertEquals("",credentials.get());
        } finally {if(!old.isEmpty())credentials.set(old,email);else credentials.clear();}
    }
}
