package com.johnnyoutlaw.recordkeeper;

import android.content.ComponentName;
import android.os.Handler;
import android.os.Looper;
import androidx.media3.common.*;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.*;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;
import org.json.*;
import java.io.*;
import java.net.*;
import java.util.*;

@UnstableApi
@CapacitorPlugin(name="SJNativeAudio")
public class SJNativeAudio extends Plugin {
    private MediaController player;
    private ListenableFuture<MediaController> connection;
    private CarLibrary library;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final Runnable ticker=new Runnable() { public void run() {
        if(player!=null) notifyListeners("statusChange",status());main.postDelayed(this,1000);
    }};
    @Override public void load() {
        library=new CarLibrary(getContext());
        SessionToken token=new SessionToken(getContext(),new ComponentName(getContext(),PlaybackService.class));
        connection=new MediaController.Builder(getContext(),token).buildAsync();
        connection.addListener(()-> {
            try { player=connection.get();player.addListener(new Player.Listener() {
                @Override public void onEvents(Player p,Player.Events e) { notifyListeners("statusChange",status()); }
                @Override public void onMediaItemTransition(MediaItem item,int reason) {
                    notifyListeners("remoteCommand",new JSObject().put("command","track").put("trackId",item==null?JSONObject.NULL:item.mediaId));
                }
                @Override public void onPlayerError(PlaybackException error) {
                    notifyListeners("playbackError",new JSObject().put("error","This song could not play. Check your connection or choose a downloaded song."));
                }
            });main.post(ticker); } catch(Exception ignored) {}
        },getActivity()::runOnUiThread);
        library.io.execute(()->library.refresh(true));
    }
    @Override protected void handleOnDestroy() { main.removeCallbacks(ticker);if(connection!=null)MediaController.releaseFuture(connection);library.io.shutdown(); }
    @Override protected void handleOnResume() { library.io.execute(()->library.refresh(true));notifyListeners("carplayFeedback",new JSObject().put("pending",true)); }
    private JSObject status() {
        if(player==null) return new JSObject().put("state","idle").put("index",-1).put("trackId",JSONObject.NULL).put("positionSeconds",0).put("durationSeconds",0);
        String state=player.getPlaybackState()==Player.STATE_BUFFERING?"buffering":player.isPlaying()?"playing":player.getPlaybackState()==Player.STATE_ENDED?"ended":player.getMediaItemCount()==0?"idle":"paused";
        JSArray queue=new JSArray(); for(int i=0;i<player.getMediaItemCount();i++) {
            MediaItem item=player.getMediaItemAt(i);MediaMetadata m=item.mediaMetadata;
            queue.put(new JSObject().put("id",item.mediaId).put("title",String.valueOf(m.title)).put("artist",String.valueOf(m.artist)).put("album",String.valueOf(m.albumTitle)).put("artworkUrl",m.artworkUri==null?JSONObject.NULL:m.artworkUri.toString()));
        }
        MediaItem item=player.getCurrentMediaItem();long duration=player.getDuration();
        return new JSObject().put("state",state).put("index",player.getMediaItemCount()==0?-1:player.getCurrentMediaItemIndex())
            .put("nextIndex",player.hasNextMediaItem()?player.getNextMediaItemIndex():JSONObject.NULL).put("trackId",item==null?JSONObject.NULL:item.mediaId)
            .put("positionSeconds",player.getCurrentPosition()/1000.0).put("durationSeconds",duration==C.TIME_UNSET?0:duration/1000.0)
            .put("queue",queue).put("shuffleEnabled",player.getShuffleModeEnabled())
            .put("repeatMode",player.getRepeatMode()==Player.REPEAT_MODE_ALL?"all":player.getRepeatMode()==Player.REPEAT_MODE_ONE?"one":"off");
    }
    private interface Action { void run() throws Exception; }
    private void transport(PluginCall call,Action action) { getActivity().runOnUiThread(()-> {
        if(player==null){call.reject("Audio is starting. Try again.");return;}
        try {action.run();call.resolve(status());}catch(Exception error){call.reject("Could not update playback");}
    }); }
    @PluginMethod public void getStatus(PluginCall call) { transport(call,()->{}); }
    @PluginMethod public void play(PluginCall call) { transport(call,()-> {Integer index=call.getInt("index");if(index!=null&&index>=0&&index<player.getMediaItemCount())player.seekToDefaultPosition(index);player.prepare();player.play();}); }
    @PluginMethod public void pause(PluginCall call) { transport(call,()->player.pause()); }
    @PluginMethod public void next(PluginCall call) { transport(call,()->player.seekToNextMediaItem()); }
    @PluginMethod public void previous(PluginCall call) { transport(call,()->player.seekToPreviousMediaItem()); }
    @PluginMethod public void seek(PluginCall call) { transport(call,()->player.seekTo(Math.max(0,(long)(call.getDouble("positionSeconds",0.0)*1000)))); }
    @PluginMethod public void setShuffle(PluginCall call) { transport(call,()->player.setShuffleModeEnabled(call.getBoolean("enabled",false))); }
    @PluginMethod public void setRepeat(PluginCall call) { transport(call,()->player.setRepeatMode(call.getBoolean("enabled",false)?Player.REPEAT_MODE_ALL:Player.REPEAT_MODE_OFF)); }
    @PluginMethod public void setQueue(PluginCall call) {
        library.io.execute(()-> {
            library.refresh(false);JSArray requested=call.getArray("tracks",new JSArray());List<MediaItem> items=new ArrayList<>();
            int requestedIndex=call.getInt("startIndex",0),start=0;
            for(int i=0;i<requested.length();i++) {JSONObject input=requested.optJSONObject(i);if(input==null)continue;JSONObject row=library.find(input.optString("id"));if(row!=null) {if(i==requestedIndex)start=items.size();items.add(library.item(row));}}
            final int first=start;
            if(items.isEmpty()) {call.reject("No licensed or uploaded audio is available for this queue");return;}
            transport(call,()-> {player.setMediaItems(items,first,0);player.prepare();player.setPlayWhenReady(call.getBoolean("autoPlay",false));});
        });
    }
    @PluginMethod public void setCarAccess(PluginCall call) {
        if(!CarLibrary.ORIGIN.equals(call.getString("baseUrl"))) {call.reject("Invalid car server");return;}
        String key=call.getString("key","");if(!key.matches("[A-Za-z0-9_-]{20,200}")){call.reject("Invalid car key");return;}
        library.io.execute(()-> {try{
            if(!library.credentials.email().equals(call.getString("email","")))getContext().getSharedPreferences("feedback",0).edit().clear().commit();
            library.clearPersonal();library.credentials.set(key,call.getString("email",""));library.refresh(true);call.resolve();
        }catch(Exception e){call.reject("Could not secure car access");}});
    }
    @PluginMethod public void clearCarAccess(PluginCall call) {
        transport(call,()-> {player.stop();player.clearMediaItems();library.credentials.clear();library.clearPersonal();getContext().getSharedPreferences("feedback",0).edit().clear().commit();});
    }
    @PluginMethod public void carAccessStatus(PluginCall call) {
        library.io.execute(()-> {library.refresh(false);call.resolve(new JSObject().put("hasKey",!library.credentials.get().isEmpty()).put("email",library.credentials.email())
            .put("keyAccepted",library.accepted()).put("baseUrl",CarLibrary.ORIGIN).put("streamable",library.all().size()).put("mine",library.mineCount()));});
    }
    @PluginMethod public void refreshCarLibrary(PluginCall call) {library.io.execute(()->call.resolve(new JSObject().put("ok",library.refresh(true)).put("count",library.all().size())));}
    @PluginMethod public void setPlaylists(PluginCall call) {
        JSArray incoming=call.getArray("playlists",new JSArray());JSONArray merged=new JSONArray();Set<String> ids=new HashSet<>();
        for(int i=0;i<incoming.length();i++){JSONObject row=incoming.optJSONObject(i);if(row!=null){merged.put(row);ids.add(row.optString("id"));}}
        for(JSONObject old:library.playlists()) if(!ids.contains(old.optString("id")) && (call.getBoolean("preserveSaved",false)||call.getBoolean("preserveFavorites",false)&&old.optString("id").startsWith("dynamic:")))merged.put(old);
        getContext().getSharedPreferences("car-playlists",0).edit().putString("rows",merged.toString()).commit();call.resolve(new JSObject().put("count",merged.length()));
    }
    @PluginMethod public void download(PluginCall call) {
        JSObject track=call.getObject("track",new JSObject());String id=track.optString("id");
        if(!id.matches("[0-9a-fA-F-]{36}")){call.reject("Invalid track");return;}
        call.resolve(new JSObject().put("trackId",id).put("state","downloading").put("progress",0).put("bytes",0));
        library.io.execute(()-> {
            File temp=new File(library.audioFile(id).getPath()+".partial");HttpURLConnection connection=null;
            try {
                library.refresh(true);String owner="mine".equals(library.find(id).optString("source"))?library.credentials.email():"";
                String startedKey=library.credentials.get();String uri=library.resolve(id).toString();
                if(uri.startsWith("file:")){notifyListeners("downloadChange",new JSObject().put("trackId",id).put("state","done").put("bytes",library.audioFile(id).length()).put("progress",1));return;}
                temp.getParentFile().mkdirs();connection=(HttpURLConnection)new URL(uri).openConnection();connection.setConnectTimeout(15000);connection.setReadTimeout(30000);
                if(connection.getResponseCode()!=200)throw new IOException("Download failed");
                long bytes=0,total=connection.getContentLength(),last=0;byte[] buffer=new byte[65536];int count;
                try(InputStream input=connection.getInputStream();OutputStream output=new FileOutputStream(temp)) {
                    while((count=input.read(buffer))!=-1) {output.write(buffer,0,count);bytes+=count;
                        if(System.currentTimeMillis()-last>500){last=System.currentTimeMillis();notifyListeners("downloadChange",new JSObject().put("trackId",id).put("state","downloading").put("bytes",bytes).put("progress",total>0?bytes/(double)total:0));}
                    }
                }
                if(!startedKey.equals(library.credentials.get()))throw new IOException("Account changed during download");
                if(bytes==0||!temp.renameTo(library.audioFile(id)))throw new IOException("Could not save download");
                getContext().getSharedPreferences("download-owners",0).edit().putString(id,owner).commit();
                notifyListeners("downloadChange",new JSObject().put("trackId",id).put("state","done").put("bytes",bytes).put("progress",1));
            } catch(Exception error) {temp.delete();notifyListeners("downloadChange",new JSObject().put("trackId",id).put("state","failed").put("error","Could not download audio. Check your connection and try again."));}
            finally {if(connection!=null)connection.disconnect();}
        });
    }
    @PluginMethod public void removeDownload(PluginCall call) {try{File file=library.audioFile(call.getString("trackId",""));if(file.exists()&&!file.delete())throw new IOException();call.resolve();}catch(Exception e){call.reject("Could not remove download");}}
    @PluginMethod public void listDownloads(PluginCall call) {
        library.io.execute(()-> {JSArray rows=new JSArray();long bytes=0;
            for(JSONObject track:library.all()){String id=track.optString("id");File file=library.audioFile(id);if(library.downloadAvailable(id)){bytes+=file.length();rows.put(new JSObject().put("trackId",id).put("state","done").put("bytes",file.length()).put("progress",1));}}
            call.resolve(new JSObject().put("downloads",rows).put("bytesUsed",bytes));});
    }
    @PluginMethod public void drainFeedback(PluginCall call) {try{call.resolve(new JSObject().put("items",new JSONArray(getContext().getSharedPreferences("feedback",0).getString("items","[]"))));}catch(Exception e){call.reject("Could not read listening history");}}
    @PluginMethod public void ackFeedback(PluginCall call) {
        JSArray ids=call.getArray("ids",new JSArray());Set<String> done=new HashSet<>();for(int i=0;i<ids.length();i++)done.add(ids.optString(i));
        synchronized(PlaybackService.class){try{JSONArray old=new JSONArray(getContext().getSharedPreferences("feedback",0).getString("items","[]")),kept=new JSONArray();for(int i=0;i<old.length();i++){JSONObject row=old.getJSONObject(i);if(!done.contains(row.optString("id")))kept.put(row);}getContext().getSharedPreferences("feedback",0).edit().putString("items",kept.toString()).commit();call.resolve();}catch(Exception e){call.reject("Could not save listening history");}}
    }
}
