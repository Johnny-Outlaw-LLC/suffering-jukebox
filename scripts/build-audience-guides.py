"""Build the audience guides from one source for both brands and the RK preview.

Run with Python; optionally pass the Outlaw Apps repository to export its preview.
Public dashboards use interactive fictional content; only empty workflow screens are screenshots.
"""
from pathlib import Path
from html import escape
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
# Headings and prose use the full available column width (user preference).
CSS = '''
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 Inter,system-ui,sans-serif}a{color:inherit}a:hover{color:var(--accent)}a:focus-visible,summary:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:5px}header{border-bottom:1px solid var(--line)}.top{max-width:none;margin:auto;padding:20px 28px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{display:flex;align-items:center;text-decoration:none}.brand img{max-width:240px;max-height:64px;object-fit:contain}.brand span{font-size:20px;font-weight:800}.top nav{display:flex;flex-wrap:wrap;gap:20px;font-size:14px;font-weight:650}.top nav a{text-decoration:none}.top nav a[aria-current]{color:var(--accent)}main{max-width:none;padding:0 28px 80px;margin:auto}.hero{padding:48px 0 32px}.eyebrow{color:var(--accent);text-transform:uppercase;font-size:12px;letter-spacing:.18em;font-weight:800}h1{font-size:clamp(42px,6.2vw,76px);line-height:1.06;letter-spacing:-.055em;margin:18px 0 24px}h2{font-size:clamp(28px,3.3vw,40px);line-height:1.15;letter-spacing:-.035em;margin:12px 0 18px}h3{font-size:21px;line-height:1.3;margin:0 0 10px}p{margin:0 0 18px}.lede{font-size:21px;line-height:1.6;color:var(--muted)}.buttons{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.button{background:var(--accent);color:#170f0a!important;text-decoration:none;padding:12px 19px;border-radius:8px;font-weight:750}.button.secondary{background:var(--card);color:var(--ink)!important;border:1px solid var(--line)}.jump{display:flex;flex-wrap:wrap;gap:10px;padding-bottom:30px;border-bottom:1px solid var(--line)}.jump a{background:var(--card);border:1px solid var(--line);border-radius:30px;padding:6px 14px;text-decoration:none;font-size:13px}section{padding:56px 0;border-bottom:1px solid var(--line)}.split{display:grid;grid-template-columns:minmax(0,1fr);gap:38px;align-items:start}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:28px}.card{padding:24px;background:var(--card);border:1px solid var(--line);border-radius:12px}.card p{font-size:15px;color:var(--muted);margin:0}.note{padding:20px 24px;border-left:3px solid var(--accent);background:var(--card);border-radius:0 10px 10px 0;margin:24px 0;color:var(--muted)}strong{color:var(--ink)}figure{margin:26px 0 0}figure a{display:block;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--card)}figure img{display:block;width:100%;height:auto}figcaption{font-size:12px;color:var(--muted);margin:10px 2px;line-height:1.6}details{margin:20px 0;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}summary{cursor:pointer;padding:20px 24px;font-weight:750;list-style:none;display:flex;gap:20px;align-items:center;justify-content:space-between}summary::-webkit-details-marker{display:none}summary::after{content:'+';font-size:26px;color:var(--accent);line-height:1}details[open] summary::after{content:'−'}details[open] summary{border-bottom:1px solid var(--line)}.inside{padding:10px 24px 24px}ol{padding-left:24px}li{padding-left:6px;margin:16px 0}li p{color:var(--muted);margin:4px 0}code{font-size:.9em;background:var(--bg);padding:2px 5px;border-radius:4px}.closing{padding:48px 0 0}footer{border-top:1px solid var(--line);padding:24px 28px;font-size:13px;color:var(--muted)}.footer-in{max-width:none;margin:auto;display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px}.preview{padding:9px 20px;text-align:center;background:#fff8ed;color:#171717;font-size:12px}.preview a{color:#9d3514}.shot-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}.demo-example iframe{width:100%;height:1000px;display:block;border:1px solid var(--line);border-radius:12px;background:var(--card)}.demo-example figcaption a{font-weight:650}.features{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}.feature{margin:0}.feature-title{display:block;font-size:22px;line-height:1.3}.feature-description{display:block;margin-top:6px;font-weight:400;color:var(--muted);font-size:16px;line-height:1.5}.feature summary{align-items:start}.feature summary::after{flex:none}.feature .inside{padding-top:12px}.feature ul{padding-left:24px;margin:0 0 16px}.feature li{padding-left:2px}.footer-in nav{display:flex;flex-wrap:wrap;gap:20px;font-size:14px}.muted{color:var(--muted)}@media(max-width:760px){.top{align-items:flex-start;flex-direction:column;padding:18px 20px;gap:14px}.brand img{max-width:215px}.top nav{gap:16px}main{padding:0 20px 48px}.hero{padding:44px 0 32px}.lede{font-size:18px}.split,.cards,.shot-grid{grid-template-columns:1fr;gap:22px}section{padding:36px 0}.inside,summary{padding-left:18px;padding-right:18px}footer{padding:24px 20px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
'''


def image(name, caption, assets):
    demos = {
        'artist-stats': ('artist-stats', 'Try the artist dashboard: change the date range, inspect daily plays, and explore the songs and heart moments.'),
        'listener-analytics': ('analytics', 'Try the listener dashboard: filter platforms, dates, artists, and songs, or add a missing song to the demo collection.'),
        'discography': ('catalog', 'Explore the fictional Harbor Signal release and add tracks to the Evening Drive demo playlist.'),
        'lyric-sync': ('lyrics', 'Try splitting fictional album lyrics and preview how saved timing highlights each line.'),
        'history-to-catalog': ('history', 'Try the history-to-catalog flow with fictional music: choose songs, find sample matches, review, and add them to the demo.'),
        'share-hub': ('catalog', 'Explore a sample release and playlist built entirely from fictional content.'),
    }
    if name == 'album-lyrics': return ''  # the combined lyric demo covers both upload and timing
    if name in demos:
        mode, description = demos[name]
        rk = assets.startswith('/record-keeper')
        brand = 'rk' if rk else '__GUIDE_BRAND__'
        url = '/demo/' + mode + '?brand=' + brand
        return f'<figure class="demo-example"><iframe data-demo src="{url}&amp;embed=1" title="{escape(description)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups"></iframe><figcaption>Interactive fictional demo · {description} <a href="{url}" target="_blank" rel="noopener">Open the full demo →</a></figcaption></figure>'
    path = assets + '/' + name + '.png'
    return f'<figure><a href="{path}" target="_blank" rel="noopener" aria-label="Open full-size screenshot: {escape(caption)}"><img src="{path}" alt="{escape(caption)}" loading="lazy" decoding="async"></a><figcaption>{caption} · Actual application screenshot. Select the image to enlarge.</figcaption></figure>'

def feature(key, title, description, body):
    return f'<details class="feature" id="{key}"><summary><span><span class="feature-title">{title}</span><span class="feature-description">{description}</span></span></summary><div class="inside">{body}</div></details>'


def artists(link, assets, name):
    intro = f'<div class="hero"><p class="eyebrow">For artists</p><h1>A place for your music and the people who love it.</h1><p class="lede">{name} was created by music fans as a way to dive deeper into the music we love. If you make that music, we want to help you share it, bring listeners closer to it, and understand how it connects. We hope you find these features as helpful and fun as we do.</p><div class="buttons"><a class="button" href="{link("/artist-upload")}">Publish your music</a><a class="button secondary" href="{link("/artist-stats")}">Artist Stats</a></div></div>'
    boxes = [
        feature('upload', 'Upload your music, with or without a video', 'Give albums, singles, and unreleased songs a home.', f'''<ul><li><strong>Upload your recordings.</strong> Add audio files, cover art, song titles, and release dates. Your music does not need to be on YouTube.</li><li><strong>Make a discography fans can explore.</strong> Keep releases and lyrics together on your artist page. A recording can have a video, or let the audio and artwork speak for themselves.</li><li><strong>Publish music you control.</strong> Sign in, create your release, complete the rights agreement, and submit it for approval. Drafts stay private during review.</li></ul><p><a href="{link('/artist-discography-upload')}">Open the release uploader</a> · <a href="{link('/artist-agreement')}">Read the artist agreement</a></p>{image('artist-upload','The release uploader, ready for your music, artwork, and track details.',assets)}'''),
        feature('import', 'Bring in music already on YouTube', 'Artist, playlist, and song imports keep your catalog together.', '<ul><li><strong>Artist import.</strong> Find an artist and review the matches for releases and songs.</li><li><strong>Playlist import.</strong> Paste a public YouTube playlist link to build a collection.</li><li><strong>Song import.</strong> Add a public YouTube video and check its artist, album, and song details.</li><li>Imported videos play through YouTube. Uploading your own approved recording makes that audio available directly to fans.</li></ul>'),
        feature('lyrics', 'Put your words beside your music', 'Add missing lyrics and sync them line by line.', f'''<ul><li><strong>Scrolling lyrics.</strong> Fans can follow the words in the docked player or full screen.</li><li><strong>Add lyrics for a song or an album.</strong> Paste the words or upload a text or LRC file, then check each song assignment.</li><li><strong>Sync the timing.</strong> Use Add Lyric Syncing and stamp each line as it begins. Preview, adjust, and save.</li><li>Listeners can heart a moment or react to a lyric, giving you another way to see what stays with them.</li></ul>{image('lyric-sync','Try lyric syncing with fictional songs.',assets)}'''),
        feature('playback', 'Keep your music playing on mobile', 'Approved artist audio supports background playback and Apple CarPlay.', '<ul><li>Approved artist-uploaded recordings are available to listeners for background play automatically. They do not need to upload their own copy.</li><li>Fans can listen with the screen locked or the mobile app in the background, and through Apple CarPlay in the iPhone app.</li><li>YouTube video playback needs the screen on. A YouTube link alone does not enable background or CarPlay playback.</li></ul>'),
        feature('discovery', 'Help fans find your recordings', 'Artist Uploaded makes direct releases easier to discover.', f'''<ul><li>Listeners can choose <strong>Artist Uploaded</strong> in Explore Artists or Explore Songs, or select <strong>Artist Uploaded only</strong> in Search.</li><li>Your release can reach listeners even if it has no YouTube video or YouTube play count.</li><li>Share artist, album, song, and playlist links so fans can start exploring.</li></ul>{image('discography','Explore a fictional artist page and playlist.',assets)}'''),
        feature('playlists', 'Give your audience playlists to make their own', 'Make a release playlist, a set list, or a collection of influences.', '<ul><li>Keep playlists private or make them public. Choose whether others can only listen or also contribute songs.</li><li>Fans can add your tracks to their own playlists, blend collections with Shuffle All, or use the ⋯ menu to add them to the queue.</li><li>Create a playlist directly from a public YouTube playlist link.</li></ul>'),
        feature('share', 'Listen together with your fans', 'Start a room for a release, a listening party, or a few favorite songs.', '<ul><li>Invite people with the room link or QR code to listen to the same music in real time.</li><li>Let listeners contribute songs if you want a shared queue.</li><li>Set permissions for individual guests. You can stop that one guy from adding Creed… again.</li></ul>'),
        feature('versions', 'Bring your different versions together', 'Music videos, live performances, covers, and the original recording.', '<ul><li>Open <strong>Alternative Versions</strong> from a song’s ⋯ menu to discover other recordings.</li><li>Choose a default video for playback and YouTube stats, and adjust lyric timing for a version with a different intro.</li><li>Watch versions side by side and use the volume mixer to compare them.</li></ul>'),
        feature('stats', 'Data, data, data!', 'See how listeners respond without waiting for an end-of-year recap.', f'''<ul><li><strong>Your private artist dashboard.</strong> See plays, listeners, returning listeners, listening time, playlist adds, and artist-page visits.</li><li><strong>Choose a date range.</strong> See daily activity, compare songs, or choose All Artists to combine the artists your account is authorized to view.</li><li><strong>See what connects.</strong> Hearts and lyric reactions show favorite moments. The share of a song heard, where measured, helps you understand how much people listened.</li><li>Refresh for the latest recorded activity. Older plays may have no listening-time measurement, and an early ending does not by itself explain why someone stopped.</li><li>YouTube plays and plays inside {name} are separate measures; direct uploads can have listening activity without a YouTube count.</li></ul><p><a href="{link('/artist-stats')}">Open Artist Stats</a></p>{image('artist-stats','Explore a fictional artist dashboard.',assets)}'''),
    ]
    return intro + '<div class="features">' + ''.join(boxes) + '</div>'


def listeners(link, assets, name):
    intro = f'<div class="hero"><p class="eyebrow">For listeners</p><h1>Made by music fans, for music fans.</h1><p class="lede">{name} was created by music fans as a way to dive deeper into the music we love. We hope you find these features as helpful and fun as we do.</p><div class="buttons"><a class="button" href="{link("/")}">Explore music</a><a class="button secondary" href="{link("/analytics")}">My listening stats</a></div></div>'
    boxes = [
        feature('import', 'Add music from public YouTube videos', 'Bring in an artist, a playlist, or just one song.', '<ul><li><strong>Artist import.</strong> Find an artist, explore the releases, and review the song matches before adding them.</li><li><strong>Playlist import.</strong> Paste a public YouTube playlist link to create a playlist.</li><li><strong>Song import.</strong> Add a public YouTube video, then check its artist, album, and song details.</li><li>Videos must be available for playback through YouTube; some uploads restrict embedding or availability.</li></ul>'),
        feature('playlists', 'Playlists that are easy to work with', 'Create a collection, share it, and blend it with another.', f'''<ul><li><strong>Private or public.</strong> Choose who can listen and whether others can add songs.</li><li><strong>Mix your playlists.</strong> Use Shuffle All after filtering, or open the ⋯ menu to add a playlist to the queue.</li><li><strong>Start with a YouTube link.</strong> Create a playlist directly from a public YouTube playlist.</li></ul>{image('discography','Explore a fictional release and build a playlist.',assets)}'''),
        feature('lyrics', 'Lyrics that scroll as the song plays', 'Follow the words, fill in the gaps, and get the timing right.', f'''<ul><li>Scrolling lyrics work in the docked player and full screen when timing is available.</li><li>Add missing lyrics, or correct the words where editing is available.</li><li>Use <strong>Add Lyric Syncing</strong> to stamp each line as it begins, preview the timing, and save it.</li></ul>{image('lyric-sync','Try lyric syncing with fictional songs.',assets)}'''),
        feature('background', 'Background play on mobile is possible', 'Take eligible audio from your screen to your pocket or your car.', f'''<ul><li>Music added to {name} through YouTube plays while the screen is on. YouTube video playback does not support our background or CarPlay audio mode.</li><li><strong>Upload your personal library.</strong> Think of an old-school iPod or MP3 player: add your audio in Settings → Audio Storage, match it to the songs, and listen privately in the mobile app with the screen off or through Apple CarPlay.</li><li><strong>Artist-uploaded audio.</strong> Approved artist recordings are available for background play and CarPlay automatically; you do not need a personal copy.</li><li>Use <strong>Background Enabled</strong> to find eligible music. A playlist is background-enabled as a whole only when every song has usable audio.</li></ul>'''),
        feature('discovery', 'Discover artist-uploaded music', 'Find recordings that do not need a YouTube video.', f'''<ul><li>Artists can upload their own recordings even when the songs are not on YouTube.</li><li>Choose <strong>Artist Uploaded</strong> in Explore Artists or Explore Songs, or <strong>Artist Uploaded only</strong> in Search.</li><li>A release may have a video, or just audio and artwork. It may have no YouTube play count.</li><li>Your listening helps artists see how their music connects. Where measured, they can see how much of a song was heard, and the moments that earned hearts or lyric reactions. Listening and sharing feedback helps the artist.</li></ul><p><a href="{link('/for-artists')}">See what artists can do</a></p>'''),
        feature('share', 'Listening together', 'The same music, in real time, with a queue you can share.', '<ul><li>Start a room and invite others with its link or QR code.</li><li>Optionally let listeners add songs to the queue.</li><li>Set permissions by guest, so you can stop that one guy from adding Creed… again.</li></ul>'),
        feature('versions', 'Alternative versions', 'Music videos, live performances, covers, and more.', '<ul><li>Open <strong>Alternative Versions</strong> from the song’s ⋯ menu to discover other versions.</li><li>Choose a default video for playback and YouTube stats.</li><li>Watch videos side by side with a volume mixer so you can compare recordings.</li></ul>'),
        feature('customize', 'Customize your music listening', 'A few filters can turn a big catalog into your next quick mix.', '<ul><li>Filter by submitter or artist, then use Shuffle All for a quick mix.</li><li>Use the X controls to hide artists or playlists you do not want in your exploration.</li><li>Pick up where you left off with remembered position across signed-in devices.</li><li>Search by lyrics, song name, artist, or album.</li></ul>'),
        feature('stats', 'Data, data, data!', 'Your listening story is ready whenever you want to look.', f'''<ul><li><strong>Up-to-date listening stats.</strong> Refresh your dashboard for the latest recorded activity. No waiting for the end-of-year recap.</li><li><strong>Take your data with you.</strong> Download song lists or play history in an Excel-friendly format.</li><li><strong>Remember your favorite moments.</strong> Heart a moment or react to a lyric as the song plays.</li><li><strong>Bring your history.</strong> Import Spotify streaming-history JSON or Google Takeout watch-history HTML into My Data &amp; Analytics. Review the preview before confirming. Imported history adds listening records; it does not upload audio.</li></ul><p><a href="{link('/analytics')}">Open My Data &amp; Analytics</a></p>{image('listener-analytics','Explore a fictional listening dashboard.',assets)}'''),
    ]
    return intro + '<div class="features">' + ''.join(boxes) + '</div>'

BRANDS = [
    dict(id='sj',name='Suffering Jukebox',url='https://sufferingjukebox.stream',logo='/suffering-jukebox-text-logo.png',bg='#120d17',card='#1c1624',ink='#faf5ed',muted='#bdb1c5',accent='#ff8c57',line='#3c3047'),
    dict(id='lp',name='Listening Party',url='https://listeningparty.stream',logo='/brand/lp/listening-party-text-logo.png',bg='#140817',card='#211027',ink='#fdf3df',muted='#c4b2c9',accent='#ff8c57',line='#43254e'),
    dict(id='rk',name='Record Keeper',url='https://recordkeeper.stream',logo='/brand/rk/wordmark-dark.png',bg='#171717',card='#222222',ink='#fff8ed',muted='#bfb8b0',accent='#ef8b63',line='#414141'),
]

def render(b, audience):
    rk = b['id'] == 'rk'
    base = ''
    assets = base + '/images/guides'
    def link(path):
        return path
    title = 'For Artists' if audience == 'artists' else 'For Listeners'
    desc = ('Upload your music, add and sync lyrics, share your discography, and understand your audience with artist stats.' if audience == 'artists' else 'Build playlists, explore artists, share music, upload background audio, and bring Spotify and Google listening history into your stats.')
    body = artists(link, assets, b["name"]) if audience == 'artists' else listeners(link, assets, b["name"])
    body = body.replace('__GUIDE_BRAND__', b['id'])
    body = body.replace('Request Spotify’s Extended Streaming History export.', '<a href="https://support.spotify.com/us/article/understanding-your-data/" target="_blank" rel="noopener">Request Spotify’s Extended Streaming History export.</a>')
    body = body.replace('Export your history with Google Takeout.', '<a href="https://takeout.google.com/" target="_blank" rel="noopener">Export your history with Google Takeout.</a>')
    preview = ''
    colors = ';'.join('--'+k+':'+b[k] for k in ['bg','card','ink','muted','accent','line'])
    icon = '/brand/rk/favicon.png' if rk else '/brand/lp/favicon.png' if b['id']=='lp' else '/favicon.png'
    nav = ''.join(f'<a href="{link("/for-"+a)}"'+(' aria-current="page"' if a == audience else '')+f'>For {a.title()}</a>' for a in ['artists','listeners'])
    html = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} | {b['name']}</title><meta name="description" content="{desc}"><meta name="robots" content="index, follow"><link rel="canonical" href="{b['url']}/for-{audience}"><meta property="og:type" content="website"><meta property="og:title" content="{title} | {b['name']}"><meta property="og:description" content="{desc}"><meta property="og:url" content="{b['url']}/for-{audience}"><meta property="og:image" content="{b['url']+b['logo']}"><link rel="icon" href="{icon}"><style>:root{{{colors}}}{CSS}</style></head><body>{preview}<header><div class="top"><a class="brand" href="{link('/')}"><img src="{b['logo']}" alt="{b['name']}"></a><nav aria-label="Main navigation"><a href="{link('/')}">Home</a><a href="{link('/help')}">Help</a></nav></div></header><main>{body}</main><footer><div class="footer-in"><span>{b['name']} · Explore. Create. Listen together.</span><nav aria-label="Audience guides">{nav}</nav></div></footer></body></html>'''
    if not rk:
        html = html.replace(b['url'] + b['logo'], b['url'] + ('/brand/lp/og-image.png' if b['id']=='lp' else '/og-image.png'))
    html = html.replace('</body>', '''<script>
window.addEventListener('message', function(event) {
  for (const frame of document.querySelectorAll('iframe[data-demo]')) {
    if (event.source !== frame.contentWindow || event.origin !== new URL(frame.src, location.href).origin) continue;
    if (event.data?.type !== 'sj:demo-size' || !Number.isFinite(event.data.height)) continue;
    frame.style.height = Math.max(400, Math.min(24000, event.data.height)) + 'px';
  }
});
</script></body>''')
    return html

for brand in BRANDS:
    for audience in ['artists', 'listeners']:
        if brand['id']=='rk':
            dest = ROOT / 'public' / ('for-' + audience) / 'rk'
        else:
            dest = ROOT / 'public' / ('for-' + audience)
            if brand['id']=='lp': dest /= 'lp'
        dest.mkdir(parents=True,exist_ok=True)
        (dest/'index.html').write_text(render(brand,audience),encoding='utf-8')
        print('Built '+brand['name']+' /for-'+audience)
if len(sys.argv)>1:
    for folder in ['guides']:
        src = ROOT/'public/images'/folder
        dest = Path(sys.argv[1])/'public/record-keeper/images'/folder
        dest.mkdir(parents=True,exist_ok=True)
        files = list(src.glob('*')) if folder=='guides' else [src/'share-hub.png']
        for file in files:
            if file.is_file(): shutil.copy2(file,dest/file.name)
