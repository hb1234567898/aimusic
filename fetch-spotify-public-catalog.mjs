import { writeFile } from 'node:fs/promises';

const playlistId = '37i9dQZF1DZ06evO22XGKK';
const selectedTitles = [
  'If The Sun Burns Out Tonight',
  'Die For You',
  'Last Shot',
  'in my zone',
  'EGO',
  'Ticking Away',
  'Clarity - BUNT. Remix',
  'M.I.A - VALORANT Game Changers Version',
  'UNDEFEATED',
  'Fire Again',
  "Can't Slow Me Down",
  'Toxic',
  'VISIONS',
  'RUN!',
  "my lawyer said don't",
  'superHuman',
  'Shinpai Muyou',
  'SUPERPOWER',
  'RE-IGNITION',
  'IN THE RING',
  'RAJA',
  '>one (greater than one)',
  'Watch',
  'La Lumière',
  'When the World Ends',
  '2WORLDS (Demo Version)',
  'Savior',
  'You Call Me Reckless',
  'Stay Awake',
  'Chaos In The House - Valorant Masters London'
];

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function getHtml(url, retries = 3) {
  const response = await fetch(url, {headers:{'User-Agent':'ORBIT Music/1.0'}});
  if (response.status === 429 && retries > 0) {
    await sleep((Number(response.headers.get('retry-after')) || 2) * 1000);
    return getHtml(url, retries - 1);
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}

function readNextData(html) {
  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Spotify 嵌入页缺少 __NEXT_DATA__');
  return JSON.parse(match[1]);
}

function entityFrom(html) {
  return readNextData(html).props.pageProps.state.data.entity;
}

function largestImage(entity) {
  return [...(entity.visualIdentity?.image || [])].sort((a, b) => (b.maxWidth || 0) - (a.maxWidth || 0))[0] || null;
}

const playlistHtml = await getHtml(`https://open.spotify.com/embed/playlist/${playlistId}`);
const playlist = entityFrom(playlistHtml);
const byTitle = new Map(playlist.trackList.map(track => [track.title, track]));
const missing = selectedTitles.filter(title => !byTitle.has(title));
if (missing.length) throw new Error(`官方歌单中缺少：${missing.join('、')}`);

const selected = selectedTitles.map(title => byTitle.get(title));
const catalog = new Array(selected.length);

for (let start = 0; start < selected.length; start += 5) {
  const batch = selected.slice(start, start + 5);
  const completed = await Promise.all(batch.map(async (entry, offset) => {
    const spotifyId = entry.uri.split(':').pop();
    const trackHtml = await getHtml(`https://open.spotify.com/embed/track/${spotifyId}`);
    const track = entityFrom(trackHtml);
    const image = largestImage(track);
    const artists = track.artists.map(artist => artist.name);
    const releaseDate = track.releaseDate?.isoString || null;
    const index = start + offset;
    return {
      id:index,
      title:track.title,
      artists,
      artist:artists.join(', '),
      durationMs:track.duration,
      duration:track.duration / 1000,
      releaseDate,
      year:releaseDate ? Number(releaseDate.slice(0, 4)) : null,
      explicit:track.isExplicit,
      spotifyId,
      spotifyUri:track.uri,
      spotifyUrl:`https://open.spotify.com/track/${spotifyId}`,
      cover:image ? {url:image.url,width:image.maxWidth,height:image.maxHeight} : null,
      previewUrl:entry.audioPreview?.url || track.audioPreview?.url || null,
      previewFormat:entry.audioPreview?.format || 'MP3_96',
      sourcePlaylist:`https://open.spotify.com/playlist/${playlistId}`,
      lyricsLookup:{
        title:track.title,
        artists:artists.join(', '),
        duration:Math.round(track.duration / 1000)
      }
    };
  }));
  completed.forEach((track, offset) => {
    catalog[start + offset] = track;
    console.log(`${String(start + offset + 1).padStart(2, '0')}/30 ${track.title}`);
  });
  await sleep(250);
}

await writeFile('spotify-valorant-catalog.json', `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`已生成 spotify-valorant-catalog.json；封面 ${catalog.filter(track => track.cover).length}/30，试听 ${catalog.filter(track => track.previewUrl).length}/30。`);

