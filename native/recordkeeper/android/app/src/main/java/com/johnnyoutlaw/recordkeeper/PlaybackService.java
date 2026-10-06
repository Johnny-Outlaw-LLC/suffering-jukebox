package com.johnnyoutlaw.recordkeeper;

import android.app.PendingIntent;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.media3.common.*;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.*;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.*;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.*;
import org.json.*;
import java.util.*;
import java.util.concurrent.Callable;

/** Owns the player even when Android Auto starts us without the phone WebView. */
@UnstableApi
public final class PlaybackService extends MediaLibraryService {
    private MediaLibrarySession session;
    private ExoPlayer player;
    private CarLibrary library;
    private boolean pendingStart;
    private Runnable startPlayback;
    private final Handler main=new Handler(Looper.getMainLooper());
    private long lastTick=System.currentTimeMillis(), heardMs=0, startedAt=0;
    private String heardId=null;
    private final Runnable ticker=new Runnable() {
        public void run() {
            long now=System.currentTimeMillis();
            if(player!=null && player.isPlaying()) heardMs+=Math.min(2000,now-lastTick);
            lastTick=now;main.postDelayed(this,1000);
        }
    };
    @Override public void onCreate() {
        super.onCreate(); library=new CarLibrary(this);
        setMediaNotificationProvider(new DefaultMediaNotificationProvider.Builder(this)
            .setNotificationId(1001).setChannelId("recordkeeper-playback").setChannelName(R.string.app_name).build());
        DefaultDataSource.Factory upstream = new DefaultDataSource.Factory(this);
        ResolvingDataSource.Factory source=new ResolvingDataSource.Factory(upstream, dataSpec -> {
            if("rk".equals(dataSpec.uri.getScheme())) return dataSpec.withUri(library.resolve(dataSpec.uri.getLastPathSegment()));
            // External controllers cannot inject an arbitrary playback URI.
            throw new java.io.IOException("Unsupported audio source");
        });
        player=new ExoPlayer.Builder(this).setMediaSourceFactory(new DefaultMediaSourceFactory(source))
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),true)
            .setHandleAudioBecomingNoisy(true).setWakeMode(C.WAKE_MODE_LOCAL).build();
        player.addListener(new Player.Listener() {
            @Override public void onMediaItemTransition(MediaItem item,int reason) {
                flushPlay(); heardId=item==null?null:item.mediaId;startedAt=System.currentTimeMillis();
                if(item!=null) getSharedPreferences("playback",0).edit().putString("lastId",item.mediaId).apply();
            }
            @Override public void onPlaybackStateChanged(int state) { if(state==Player.STATE_ENDED) flushPlay(); }
            @Override public void onIsPlayingChanged(boolean playing) { if(!playing) flushPlay(); }
        });
        PendingIntent launch=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        Player sessionPlayer=new ForwardingPlayer(player) {
            @Override public void play() { requestPlayback(true); }
            @Override public void setPlayWhenReady(boolean ready) { requestPlayback(ready); }
        };
        session=new MediaLibrarySession.Builder(this,sessionPlayer,new Callbacks()).setSessionActivity(launch).build();
        main.post(ticker);library.io.execute(()->library.refresh(true));
    }
    private void requestPlayback(boolean ready) {
        if(startPlayback!=null)main.removeCallbacks(startPlayback);
        pendingStart=false;
        if(!ready) { player.setPlayWhenReady(false);return; }
        if(player.isPlaying())return;
        NotificationManager notifications=getSystemService(NotificationManager.class);
        if(Build.VERSION.SDK_INT>=26) notifications.createNotificationChannel(new NotificationChannel("recordkeeper-playback","Record Keeper playback",NotificationManager.IMPORTANCE_LOW));
        Notification.Builder notice=Build.VERSION.SDK_INT>=26?new Notification.Builder(this,"recordkeeper-playback"):new Notification.Builder(this);
        notice.setSmallIcon(R.drawable.ic_notification).setContentTitle("Record Keeper").setContentText("Preparing audio").setOngoing(true);
        pendingStart=true;startForeground(1001,notice.build());
        // ActivityManager publishes the foreground-service state asynchronously. Asking
        // for audio focus in the same binder turn is rejected on Android 15 and later.
        // Hold the preparing notification until that state is visible; pause cancels it.
        startPlayback=()-> {pendingStart=false;player.prepare();player.play();};
        main.postDelayed(startPlayback,250);
    }
    @Override public void onUpdateNotification(MediaSession mediaSession,boolean startInForegroundRequired) {
        if(!pendingStart)super.onUpdateNotification(mediaSession,startInForegroundRequired);
    }
    private void flushPlay() {
        if(heardId==null||heardMs<1000||library.credentials.get().isEmpty()) { heardMs=0;return; }
        try {
            synchronized(PlaybackService.class) {
                JSONArray outbox=new JSONArray(getSharedPreferences("feedback",0).getString("items","[]"));
                outbox.put(new JSONObject().put("id",UUID.randomUUID().toString()).put("kind","play").put("trackId",heardId).put("at",startedAt/1000.0).put("ms",heardMs));
                getSharedPreferences("feedback",0).edit().putString("items",outbox.toString()).commit();
            }
        } catch(Exception ignored) {}
        heardMs=0;startedAt=System.currentTimeMillis();
    }
    @Override public MediaLibrarySession onGetSession(MediaSession.ControllerInfo controller) {
        return controller.getUid()==android.os.Process.myUid() || controller.isTrusted()
            || "com.google.android.projection.gearhead".equals(controller.getPackageName()) ? session : null;
    }
    @Override public void onDestroy() {
        main.removeCallbacks(ticker);if(startPlayback!=null)main.removeCallbacks(startPlayback);flushPlay();
        if(session!=null) { session.release();session=null; }
        if(player!=null) { player.release();player=null; }
        library.io.shutdown(); super.onDestroy();
    }
    private <T> ListenableFuture<T> background(Callable<T> work) {
        SettableFuture<T> future=SettableFuture.create();
        library.io.execute(()-> { try { future.set(work.call()); } catch(Exception error) { future.setException(error); } });
        return future;
    }
    private static <T> List<T> page(List<T> rows,int page,int size) {
        if(page<0||size<1) return Collections.emptyList();
        long start=(long)page*size; if(start>=rows.size()) return Collections.emptyList();
        return rows.subList((int)start,(int)Math.min(rows.size(),start+Math.min(size,200)));
    }
    private final class Callbacks implements MediaLibrarySession.Callback {
        @Override public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(MediaLibrarySession s,MediaSession.ControllerInfo browser,LibraryParams params) {
            Bundle extras=new Bundle(); extras.putInt("android.media.browse.CONTENT_STYLE_BROWSABLE_HINT",1);extras.putInt("android.media.browse.CONTENT_STYLE_PLAYABLE_HINT",1);
            LibraryParams p=new LibraryParams.Builder().setExtras(extras).build();
            return Futures.immediateFuture(LibraryResult.ofItem(CarLibrary.folder("root","Record Keeper"),p));
        }
        @Override public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(MediaLibrarySession s,MediaSession.ControllerInfo browser,String parent,int page,int size,LibraryParams params) {
            return background(()-> { library.refresh(false);return LibraryResult.ofItemList(page(library.children(parent),page,size),params); });
        }
        @Override public ListenableFuture<LibraryResult<MediaItem>> onGetItem(MediaLibrarySession s,MediaSession.ControllerInfo browser,String id) {
            return background(()-> { library.refresh(false);JSONObject row=library.find(id);
                return row==null?LibraryResult.ofError(SessionError.ERROR_BAD_VALUE):LibraryResult.ofItem(library.item(row),null); });
        }
        @Override public ListenableFuture<LibraryResult<Void>> onSubscribe(MediaLibrarySession s,MediaSession.ControllerInfo browser,String parent,LibraryParams params) {
            return background(()-> { library.refresh(false);main.post(()->s.notifyChildrenChanged(browser,parent,library.children(parent).size(),params));return LibraryResult.ofVoid(); });
        }
        @Override public ListenableFuture<LibraryResult<Void>> onSearch(MediaLibrarySession s,MediaSession.ControllerInfo browser,String query,LibraryParams params) {
            return background(()-> { library.refresh(false);int count=library.search(query).size();main.post(()->s.notifySearchResultChanged(browser,query,count,params));return LibraryResult.ofVoid(); });
        }
        @Override public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetSearchResult(MediaLibrarySession s,MediaSession.ControllerInfo browser,String query,int page,int size,LibraryParams params) {
            return background(()->LibraryResult.ofItemList(page(library.search(query),page,size),params));
        }
        @Override public ListenableFuture<List<MediaItem>> onAddMediaItems(MediaSession s,MediaSession.ControllerInfo controller,List<MediaItem> requested) {
            return background(()-> {
                library.refresh(false);List<MediaItem> result=new ArrayList<>();
                for(MediaItem item:requested) {
                    JSONObject row=library.find(item.mediaId);
                    if(row!=null) result.add(library.item(row));
                    else if(item.requestMetadata.searchQuery!=null) result.addAll(library.search(item.requestMetadata.searchQuery));
                }
                if(result.isEmpty()) throw new IllegalArgumentException("No playable audio matches. Add audio on your phone first.");
                return result;
            });
        }
        @Override public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(MediaSession s,MediaSession.ControllerInfo browser,boolean playback) {
            return background(()-> {
                library.refresh(false);List<MediaItem> items=library.children("songs");
                String last=getSharedPreferences("playback",0).getString("lastId","");int index=0;
                for(int i=0;i<items.size();i++) if(items.get(i).mediaId.equals(last)) index=i;
                if(items.isEmpty()) throw new IllegalStateException("No audio available");
                return new MediaSession.MediaItemsWithStartPosition(items,index,0);
            });
        }
    }
}
