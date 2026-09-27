import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_NETEASE_IMPORTS } from './neteaseLibrary.js';

async function requestJson(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `请求失败（${response.status}）`);
  return payload;
}

function Art({ src, title }) {
  return src ? <img src={src} alt={`${title} 封面`} draggable="false" /> : <span className="bridge-art-fallback">♫</span>;
}

export default function NeteaseBridge({ open, onClose, onImport, onClear, importedCount }) {
  const panelRef = useRef(null);
  const [profile, setProfile] = useState({ loggedIn: false });
  const [playlists, setPlaylists] = useState([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const desktop = Boolean(window.orbitDesktop?.isDesktop);
  const selectedSongs = useMemo(() => preview?.songs?.filter(song => selected.has(song.id)) || [], [preview, selected]);

  const loadPlaylists = async () => {
    setBusy('playlists');
    try {
      const payload = await requestJson('/api/netease/user/playlists');
      setProfile(payload.profile || { loggedIn: true });
      setPlaylists(payload.playlists || []);
    } catch (reason) { setError(reason.message); }
    finally { setBusy(''); }
  };

  const refreshStatus = async () => {
    try {
      const next = await requestJson('/api/netease/login/status');
      setProfile(next);
      if (next.loggedIn) await loadPlaylists();
    } catch { setProfile({ loggedIn: false }); }
  };

  useEffect(() => {
    if (!open) return undefined;
    setError('');
    refreshStatus();
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    requestAnimationFrame(() => panelRef.current?.focus());
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const login = async () => {
    if (!desktop) return setError('扫码登录仅在 ORBIT 桌面应用中开放。');
    setBusy('login'); setError('');
    try {
      const result = await window.orbitDesktop.openNeteaseLogin();
      if (!result?.ok) throw new Error(result?.message || result?.error || '扫码登录未完成');
      setProfile(result.profile || { loggedIn: true });
      await loadPlaylists();
    } catch (reason) { setError(reason.message); }
    finally { setBusy(''); }
  };

  const logout = async () => {
    setBusy('logout'); setError('');
    try {
      if (desktop) await window.orbitDesktop.clearNeteaseLogin();
      else await requestJson('/api/netease/logout', { method: 'POST' });
      setProfile({ loggedIn: false }); setPlaylists([]); setPreview(null);
    } catch (reason) { setError(reason.message); }
    finally { setBusy(''); }
  };

  const search = async event => {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy('search'); setError('');
    try {
      const payload = await requestJson(`/api/netease/search?keywords=${encodeURIComponent(query.trim())}&limit=20`);
      setResults(payload.songs || []);
    } catch (reason) { setError(reason.message); }
    finally { setBusy(''); }
  };

  const openPlaylist = async playlist => {
    setBusy(`playlist:${playlist.id}`); setError('');
    try {
      const payload = await requestJson(`/api/netease/playlist/tracks?id=${encodeURIComponent(playlist.id)}&limit=all`);
      const songs = payload.songs || [];
      setPreview({ ...playlist, ...(payload.playlist || {}), songs });
      setSelected(new Set(songs.slice(0, MAX_NETEASE_IMPORTS).map(song => song.id)));
    } catch (reason) { setError(reason.message); }
    finally { setBusy(''); }
  };

  const toggle = id => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else if (next.size < MAX_NETEASE_IMPORTS) next.add(id);
    return next;
  });

  const importPreview = () => {
    const count = onImport(selectedSongs, { id: preview.id, name: preview.name, cover: preview.cover, replace: true });
    if (!count) setError('没有可导入的新歌曲。');
    else onClose();
  };

  if (!open) return null;
  return (
    <div className="bridge-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="qq-bridge netease-bridge glass" ref={panelRef} tabIndex="-1" aria-label="网易云音乐桥">
        <div className="bridge-head">
          <div><span className="eyebrow">NETEASE CLOUD MUSIC</span><h2>网易云音乐桥</h2></div>
          <button className="bridge-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="bridge-status">
          <span className={`bridge-pulse ${profile.loggedIn ? 'online' : ''}`} />
          <div><strong>{profile.loggedIn ? (profile.nickname || '已连接网易云音乐') : '等待扫码登录'}</strong><small>独立安全会话 · 仅同步 MUSIC_U 登录凭据</small></div>
          <button onClick={profile.loggedIn ? logout : login} disabled={Boolean(busy)}>{busy === 'login' ? '等待扫码…' : profile.loggedIn ? '退出登录' : '扫码登录'}</button>
        </div>
        <div className="bridge-grid">
          <div className="bridge-pane">
            <span className="bridge-label">搜索网易云</span>
            <form className="bridge-input-row" onSubmit={search}>
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="歌曲 / 歌手 / 专辑" />
              <button disabled={busy === 'search'}>{busy === 'search' ? '搜索中' : '搜索'}</button>
            </form>
            <div className="bridge-results">
              {results.map(song => <div className="bridge-song" key={song.id}>
                <Art src={song.cover} title={song.name} />
                <div><strong>{song.name}</strong><small>{song.artist} · {song.album}</small></div>
                <button onClick={() => { const count = onImport([song], { name: '网易云零散导入' }); if (!count) setError('这首歌已经导入或曲库已满。'); }}>＋</button>
              </div>)}
              {!results.length && <div className="bridge-empty">扫码后可读取账号歌单；也可以直接搜索歌曲。</div>}
            </div>
          </div>
          <div className="bridge-pane bridge-library">
            {preview ? <>
              <div className="bridge-preview-head"><button className="bridge-preview-back" onClick={() => setPreview(null)}>←</button><span><strong>{preview.name}</strong><small>已选 {selected.size} / {MAX_NETEASE_IMPORTS} · 共 {preview.songs.length} 首</small></span></div>
              <div className="bridge-preview-actions"><span>选择要放进音乐宇宙的歌曲</span><button onClick={() => setSelected(new Set(preview.songs.slice(0, MAX_NETEASE_IMPORTS).map(song => song.id)))}>前 30 首</button><button onClick={() => setSelected(new Set())}>清空</button></div>
              <div className="bridge-preview-list">{preview.songs.map(song => <label className={`bridge-preview-row ${selected.has(song.id) ? 'checked' : ''}`} key={song.id}><input type="checkbox" checked={selected.has(song.id)} onChange={() => toggle(song.id)} /><b>{song.name}</b><small>{song.artist} · {song.album}</small></label>)}</div>
              <button className="bridge-preview-import" disabled={!selected.size} onClick={importPreview}>导入 {selected.size} 首到音乐宇宙</button>
            </> : <>
              <div className="bridge-pane-title"><span className="bridge-label">我的歌单</span><small>{profile.loggedIn ? `${playlists.length} 个歌单` : '扫码后读取'}</small></div>
              <div className="bridge-playlists">{playlists.map(playlist => <button className="bridge-playlist" key={playlist.id} onClick={() => openPlaylist(playlist)} disabled={Boolean(busy)}><Art src={playlist.cover} title={playlist.name} /><span><strong>{playlist.name}</strong><small>{playlist.trackCount} 首{playlist.subscribed ? ' · 收藏' : ''}</small></span><b>{busy === `playlist:${playlist.id}` ? '读取中' : '打开'}</b></button>)}{!playlists.length && <div className="bridge-empty">完成扫码后，这里会显示账号中的歌单和「我喜欢的音乐」。</div>}</div>
            </>}
          </div>
        </div>
        <div className="bridge-foot"><span>每个歌单最多 {MAX_NETEASE_IMPORTS} 首 · 不保存账号密码</span><span>本机歌单共 {importedCount} 首</span>{importedCount > 0 && <button className="bridge-clear" onClick={onClear}>清空网易云曲库</button>}</div>
        {error && <div className="bridge-error">{error}</div>}
      </section>
    </div>
  );
}
