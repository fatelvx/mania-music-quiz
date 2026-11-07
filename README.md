# mania music quiz

osu!mania 猜歌遊戲，三種模式：

- 🎵 **聽歌猜曲**：播官方 preview 音樂
- 👀 **看譜猜歌**：靜音，只看 note 捲動
- ⚡ **先譜後歌**：先只有譜面（2 分），時間過半放音樂（1 分）

題庫是 ranked mania 圖依 **mania 難度的遊玩次數** 排序，可以只從前 100 / 250 / 500 / 1000 組出題，數字越小越大眾。

## 架構

網站是純靜態的（`docs/`，給 GitHub Pages）。osu! API 需要 client secret，所以題庫在本機先建好：

```bash
cp .env.example .env   # 填入 OSU_CLIENT_ID / OSU_CLIENT_SECRET
node build.js          # 產生 docs/data/pool.json 與 docs/data/charts/*.json
node serve.js          # 本機預覽 http://localhost:5173
```

`build.js` 會下載每張 mania 譜面，只保留 preview 點開始 12 秒的 note，所以網站不需要碰 osu! API。
音樂直接從 `b.ppy.sh/preview/<setId>.mp3` 播放。

更新題庫：重跑 `node build.js` 後 commit `docs/data`。
