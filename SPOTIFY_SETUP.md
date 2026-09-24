# Spotify 数据导入

## Spotify 可以提供的数据

- 曲名、歌手、专辑、发布日期、时长、ISRC 和 Spotify ID
- 原始专辑封面地址与 Spotify 曲目链接
- `preview_url`：可能为空，Spotify 已将该字段标记为 deprecated

Spotify Web API 不提供歌词，也不允许把 Spotify 完整音频下载成文件。完整播放需要 Spotify Premium、用户 OAuth 和 Web Playback SDK。

## 无需账号生成公开歌单目录

```powershell
node .\fetch-spotify-public-catalog.mjs
```

脚本读取 Spotify 官方 VALORANT 公开嵌入歌单和单曲嵌入页，生成 `spotify-valorant-catalog.json`，包含曲目 ID、原始封面地址、发行日期、时长、Spotify 链接和公开的 30 秒试听地址。

## 使用 Spotify Web API

1. 在 Spotify for Developers 创建应用。
2. 在本机终端临时设置环境变量，不要把密钥写进 HTML、JavaScript 或 Git：

```powershell
$env:SPOTIFY_CLIENT_ID="你的 Client ID"
$env:SPOTIFY_CLIENT_SECRET="你的 Client Secret"
node .\fetch-spotify-catalog.mjs
```

脚本会生成 `spotify-catalog.json`。Spotify 目前要求应用所有者拥有有效的 Premium 订阅才能调用相关接口；没有 Premium 时请使用上面的公开嵌入目录脚本。

## 播放完整歌曲

完整播放需改用 Spotify Web Playback SDK，并让使用者登录自己的 Spotify Premium 账号。Client Secret 只能保留在本地服务端，不能放进浏览器代码。
