package com.johnnyoutlaw.recordkeeper;

import android.content.Context;
import android.net.Uri;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Same authorized library as CarPlay. URLs are resolved at playback, never cached. */
final class CarLibrary {
    static final String ORIGIN = "https://recordkeeper.stream";
    final Context context;
    final CarCredentials credentials;
    final ExecutorService io = Executors.newFixedThreadPool(2);
    private volatile List<JSONObject> tracks = new ArrayList<>();
    private volatile boolean accepted = false;
    private long refreshedAt;
    private String loadedKey;
    CarLibrary(Context context) {
        this.context = context; credentials = new CarCredentials(context);
        loadedKey = credentials.get();
        try { tracks = rows(new JSONArray(context.getSharedPreferences("car-library",0).getString("tracks", "[]"))); }
        catch (Exception ignored) {}
    }
    static List<JSONObject> rows(JSONArray array) {
        List<JSONObject> result = new ArrayList<>();
        for (int i=0;i<array.length();i++) { JSONObject row=array.optJSONObject(i); if(row!=null) result.add(row); }
        return result;
    }
    JSONObject api(String path) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN+path).openConnection();
        connection.setConnectTimeout(15000); connection.setReadTimeout(20000); connection.setInstanceFollowRedirects(false);
        String key=credentials.get(); if (!key.isEmpty()) connection.setRequestProperty("Authorization", "Bearer "+key);
        try {
            if (connection.getResponseCode()!=200) throw new IOException("Audio service unavailable ("+connection.getResponseCode()+")");
            try (InputStream stream=connection.getInputStream()) {
                JSONObject response = new JSONObject(read(stream));
                if (!response.optBoolean("ok")) throw new IOException("Audio service unavailable");
                return response;
            }
        } catch (org.json.JSONException error) { throw new IOException("Invalid audio response", error); }
        finally { connection.disconnect(); }
    }
    static String read(InputStream input) throws IOException {
        ByteArrayOutputStream output=new ByteArrayOutputStream(); byte[] buffer=new byte[8192]; int count;
        while ((count=input.read(buffer))!=-1) output.write(buffer,0,count);
        return output.toString("UTF-8");
    }
    synchronized boolean refresh(boolean force) {
        String currentKey=credentials.get();
        if (!currentKey.equals(loadedKey)) { clearPersonal();loadedKey=currentKey; }
        if (!force && System.currentTimeMillis()-refreshedAt<60000) return true;
        try {
            String sentKey = credentials.get();
            JSONObject response=api("/api/sj-carplay-library");
            // An account switch during this request must not resurrect its predecessor's library.
            if (!sentKey.equals(credentials.get())) return false;
            accepted=response.optBoolean("signedIn"); tracks=rows(response.getJSONArray("tracks")); refreshedAt=System.currentTimeMillis();
            context.getSharedPreferences("car-library",0).edit().putString("tracks",new JSONArray(tracks).toString()).apply();
            return true;
        } catch(Exception error) { return false; }
    }
    synchronized void clearPersonal() {
        List<JSONObject> publicRows=new ArrayList<>();
        for(JSONObject row:tracks) if(!"mine".equals(row.optString("source"))) publicRows.add(row);
        tracks=publicRows; accepted=false; refreshedAt=0;
        context.getSharedPreferences("car-library",0).edit().putString("tracks",new JSONArray(tracks).toString()).commit();
        context.getSharedPreferences("car-playlists",0).edit().clear().commit();
    }
    List<JSONObject> all() { return new ArrayList<>(tracks); }
    JSONObject find(String id) { for(JSONObject row:tracks) if(id.equals(row.optString("id"))) return row; return null; }
    File audioFile(String id) {
        if (!id.matches("[0-9a-fA-F-]{36}")) throw new IllegalArgumentException("Invalid track");
        return new File(context.getFilesDir(),"audio/"+id+".audio");
    }
    Uri resolve(String id) throws IOException {
        refresh(false);
        // Check current eligibility even for local files; signing out never exposes personal audio.
        JSONObject row=find(id); if(row==null) throw new IOException("This song is not available for car playback");
        if("mine".equals(row.optString("source")) && credentials.get().isEmpty()) throw new IOException("Sign in on your phone first");
        File file=audioFile(id); if(downloadAvailable(id)) return Uri.fromFile(file);
        String url=api("/api/sj-carplay-stream?track_id="+Uri.encode(id)).optString("url");
        if(!url.startsWith("https://")) throw new IOException("Invalid audio URL");
        return Uri.parse(url);
    }
    boolean accepted() { return accepted; }
    boolean downloadAvailable(String id) {
        String owner=context.getSharedPreferences("download-owners",0).getString(id,null);
        return audioFile(id).isFile() && owner!=null && (owner.isEmpty() || owner.equals(credentials.email()));
    }
    int mineCount() { int count=0; for(JSONObject row:tracks) if("mine".equals(row.optString("source"))) count++; return count; }
    MediaItem item(JSONObject row) {
        String id=row.optString("id");
        MediaMetadata.Builder metadata = new MediaMetadata.Builder().setTitle(row.optString("title"))
            .setArtist(row.optString("artist")).setAlbumTitle(row.optString("album"))
            .setIsBrowsable(false).setIsPlayable(true).setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC);
        String artwork=row.optString("artworkUrl"); if(artwork.startsWith("https://")) metadata.setArtworkUri(Uri.parse(artwork));
        return new MediaItem.Builder().setMediaId(id).setUri("rk://track/"+id).setMediaMetadata(metadata.build()).build();
    }
    static MediaItem folder(String id,String title) {
        return new MediaItem.Builder().setMediaId(id).setMediaMetadata(new MediaMetadata.Builder().setTitle(title)
            .setIsBrowsable(true).setIsPlayable(false).setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build()).build();
    }
    List<MediaItem> children(String parent) {
        if("root".equals(parent)) return Arrays.asList(folder("artists","Artists"),folder("playlists","Playlists"),folder("songs","Songs"),folder("downloads","Downloads"));
        List<MediaItem> out=new ArrayList<>();
        if("artists".equals(parent)) {
            TreeSet<String> names=new TreeSet<>(String.CASE_INSENSITIVE_ORDER); for(JSONObject row:tracks) names.add(row.optString("artist"));
            for(String name:names) out.add(folder("artist:"+name,name));
        } else if("playlists".equals(parent)) {
            for(JSONObject playlist:playlists()) if(playlistItems(playlist).size()>0) out.add(folder("playlist:"+playlist.optString("id"),playlist.optString("name")));
        } else if(parent.startsWith("playlist:")) {
            for(JSONObject playlist:playlists()) if(parent.substring(9).equals(playlist.optString("id"))) out.addAll(playlistItems(playlist));
        } else {
            for(JSONObject row:tracks) if("songs".equals(parent) || ("downloads".equals(parent)&&downloadAvailable(row.optString("id")))
                || (parent.startsWith("artist:") && parent.substring(7).equals(row.optString("artist")))) out.add(item(row));
        }
        return out;
    }
    List<JSONObject> playlists() {
        try { return rows(new JSONArray(context.getSharedPreferences("car-playlists",0).getString("rows","[]"))); }
        catch(Exception ignored) { return new ArrayList<>(); }
    }
    List<MediaItem> playlistItems(JSONObject playlist) {
        List<MediaItem> result=new ArrayList<>();JSONArray ids=playlist.optJSONArray("trackIds");
        if(ids!=null) for(int i=0;i<ids.length();i++) { JSONObject row=find(ids.optString(i));if(row!=null) result.add(item(row)); }
        return result;
    }
    List<MediaItem> search(String query) {
        List<MediaItem> result=new ArrayList<>();String term=query.toLowerCase(Locale.ROOT).trim();
        for(JSONObject row:tracks) if((row.optString("title")+" "+row.optString("artist")+" "+row.optString("album")).toLowerCase(Locale.ROOT).contains(term)) result.add(item(row));
        return result;
    }
}
