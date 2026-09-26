import { useEffect, useMemo, useRef, useState } from 'react';
import { LOOSE_PLAYLIST_ID, MAX_QQ_IMPORTS, MAX_QQ_PLAYLISTS } from './qqLibrary.js';

async function requestJson(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `请求失败（${response.status}）`);
  return payload;
}

function playlistIdFrom(text) {
  const input = String(text || '').trim();
  if (/^\d+$/.test(input)) return input;
  try {
    const url = new URL(input);
    return url.searchParams.get('id') || url.searchParams.get('disstid') || url.pathname.match(/playlist\/(\d+)/i)?.[1] || '';
  } catch {
    return input.match(/\d{5,}/)?.[0] || '';
  }
}

function Art({ src, title }) {
  return src
    ? <img src={src} alt={`${title} 封面`} draggable="false" />
    : <span className="bridge-art-fallback">◌</span>;
}

// 上游到底发生了什么，直接摊开给用户看——以前这类失败被静默吞成「没有歌单」。
function describeDiagnostics(diagnostics) {
  const parts = [];
  if (diagnostics.created) {
    const { ok, code, message, raw, via, total } = diagnostics.created;
    const totalPart = total != null ? ` · 服务端目录总数 ${total}` : '';
    parts.push(`创建歌单：${ok ? '成功' : '失败'}${code != null ? `（code ${code}）` : ''}${message ? ` ${message}` : ''} · 原始 ${raw} 条${totalPart}${via && via !== 'fcg_user_created_diss' ? ` · ${via}` : ''}`);
  }
  if (diagnostics.collected) {
    const { ok, code, message, raw } = diagnostics.collected;
    parts.push(`收藏歌单：${ok ? '成功' : '失败'}${code != null ? `（code ${code}）` : ''}${message ? ` ${message}` : ''} · 原始 ${raw} 条`);
  }
  if (Array.isArray(diagnostics.dropped) && diagnostics.dropped.length) {
    parts.push(`被过滤：${diagnostics.dropped.map(item => `${item.name}(${item.reason})`).join('、')}`);
  }
  return parts.join('；');
}

function verdictLabel(verdict) {
  if (verdict === 'ok') return '可完整播放';
  if (verdict === 'trial') return '仅试听片段';
  if (verdict === 'denied') return '拿不到地址';
  return '检测失败';
}

export default function QQBridge({
  open, onClose, onImport, onClear, importedCount,
  playlists = [], activePlaylistId = null, onSwitchPlaylist, onRemovePlaylist,
  sampleSongs = [],
}) {
  const panelRef = useRef(null);
  const [profile, setProfile] = useState({ loggedIn: false });
  const [query, setQuery] = useState('');
  const [playlistInput, setPlaylistInput] = useState('');
  const [results, setResults] = useState([]);
  const [accountPlaylists, setAccountPlaylists] = useState([]);
  const [diagnostics, setDiagnostics] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [clearArmed, setClearArmed] = useState(false);
  // 歌单先"打开"再挑歌，不直接一把梭全导：preview 存歌单曲目，selected 存勾选的 key
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [checkRows, setCheckRows] = useState([]);
  const [checkRunning, setCheckRunning] = useState(false);
  const desktop = Boolean(window.orbitDesktop?.isDesktop);

  const songKey = (song, index) => `${song?.mid || song?.id || index}`;
  // 空位是按「单个歌单 30 首」算的，不是全局 30 首——不同歌单各算各的额度。
  const loosePlaylist = playlists.find(item => item.id === LOOSE_PLAYLIST_ID);
  const looseRoom = Math.max(0, MAX_QQ_IMPORTS - (loosePlaylist?.count || 0));
  const previewPlaylist = preview ? playlists.find(item => item.id === preview.id) : null;
  const previewRoom = previewPlaylist ? Math.max(0, MAX_QQ_IMPORTS - previewPlaylist.count) : MAX_QQ_IMPORTS;
  // 歌单个数已经满了，再开一个新歌单就装不下了（往已有歌单里补歌不受此限）
  const playlistFull = !previewPlaylist && playlists.length >= MAX_QQ_PLAYLISTS;

  const statusText = useMemo(() => {
    if (profile.loggedIn) return profile.nickname || `QQ ${profile.userId || ''}`.trim();
    return desktop ? '等待安全登录' : '网页版可搜索，桌面版支持账号歌单';
  }, [desktop, profile]);
  // 自检结论：把「要付费的歌一律被拒」和「连免费歌都拿不到」区分开——
  // 前者是账号侧没有会员权限，后者才是我们代码的问题。
  const checkSummary = useMemo(() => {
    if (!checkRows.length) return '';
    const playable = checkRows.filter(row => row.verdict === 'ok').length;
    const trial = checkRows.filter(row => row.verdict === 'trial').length;
    const hard = checkRows.filter(row => row.verdict !== 'ok' && row.verdict !== 'trial').length;
    const blockedRows = checkRows.filter(row => row.verdict !== 'ok');
    if (!blockedRows.length) return `全部 ${playable} 首都能完整播放，当前登录态的会员权限是生效的。`;

    const freeBlocked = blockedRows.filter(row => !Number(row.song?.fee)).length;
    const uin = checkRows.find(row => row.userId)?.userId;
    const who = uin ? `当前登录 QQ ${uin}` : '当前登录态';
    if (freeBlocked > 0) {
      return `${freeBlocked} 首免费歌也拿不到完整地址——这不是会员问题，是取地址链路本身失败了。`;
    }
    const detail = trial ? `${trial} 首只给了试听片段` : '';
    const hardPart = hard ? `${detail ? '，' : ''}${hard} 首连地址都没有` : '';
    return `${who}：需要会员的 ${blockedRows.length} 首歌${detail}${hardPart}，免费歌却能完整播放。说明 QQ 没把这个登录态认定成会员——多半是 ORBIT 里登录的号和买会员的号不是同一个。`;
  }, [checkRows]);

  const playlistGroups = useMemo(() => ([
    { key: 'created', label: '我创建的歌单', items: accountPlaylists.filter(playlist => !playlist.subscribed) },
    { key: 'collected', label: '我收藏的歌单', items: accountPlaylists.filter(playlist => playlist.subscribed) },
  ]), [accountPlaylists]);
  const createdCount = playlistGroups[0].items.length;

  const refreshStatus = async () => {
    try {
      const next = await requestJson('/api/qq/login/status');
      setProfile(next);
      return next;
    } catch {
      setProfile({ loggedIn: false });
      return { loggedIn: false };
    }
  };

  const loadPlaylists = async () => {
    setBusy('playlists');
    setError('');
    try {
      const payload = await requestJson('/api/qq/user/playlists');
      setAccountPlaylists(payload.playlists || []);
      setDiagnostics(payload.diagnostics || null);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    setClearArmed(false);
    refreshStatus().then(next => { if (next.loggedIn) loadPlaylists(); });
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    requestAnimationFrame(() => panelRef.current?.focus());
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const login = async () => {
    if (!desktop) {
      setError('账号授权只在 ORBIT 桌面应用中开放。');
      return;
    }
    setBusy('login');
    setError('');
    try {
      const result = await window.orbitDesktop.openQQLogin();
      if (!result?.ok) throw new Error(result?.message || result?.error || '登录未完成');
      setProfile(result.profile || { loggedIn: true });
      await loadPlaylists();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy('');
    }
  };

  const logout = async () => {
    setBusy('logout');
    setError('');
    try {
      if (desktop) await window.orbitDesktop.clearQQLogin();
      else await requestJson('/api/qq/logout', { method: 'POST' });
      setProfile({ loggedIn: false });
      setAccountPlaylists([]);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy('');
    }
  };

  const search = async event => {
    event?.preventDefault();
    if (!query.trim()) return;
    setBusy('search');
    setError('');
    try {
      const payload = await requestJson(`/api/qq/search?keywords=${encodeURIComponent(query.trim())}&limit=16`);
      setResults(payload.songs || []);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy('');
    }
  };

  // 播放权限自检：拿当前歌单里的歌逐首去问 QQ「要不要付费 + 给不给地址」。
  // 这两件事对着看就能定案——要付费且拿不到 = QQ 不认这个登录态的会员；
  // 免费也拿不到 = 我们这条取地址的链路有问题。
  const runSelfCheck = async () => {
    const songs = (sampleSongs || []).filter(item => item?.mid).slice(0, 5);
    if (!songs.length) {
      setError('当前歌单里还没有 QQ 歌曲，先导入几首再自检。');
      return;
    }
    setCheckRunning(true);
    setCheckRows([]);
    setError('');
    const rows = [];
    for (const song of songs) {
      try {
        const result = await requestJson(`/api/qq/selfcheck?mid=${encodeURIComponent(song.mid)}&mediaMid=${encodeURIComponent(song.mediaMid || '')}`);
        rows.push({ title: song.title, ...result });
      } catch (reason) {
        rows.push({ title: song.title, ok: false, url: { message: reason.message } });
      }
      setCheckRows(rows.slice());
    }
    setCheckRunning(false);
  };

  const importSongs = (songs, meta = null) => {
    const count = onImport(songs || [], meta);
    if (!count) {
      setError(meta ? '这些歌已经在这个歌单里了。' : '这些歌曲已经在音乐宇宙里了。');
      return 0;
    }
    setError('');
    return count;
  };

  // 打开歌单：只取曲目列出来给用户挑，不在这里导入
  const openPlaylist = async rawId => {
    const id = playlistIdFrom(rawId);
    if (!id) {
      setError('没有识别到 QQ 音乐歌单 ID。');
      return;
    }
    if (playlistFull) {
      setError(`本机最多保存 ${MAX_QQ_PLAYLISTS} 个歌单，请先移除一个再导入新的。`);
      return;
    }
    setBusy(`playlist:${id}`);
    setError('');
    try {
      const payload = await requestJson(`/api/qq/playlist/tracks?id=${encodeURIComponent(id)}&limit=all`);
      const songs = payload.tracks || payload.songs || [];
      if (!songs.length) {
        setError('这个歌单没有取到歌曲，可能受版权或隐私设置限制。');
        return;
      }
      setPreview({
        id,
        name: payload.playlist?.name || `歌单 ${id}`,
        cover: payload.playlist?.cover || '',
        creator: payload.playlist?.creator || '',
        sourceUrl: payload.playlist?.sourceUrl || '',
        trackCount: payload.playlist?.trackCount || songs.length,
        loadedCount: songs.length,
        songs,
      });
      // 默认先按剩余空位从头勾选，用户再自己增删。
      // 这里必须现场算：setPreview 之后本轮闭包里的 previewRoom 还是上一个歌单的。
      const existing = playlists.find(item => item.id === id);
      const roomNow = existing ? Math.max(0, MAX_QQ_IMPORTS - existing.count) : MAX_QQ_IMPORTS;
      setSelected(new Set(songs.slice(0, roomNow).map(songKey)));
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy('');
    }
  };

  const closePreview = () => {
    setPreview(null);
    setSelected(new Set());
  };

  const toggleSong = (key, checked) => {
    setError('');
    setSelected(previous => {
      const next = new Set(previous);
      if (checked) {
        if (next.size >= previewRoom) {
          setError(previewPlaylist ? `这个歌单最多 ${MAX_QQ_IMPORTS} 首，已经选满了。` : `单个歌单最多 ${MAX_QQ_IMPORTS} 首，已经选满了。`);
          return previous;
        }
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (!preview) return;
    setError('');
    setSelected(new Set(preview.songs.slice(0, previewRoom).map(songKey)));
  };

  const importSelected = () => {
    if (!preview) return;
    if (playlistFull) {
      setError(`本机最多保存 ${MAX_QQ_PLAYLISTS} 个歌单，请先移除一个再导入新的。`);
      return;
    }
    const songs = preview.songs.filter((song, index) => selected.has(songKey(song, index)));
    if (!songs.length) {
      setError('还没勾选任何歌曲。');
      return;
    }
    importSongs(songs, {
      id: preview.id,
      name: preview.name,
      cover: preview.cover || '',
      creator: preview.creator || '',
      sourceUrl: preview.sourceUrl || '',
    });
    closePreview();
  };

  if (!open) return null;
  return (
    <div className="bridge-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="qq-bridge glass" ref={panelRef} tabIndex="-1" role="dialog" aria-modal="true" aria-label="QQ 音乐桥">
        <header className="bridge-head">
          <div>
            <span className="eyebrow">ORBIT BRIDGE / QQ MUSIC</span>
            <h2>把账号里的声音，投进音乐宇宙。</h2>
          </div>
          <button className="bridge-close" onClick={onClose} aria-label="关闭 QQ 音乐桥">×</button>
        </header>

        <div className="bridge-status">
          <span className={`bridge-pulse ${profile.loggedIn ? 'online' : ''}`} />
          <div><strong>{statusText}</strong><small>{profile.loggedIn ? '登录态保存在桌面应用的独立安全会话中' : '搜索无需登录，播放与私人歌单需要登录'}</small></div>
          {profile.loggedIn
            ? <button onClick={logout} disabled={Boolean(busy)}>退出</button>
            : <button onClick={login} disabled={busy === 'login'}>{busy === 'login' ? '等待登录…' : '连接 QQ 音乐'}</button>}
        </div>

        {profile.loggedIn && (
          <div className="bridge-check">
            <div className="bridge-check-head">
              <span><strong>播放权限自检</strong><small>用当前歌单的歌问 QQ：要不要付费、给不给地址</small></span>
              <button onClick={runSelfCheck} disabled={checkRunning || Boolean(busy)}>{checkRunning ? '检测中…' : '检测'}</button>
            </div>
            {checkSummary ? <p className="bridge-check-summary">{checkSummary}</p> : null}
            {checkRows.length > 0 && (
              <ul className="bridge-check-list">
                {checkRows.map((row, index) => (
                  <li key={`${row.song?.mid || index}`} className={row.verdict || 'failed'}>
                    <strong>{row.title || row.song?.name || '未知歌曲'}</strong>
                    <span>{Number(row.song?.fee) ? '需付费' : '免费'}</span>
                    <b>{verdictLabel(row.verdict)}</b>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="bridge-grid">
          <div className="bridge-pane bridge-search">
            <span className="bridge-label">搜索歌曲</span>
            <form onSubmit={search} className="bridge-input-row">
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="歌名、歌手" aria-label="搜索 QQ 音乐" />
              <button type="submit" disabled={busy === 'search'}>{busy === 'search' ? '搜索中' : '搜索'}</button>
            </form>
            <div className="bridge-results">
              {results.map(song => (
                <article className="bridge-song" key={song.mid || song.id}>
                  <Art src={song.cover} title={song.name} />
                  <div><strong>{song.name}</strong><small>{song.artist || 'QQ 音乐'}{song.album ? ` · ${song.album}` : ''}</small></div>
                  <button onClick={() => importSongs([song])} disabled={looseRoom <= 0}>＋</button>
                </article>
              ))}
              {!results.length && <div className="bridge-empty">搜索后可逐首加入，导入结果会成为可旋转的音乐卡片。</div>}
            </div>
          </div>

          <div className="bridge-pane bridge-library">
            <span className="bridge-label">私人歌单</span>
            <div className="bridge-input-row">
              <input value={playlistInput} onChange={event => setPlaylistInput(event.target.value)} placeholder="粘贴歌单链接或 ID" aria-label="QQ 音乐歌单链接" />
              <button onClick={() => openPlaylist(playlistInput)} disabled={busy.startsWith('playlist:') || playlistFull}>打开</button>
            </div>
            {!preview && playlists.length > 0 && (
              <div className="bridge-playlists">
                <section className="bridge-playlist-group">
                  <h3>本机歌单 · 点击切换<span>{playlists.length}/{MAX_QQ_PLAYLISTS}</span></h3>
                  {playlists.map(playlist => (
                    <div className={`bridge-playlist-row ${activePlaylistId === playlist.id ? 'active' : ''}`} key={playlist.id}>
                      <button className="bridge-playlist" onClick={() => onSwitchPlaylist(playlist.id)} title={`切换到「${playlist.name}」`}>
                        <Art src={playlist.cover} title={playlist.name} />
                        <span><strong>{playlist.name}</strong><small>{playlist.count} 首{playlist.creator ? ` · ${playlist.creator}` : ''}</small></span>
                        <b>{activePlaylistId === playlist.id ? '播放中' : '切换'}</b>
                      </button>
                      <button className="bridge-playlist-drop" onClick={() => onRemovePlaylist(playlist.id)} aria-label={`移除歌单 ${playlist.name}`} title={`移除「${playlist.name}」`}>×</button>
                    </div>
                  ))}
                </section>
              </div>
            )}
            {preview ? (
              <div className="bridge-preview">
                <div className="bridge-preview-head">
                  <button className="bridge-preview-back" onClick={closePreview} aria-label="返回歌单列表">←</button>
                  <span>
                    <strong>{preview.name}</strong>
                    <small>取到 {preview.loadedCount} 首{preview.trackCount > preview.loadedCount ? ` / 共 ${preview.trackCount} 首` : ''}</small>
                  </span>
                </div>
                <div className="bridge-preview-actions">
                  <span>已选 {selected.size} 首 · 还能装 {previewRoom - selected.size} 首</span>
                  <button onClick={selectAll} disabled={previewRoom <= 0}>全选可装的</button>
                  <button onClick={() => setSelected(new Set())} disabled={!selected.size}>清空</button>
                </div>
                <div className="bridge-preview-list">
                  {preview.songs.map((song, index) => {
                    const key = songKey(song, index);
                    const checked = selected.has(key);
                    return (
                      <label className={`bridge-preview-row ${checked ? 'checked' : ''}`} key={key}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && selected.size >= previewRoom}
                          onChange={event => toggleSong(key, event.target.checked)}
                        />
                        <b>{song.name}</b>
                        <small>{song.artist || 'QQ 音乐'}{song.album ? ` · ${song.album}` : ''}</small>
                      </label>
                    );
                  })}
                </div>
                <button className="bridge-preview-import" onClick={importSelected} disabled={!selected.size}>
                  导入所选 {selected.size} 首
                </button>
              </div>
            ) : (
            <div className="bridge-playlists">
              {playlistGroups.map(group => group.items.length > 0 && (
                <section className="bridge-playlist-group" key={group.key}>
                  <h3>{group.label}<span>{group.items.length}</span></h3>
                  {group.items.map(playlist => (
                    <button className="bridge-playlist" key={playlist.id} onClick={() => openPlaylist(playlist.id)} disabled={busy === `playlist:${playlist.id}` || playlistFull}>
                      <Art src={playlist.cover} title={playlist.name} />
                      <span><strong>{playlist.name}</strong><small>{playlist.trackCount || 0} 首 · {playlist.creator}</small></span>
                      <b>{busy === `playlist:${playlist.id}` ? '打开中' : '挑歌'}</b>
                    </button>
                  ))}
                </section>
              ))}
              {!profile.loggedIn && <div className="bridge-empty">连接桌面账号后，这里会显示“我喜欢”和创建、收藏的歌单。</div>}
              {profile.loggedIn && !accountPlaylists.length && (
                <div className="bridge-empty">
                  QQ 音乐暂未返回账号歌单；仍可在上方粘贴自建歌单链接或 ID 导入。
                  {diagnostics ? <span className="bridge-diag">{describeDiagnostics(diagnostics)}</span> : null}
                </div>
              )}
              {profile.loggedIn && accountPlaylists.length > 0 && !createdCount && (
                <div className="bridge-empty">
                  没有读到“我创建的歌单”，只显示了收藏部分。
                  {diagnostics ? <span className="bridge-diag">{describeDiagnostics(diagnostics)}</span> : null}
                </div>
              )}
            </div>
            )}
          </div>
        </div>

        <footer className="bridge-foot">
          <span>{importedCount} 首歌曲 · {playlists.length}/{MAX_QQ_PLAYLISTS} 个歌单已在本机</span>
          <button
            className={`bridge-clear ${clearArmed ? 'armed' : ''}`}
            disabled={!importedCount}
            onClick={() => {
              if (!clearArmed) {
                setClearArmed(true);
                setError('再次点击“确认清空”会删除全部 QQ 导入歌曲。');
                return;
              }
              onClear();
              setClearArmed(false);
              setResults([]);
              setError('QQ 导入曲库已清空。');
            }}
          >{clearArmed ? '确认清空' : '清空已导入'}</button>
          <span>播放能力取决于账号版权、会员与地区状态</span>
        </footer>
        {error && <div className="bridge-error" role="status">{error}</div>}
      </section>
    </div>
  );
}
