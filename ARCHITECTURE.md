# CapTube 架构文档

CapTube 是一个 Chrome / Firefox 浏览器扩展（MV2），为 YouTube 提供**双语字幕 + AI 翻译**能力。
核心设计：**注入页面 hook 数据 + 后台代理翻译 + SVG 双语渲染**。

---

## 文件树与职责

```
Captube/
│
├── 构建 / 配置层
│   ├── package.json              依赖与脚本 (build / pack)
│   ├── webpack.config.js         5 入口打包，双浏览器输出 [name].min.js
│   ├── utils/
│   │   ├── build.js              调 webpack 构建 chrome / firefox
│   │   └── pack.js               打包成 .zip 分发包
│   └── .travis.yml               CI
│
├── 扩展元数据
│   └── src/manifest.json         MV2 清单：权限 / 入口 / 资源声明
│
└── src/  源码 (约 1975 行)
    │
    ├── ① 注入桥接层
    │   └── content.js      [32]   沙箱脚本 → 注入 captube.js 到页面，传 extId/settings
    │
    ├── ② 页面核心引擎 (运行在 YouTube 真实上下文)
    │   └── captube.js     [1069]  重心：字幕发现 / 管理 / SVG 渲染
    │        ├ CaptionBase / NativeCaption / YouTubeTransCaption
    │        │   / TencentTransCaption / DeepLTransCaption   ← 字幕数据层 (状态机)
    │        ├ CaptionManager / CapTubeManager               ← 管理调度层
    │        └ RendererLoop                                  ← rAF + SVG 渲染层
    │
    ├── ③ 后台中枢
    │   └── background.js   [232]  设置存储 + 翻译请求路由 + 图标状态
    │        ├ 依赖 → tencent-helper.js  [161]  分块 / HMAC-SHA1 签名 / 限速 调腾讯 API
    │        ├ 依赖 → deepl-helper.js    [97]   分块 / 限速 调 DeepL API
    │        └ 依赖 → default-settings.js[44]   默认配置常量
    │
    ├── ④ UI 层
    │   ├── popup.html / popup.css
    │   ├── popup.js        [227]  快捷设置面板 (布局 / 字号 / API key)
    │   ├── options.html
    │   └── options.js      [77]   Pro 设置 (直接编辑 JSON)
    │
    ├── ⑤ 公共工具
    │   ├── utils.js        [27]   RateLimiter 限速器 (被两个 helper 用)
    │   └── console.js      [9]    日志加 "CapTube>" 前缀
    │
    └── 资源
        ├── icon16/32/128.png          常态彩色图标
        ├── icon*-gray.png             不适配页面 (灰)
        └── icon*-half.png             检测到 YouTube (半灰)
```

---

## 模块依赖与通信关系

```
                         chrome.storage.local
                                  ▲
                                  │ 读写设置
                          ┌───────┴────────┐
   UPDATE_SETTINGS  ┌────▶│ background.js  │◀────┐ TRANSLATION_REQUEST
   DISPATCH_SETTINGS│     │  (后台中枢)     │     │ TRANSLATION_RESULT
                    │     └───┬────────┬───┘     │ SET_ICON
        内部 port   │         │import  │import   │ 外部 port (onConnectExternal)
        ┌───────────┴──┐  ┌───▼───┐ ┌──▼─────┐   │
        │ popup.js     │  │tencent│ │deepl   │   │
        │ options.js   │  │-helper│ │-helper │   │
        └──────────────┘  └───┬───┘ └──┬─────┘   │
            (UI 设置)          └─┬──────┘         │
                          import │ utils.js       │
                       (RateLimiter 限速器)       │
                                                  │
   ═══════════ 扩展沙箱  │  页面真实上下文 ════════│═══════
                                                  │
        ┌──────────────┐  注入   ┌────────────────┴───┐
        │ content.js   │────────▶│   captube.js       │
        │ (注入桥)      │ <script>│ (CapTubeManager)   │
        └──────────────┘         └────────────────────┘
                                  hook JSON.parse 拿字幕
                                  RendererLoop 画 SVG 双语
```

---

## 消息协议 (chrome.runtime 长连接)

background.js 维护两套 port 映射：`gExtPorts`（页面，按 tabId）与 `gIntPorts`（popup/options）。

| 消息 | 方向 | 作用 |
|------|------|------|
| `UPDATE_SETTINGS`   | popup/options → bg | 修改设置 |
| `DISPATCH_SETTINGS` | bg → 所有端         | 广播最新设置 |
| `TRANSLATION_REQUEST` | 页面 → bg        | 请求翻译某段字幕 |
| `TRANSLATION_RESULT`  | bg → 页面        | 返回译文 (保留时间轴) |
| `SET_ICON`          | 页面 → bg          | 改图标状态 (灰 / 半灰 / 彩) |

---

## 三条关键链路

1. **设置同步**
   `popup/options` →`UPDATE_SETTINGS`→ `background`（存 storage）→`DISPATCH_SETTINGS`→ 广播给页面 `captube.js`

2. **翻译代理**（页面无 host 权限，必须绕后台代发 fetch）
   `captube.js` →`TRANSLATION_REQUEST`→ `background` → `tencent/deepl-helper` → 翻译 API →`TRANSLATION_RESULT`→ 回页面

3. **注入启动**
   `content.js` 在 `window.load` 后把 `captube.js` 作为 `<script>` 注入页面，使其能 hook YouTube 的 `JSON.parse`、访问 `window.ytplayer`

---

## 字幕子系统 (captube.js 内部三层)

```
数据层   CaptionBase (状态机: GENESIS → LOADING → READY/ERROR)
          ├─ NativeCaption          YouTube 原生字幕 (解析 XML)
          ├─ YouTubeTransCaption    YouTube 自带自动翻译
          ├─ TencentTransCaption    腾讯翻译
          └─ DeepLTransCaption      DeepL 翻译
              ↓ 统一 download() 接口
管理层   CaptionManager   维护原生 + 翻译字幕清单
         CapTubeManager   总指挥：连后台 port / 监听 URL 变化 / 按语言优先级挑主副字幕
              ↓
渲染层   RendererLoop     requestAnimationFrame 每帧按播放时间筛字幕行，
                          SVG 绘制双语、自动缩放、描边/背景/透明度、字幕源下拉菜单
```

**两个关键钩子**
- `hookJsonParseAndWatchForManifest()` — 劫持 `JSON.parse` 截获 `playerResponse`，拿字幕轨道列表
- `watchForUrlChange()` — 100ms 轮询，应对 YouTube SPA 无刷新跳转

---

## 翻译 Helper

两个 helper 模式一致：**分块 → 限速 (5 QPS) → 调 API → 合并 (保留时间轴)**。

| | 腾讯 (tencent-helper) | DeepL (deepl-helper) |
|---|---|---|
| 分块策略 | 按字符数 (~1950 字符) | 按行数 (~49 行) |
| 认证 | HMAC-SHA1 签名 (`crypto.subtle`) | API Key |
| 限速 | utils.js 的 RateLimiter | utils.js 的 RateLimiter |

---

## 构建与发布

- **webpack 4** + DefinePlugin 注入 `VERSION` / `BROWSER`
- 一套源码双浏览器输出：`build/chrome/`、`build/firefox/`
  （Chrome 用 `onConnectExternal`，Firefox 在 `onConnect` 内区分）
- `npm run build` → `utils/build.js`
- `npm run pack`  → 生成两个 `.zip` 分发包