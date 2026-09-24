import { readFile, writeFile } from 'node:fs/promises';

async function readLocalCredentials() {
  try {
    const content = await readFile('.spotify.env.local', 'utf8');
    return Object.fromEntries(content.split(/\r?\n/).flatMap(line => {
      const separator = line.indexOf('=');
      if (separator < 1) return [];
      return [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]];
    }));
  } catch {
    return {};
  }
}

const localCredentials = await readLocalCredentials();
const clientId = process.env.SPOTIFY_CLIENT_ID || localCredentials.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || localCredentials.SPOTIFY_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('缺少 SPOTIFY_CLIENT_ID 或 SPOTIFY_CLIENT_SECRET。请先在当前终端设置环境变量。');
  process.exit(1);
}

const requestedTracks = [
  ['If The Sun Burns Out Tonight', 'Grabbitz Oli Sykes Courtney LaPlante', 2026],
  ['superHuman', 'AUDREY NUNA VALORANT', 2026],
  ['Toxic', 'KiNG MALA AUDREY NUNA VALORANT', 2026],
  ['Clarity BUNT Remix', 'Zedd Foxes BUNT VALORANT', 2026],
  ['Chaos In The House Valorant Masters London', 'Che Lingo VALORANT', 2026],
  ['M.I.A VALORANT Game Changers Version', 'KATSEYE VALORANT'],
  ['in my zone', 'bbno$ VALORANT'],
  ['Last Shot', 'templuv 347aidan VALORANT'],
  ['EGO', 'Qing Madi VALORANT'],
  ['RE-IGNITION', 'ARB4 Jazz Alonso Emei VALORANT'],
  ['You Call Me Reckless', 'F.O.O.L Essenger Life Awaits VALORANT'],
  ['RUN!', 'Odetari Lay Bankz VALORANT'],
  ['SUPERPOWER', 'KISS OF LIFE Mark Tuan VALORANT'],
  ['2WORLDS', 'Madge VALORANT'],
  ['UNDEFEATED', 'XG VALORANT'],
  ['Villain Take the Shot', 'Barns Courtney ARB4 Eytan Peled VALORANT'],
  ['RENEGADE', '99 God C103 VALORANT'],
  ['VYSE', 'Kordhell VALORANT'],
  ['Ticking Away', 'Grabbitz bbno$ VALORANT'],
  ['greater than one', 'ericdoa VALORANT'],
  ['Die For You', 'Grabbitz VALORANT'],
  ['Fire Again', 'Ashnikko VALORANT'],
  ['Casa de Vidro', 'Victor Pozas Moonsailor Bia Caboz VALORANT'],
  ['RAJA', 'ARB4 Tienas Mangal Suvarnan VALORANT'],
  ['VISIONS', 'eaJ Safari Riot VALORANT'],
  ['Entertain Me', 'Ylona Garcia VALORANT'],
  ['Karanlığın', 'Helin ARB4 VALORANT'],
  ['Underdogs', 'Mujuice VALORANT'],
  ['Watch', 'Stella Mwangi VALORANT'],
  ['Savior', 'One True God VALORANT']
];

const normalize = value => value.toLocaleLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function request(url, options = {}, retries = 3) {
  const response = await fetch(url, options);
  if (response.status === 429 && retries > 0) {
    await sleep((Number(response.headers.get('retry-after')) || 2) * 1000);
    return request(url, options, retries - 1);
  }
  if (!response.ok) {
    const message = (await response.text()).slice(0, 500);
    throw new Error(`${response.status} ${response.statusText}: ${message || url}`);
  }
  return response.json();
}

const tokenPayload = await request('https://accounts.spotify.com/api/token', {
  method: 'POST',
  headers: {
    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: new URLSearchParams({grant_type:'client_credentials'})
});

const headers = {Authorization:`Bearer ${tokenPayload.access_token}`};
const catalog = [];

for (let index = 0; index < requestedTracks.length; index++) {
  const [title, artists, year] = requestedTracks[index];
  const query = `${title} ${artists}`;
  const url = new URL('https://api.spotify.com/v1/search');
  url.search = new URLSearchParams({q:query,type:'track',limit:'10',market:'US'});
  const data = await request(url, {headers});
  const wantedTitle = normalize(title);
  const wantedArtists = normalize(artists);
  const ranked = (data.tracks?.items || []).map(track => {
    const foundTitle = normalize(track.name);
    const foundArtists = normalize(track.artists.map(artist => artist.name).join(' '));
    let score = foundTitle === wantedTitle ? 20 : foundTitle.includes(wantedTitle) || wantedTitle.includes(foundTitle) ? 10 : 0;
    for (const token of artists.split(/\s+/).map(normalize).filter(token => token.length > 2)) {
      if (foundArtists.includes(token)) score += 2;
    }
    if (foundArtists.includes('valorant') && wantedArtists.includes('valorant')) score += 5;
    return {track,score};
  }).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 12) {
    catalog.push({id:index,title,query,year:year || null,status:'not-found'});
    continue;
  }
  const track = best.track;
  catalog.push({
    id:index,
    title:track.name,
    artists:track.artists.map(artist => artist.name),
    album:track.album.name,
    releaseDate:track.album.release_date,
    year:year || Number(track.album.release_date?.slice(0, 4)) || null,
    durationMs:track.duration_ms,
    explicit:track.explicit,
    isrc:track.external_ids?.isrc || null,
    spotifyId:track.id,
    spotifyUri:track.uri,
    spotifyUrl:track.external_urls.spotify,
    cover:track.album.images?.[0] || null,
    previewUrl:track.preview_url || null,
    lyricsLookup:{title:track.name,artists:track.artists.map(artist => artist.name).join(', '),album:track.album.name,duration:Math.round(track.duration_ms / 1000)},
    status:'matched'
  });
  console.log(`${String(index + 1).padStart(2, '0')}/30 ${track.name}`);
  await sleep(180);
}

await writeFile('spotify-catalog.json', `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`已生成 spotify-catalog.json；匹配成功 ${catalog.filter(track => track.status === 'matched').length}/30。`);
