<div align="center">

<a href="https://github.com/WmjXiaoJun/GEV">
  <img src="docs/media/readme-logo.png" width="128" height="128" alt="God's Eye View logo" />
</a>

<h1>God's Eye View</h1>

<p><strong>GEV · 三维地理空间情报与 AI 分析工作台</strong></p>
<p>公开数据 · 三维态势 · 本地视觉 · 多模型 AI</p>

<p>
  <img src="docs/media/badges/node.svg" alt="Node.js 24 / 26" />
  <img src="docs/media/badges/vite.svg" alt="Vite 6" />
  <img src="docs/media/badges/cesium.svg" alt="CesiumJS 3D Globe" />
  <img src="docs/media/badges/python.svg" alt="Python 3.11+" />
  <img src="docs/media/badges/vision.svg" alt="YOLO Local Vision" />
  <img src="docs/media/badges/language.svg" alt="Chinese and English" />
  <img src="docs/media/badges/license.svg" alt="Source code MIT license" />
</p>

<p>
  <a href="https://github.com/WmjXiaoJun/GEV"><strong>本项目 GitHub</strong></a> ·
  <a href="https://github.com/bilawalsidhu/gods-eye-view"><strong>上游 GitHub</strong></a> ·
  <a href="https://github.com/bilawalsidhu">原作者 Bilawal Sidhu</a> ·
  <a href="#acknowledgements">鸣谢</a>
</p>

<p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
<p>
  <a href="#quick-start">快速启动</a> ·
  <a href="#features">全部功能</a> ·
  <a href="#buildings">建筑识别</a> ·
  <a href="#configuration">配置指南</a> ·
  <a href="#architecture">接口与结构</a> ·
  <a href="#troubleshooting">常见问题</a>
</p>

</div>

---

将公开地理数据、三维地图、目标跟踪、AI 对话、语音控制与影像识别放在同一个浏览器工作台中。从全球视角进入一座城市，查看已加载的航班、船舶、卫星和基础设施，分析当前视口，绘制标注并导出报告。

本版本基于 [Bilawal Sidhu / God's Eye View](https://github.com/bilawalsidhu/gods-eye-view)，增加了中英文界面、多供应商 AI、本地语音与声纹、YOLO 视觉、建筑轮廓融合、地形分析和情报工作台。以下按当前代码说明功能，不代表每个数据源已配置或持续在线。


<a id="quick-start"></a>
## 快速启动

### 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | `>=24.14.0 <25` 或 `>=26 <27`，以 `package.json` 为准 |
| 浏览器 | 支持 WebGL 的现代桌面浏览器；语音需要麦克风授权，浏览器转写支持因浏览器而异 |
| Python | 本地视觉、语音为可选服务，需要 Python 3.11+ |
| 网络 | 在线地图、数据源、远程模型和首次模型下载需要网络；本地推理不等于整个平台离线 |
| 硬件 | 三维地图依赖图形能力；本地模型可使用 CPU，速度取决于模型、画面和机器配置 |

### 1. 启动主应用

首次使用先克隆本仓库；应用代码直接位于仓库根目录：

```powershell
git clone https://github.com/WmjXiaoJun/GEV.git
cd GEV
npm install
npm run doctor
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
```

打开 [http://127.0.0.1:4173](http://127.0.0.1:4173)。该终端需保持运行；`--strictPort` 避免端口被占用时静默切换端口。基础地球可使用免密钥的 Esri 卫星影像与 OSM 底图。三维城市、部分图层、云端 AI 和搜索需另行配置。

### 2. 启动本地视觉与语音（Windows，可选）

在另一个 PowerShell 终端进入同一个应用目录。首次使用先安装依赖和模型：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/local-vision/setup.ps1
powershell -ExecutionPolicy Bypass -File scripts/local-speech/setup.ps1
```

后续只需启动：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/local-vision/start.ps1
powershell -ExecutionPolicy Bypass -File scripts/local-speech/start.ps1
```

脚本后台启动服务并检查就绪状态，保留已健康运行的同类服务，不结束占用端口的未知进程。日志位于 `.gev-logs/`。视觉权重通常在首次识别时加载；健康成功不等于已经完成模型推理。

建筑专用权重与通用权重不同：请确认 `models/vision/yolov8n-building-seg.pt` 已安装。通用安装脚本仅下载官方 YOLO26 权重，第三方建筑权重需单独提供，详见[本地视觉说明](scripts/local-vision/README.md)。

### 3. 服务与健康检查

| 服务 | 默认地址 | 作用 |
| --- | --- | --- |
| GEV / Vite | [127.0.0.1:4173](http://127.0.0.1:4173) | 界面及同源 `/api/*` 代理 |
| 本地视觉 | `127.0.0.1:8766` | YOLO 检测与分割 |
| 本地语音 | `127.0.0.1:8765` | Whisper 转写、可选声纹 |
| Firecrawl（外部可选） | `127.0.0.1:3002` | 本地网页搜索服务 |
| SearXNG（外部可选） | `127.0.0.1:58080` | 本地搜索栈状态检查 |
| Agent Pro（外部可选） | `127.0.0.1:6637` | 复用其搜索网关 |

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4173/
Invoke-RestMethod http://127.0.0.1:4173/api/vision/health
Invoke-RestMethod http://127.0.0.1:8766/health
Invoke-RestMethod http://127.0.0.1:8765/health
Invoke-RestMethod http://127.0.0.1:4173/api/ai/local-services
```

上表是默认端口，不是实时运行状态。GEV 不安装或自动启动 Firecrawl、SearXNG、Agent Pro 及其数据库依赖。浏览器识别请求通过 GEV 代理进入 Python 服务，不直接跨域调用 Python 端口。

Linux/macOS 的视觉安装方式见[本地视觉说明](scripts/local-vision/README.md)。语音及声纹的自动安装、启动脚本目前以 Windows 为已验证环境，其他平台需准备对应运行库。

<a id="features"></a>
## 全部功能

### 三维地球、地图与导航

- CesiumJS 三维地球，支持缩放、旋转、倾斜、地点搜索、预设城市跳转和一键返回全球。
- 地图源包括 Esri Satellite、OSM、Google Photorealistic 3D、通过 Cesium ion 提供的影像和 Bing Aerial / Bing Labels；可用项取决于凭据和服务权限。
- Google/Ion 不可用时可使用免密钥地图；在线地形不可用时可回退到椭球显示。
- HUD 显示经纬度、位置、方向与高度；地形采样和高程基准处理用于实体放置。
- 首次使用可选择 Live Contacts、Space Missions、Environmental，或手动探索。
- 简体中文与英文界面切换，面板支持折叠、固定和紧凑布局。
- 顶部提供清空已选图层、打开 AI、绘制、分享、语音播放开关与重置地球等入口。

### 数据图层与来源

图层可按需开关。记录数量随视口、源数据覆盖、刷新时间和渲染上限变化，不承诺固定的全球数量。

| 图层 / 能力 | 内容 | 数据性质与依赖 |
| --- | --- | --- |
| 民航 Flights | 位置、呼号、速度、高度、方向及可用航班信息 | OpenSky；不可用时可用有限范围的 adsb.lol 回退。匿名访问受限，可配 OpenSky 凭据 |
| 军机 Military Flights | 公开 ADS-B 军事航空记录、可用历史轨迹 | adsb.lol，仅限数据源观测到的目标 |
| 船舶 Live AIS Vessels | 船位、航向、航速、船名及源数据提供的航次属性 | AISStream，需 `AISSTREAM_API_KEY`，海域覆盖不均 |
| 卫星 Satellites | 位置、轨道环、跟踪和 ISS 过境查询 | CelesTrak 轨道根数 + SGP4 推算，不是连续实时测量 |
| Space Missions | 最近约 30 天发射、载荷、级段与回收资料；时间轴和回放 | Launch Library 2；发射过程动画为标注过的重建估计 |
| 地震 Earthquakes | 最近 24 小时事件、震级、深度与时间 | USGS 在线事件 |
| 活跃火点 FIRMS | 热异常/火点及可用强度属性 | NASA FIRMS，需 `FIRMS_MAP_KEY`；热异常不等于已核实灾情 |
| 道路交通 Street Traffic | OSM 道路交通动画、可选拥堵颜色 | 无 TomTom 密钥时为模拟；有密钥时接入路况流，运动粒子仍不代表单辆实车 |
| 公共摄像头 CCTV | 摄像头目录、图像/视频帧与地图投影 | 已集成公共来源，更新频率和可用性各异 |
| 电台 Radio | 地理定位电台、分类筛选、调谐与播放 | Radio Browser 目录 + 电台自身音频流 |
| 共享单车 Bikeshare | 已接入城市的站点、车辆与空位 | GBFS，不是全球全部站点 |
| 军事设施 Mapped Installations | 已映射设施名称、类别及范围信息 | 视口内 OSM；可选 Google Places 候选，不代表现实能力或活动证据 |
| Global Context | 联合展示目标、设施与基础设施上下文 | 已加载数据的组合视图，不是独立数据源 |
| 数据中心 Datacenters | 位置、名称、运营者及可用分类属性 | 静态 OSM 数据快照 |
| 水坝 Dams | 位置、名称及可用设施属性 | 静态 OSM / OpenInfraMap 数据快照 |
| 海底光缆 Submarine Cables | 线路与登陆点 | TeleGeography 静态快照，含非商业使用许可限制 |
| OSM 专题 | 地址、建筑、道路、聚落、水系、绿地、公共设施 | 视口内 Overpass 查询，有范围与数量限制；独立于 AI 建筑识别 |

OSM 专题部分代码命名为 `osm-us-themes`，实际覆盖取决于 OSM 数据。水系、绿地和公共设施等查询要求较小视口，范围过大需放大地图。已有 Natural Earth 自然区域和旧金山街区边界还可用于名称解析与边界标注。

### 目标跟踪、驾驶舱与全局态势

- 点击目标查看详情、锁定跟随并显示可用航迹；历史轨迹完整度由上游决定。
- 飞机近距离可切换三维机型，支持近距/全部模型显示策略。
- 驾驶舱跟随显示航向、高度、速度等遥测，支持视觉模式切换和退出跟踪。
- Contacts 提供约 250 km 内的已加载目标列表、类型筛选及前后切换。
- 驾驶舱简报展示附近信号、区域新闻和当地天气；可选 WX 效果依据天气观测表现云、降水等。
- Global Context 组织全局图层与视角，离开相应模式时恢复先前配置。
- Space Missions 支持任务详情、回放时间轴和速度控制；源数据、轨道传播和过程估计需分别理解。

### 摄像头与电台

- CCTV 支持选择、上一台/下一台、最近摄像头、聚焦、自动轮换、投影和覆盖范围切换。
- 摄像头姿态可校准，支持覆盖体积/视域演示；姿态与覆盖为估计，不是实测安防可视域。
- 电台支持分类筛选、模拟调谐盘、播放/停止、前后切换与音量，主面板和驾驶舱有紧凑入口。
- 音频直接连接广播方，GEV 不录制或再分发音频。目录标签不代表正在播放的节目。

### 视觉风格与界面控制

- 七种风格：Normal、Retro / CRT、Surveillance / NVG、Thermal / FLIR、Anime、Noir、Snow。
- HUD 提供 Tactical、Operator、Minimal 布局；可调整辉光、锐化和风格参数。
- 圆形观察窗、边缘羽化、天体环与清洁视图，适合演示和录屏。
- 地图实体检测框支持疏密、标签密度、分配策略、淡出与透明度控制。
- **实体框来自已加载地图对象；本地 YOLO 是另一套分析图像像素的识别功能。** 夜视/热成像风格是渲染效果，不是传感器测量。

### 标注、测距、路线与手工绘制

- 手绘点、路线和区域；绘制按钮轮换模式，路线/区域双击完成。
- AI 标注支持图钉、标签、高亮、边界、路线和箭头，可清除绘制。
- 依据可获得的地理资料解析行政区、自然区域、街区或设施边界；资料缺失不表示区域不存在。
- 地点连线与距离说明，基于道路数据请求步行、骑行或驾车路线。
- Realtime 工具可沿已绘路线飞行、绕目标运镜或进行连续相机操作。

### 多模型 AI 与语音交互

- AI 工作台包含**对话、简报、关注、设置**四个页签；支持流式回复、终止生成、连接测试和模型配置。
- 供应商适配：OpenAI、DeepSeek、Qwen、Moonshot / Kimi、Anthropic / Claude、Gemini、Ollama、自定义 OpenAI 兼容服务。图像和工具调用能力取决于具体模型与接口。
- 文本助手声明 15 个工具：视图/实体/统计查询、搜索、视觉与建筑识别、地形分析、地形路线、导航、图层/风格控制、标注与清除。
- OpenAI Realtime 另有更广的工具集，含驾驶舱、跟踪、摄像头、电台、场景导演、ISS 过境、地图源及后期控制；任意文本模型不一定有相同工具入口。
- HUD 摘要可由所选模型生成；地图问答依据当前提供的实体与视口数据。
- 普通助手的状态变更动作显示约 3 秒倒计时，可立即执行、取消，并对支持的操作撤销。识别结果可自动绘制；不同语音入口的执行机制不完全相同。
- 语音输入支持浏览器转写、复用兼容供应商转写接口、独立转写服务及 OpenAI Realtime；支持语音回复播放控制。
- Realtime 提供模型档位、用量估算和会话费用阈值控制；实际价格与账单以供应商为准。

### 本地语音与可选声纹

- Faster-Whisper 本机多语言转写，默认 `small`，可另行安装 `medium`、`large-v3-turbo`。
- 中文词汇提示、候选搜索和简体规范化；准确率受口音、噪声和麦克风影响。
- 可选 CAM++ / `voice-detect.cpp` 支持录音/文件声纹登记、验证、删除、阈值调整，以及观察/强制模式。
- 声纹默认关闭。强制模式在转写前检查匹配，启用检查时阻止绕过该路径的浏览器转写和 Realtime 入口。
- 只在本地保存声纹向量，不保存原始录音；向量仍是未加密的敏感数据。这是应用语音过滤，不是活体检测或系统登录认证。
- 本地转写后的文字仍发送给所选 LLM，远程 LLM 路径不是全离线处理。

### 本地视觉与建筑轮廓

- 扫描当前视口，支持航拍 OBB 与通用目标检测；调整置信度、取消、放大预览、查看分类和置信度。
- Python 接口支持 `detect`、`obb`、`segment`、`buildings-seg`；通用扫描界面主要提供前两类，建筑有独立流程。
- 本地 YOLO 无需聊天模型密钥；通用 COCO/DOTA 模型不能替代建筑专用模型。
- 建筑流程结合分割、重叠裁剪、可选多模态细化和补漏，投影到地图后绘制多边形，见下节。

### 简报、快照、报告与关注区域

- 按当前视口统计已加载对象，显示来源、数量、分类与覆盖状态；数据中心可按可用运营者、国家和用途属性分组。
- 记录表支持搜索、图层筛选、排序、分页、定位和 CSV 导出。
- 保存视口快照，与基线比较新增、消失、移动记录，绘制对比结果。这是数据记录比较，不是卫星影像自动变化检测。
- 导出 JSON、CSV、GeoJSON 视口报告，或打开打印页面另存 PDF。GeoJSON 主要是记录位置点，不是建筑轮廓的专用导出入口。
- 保存、重命名、定位、暂停和删除关注区域；UI 可设置数量阈值与持续时间，查看新记录提醒、标记已读/已处理并添加备注。
- 关注状态保存在本浏览器；只有页面可见且相关数据已加载、覆盖足够时观察，关闭页面后没有后台监控或邮件推送。

### 地形分析与地形路线

- 视口高程采样，显示最低/最高/平均高程、起伏、坡度、坡向、地形类型与剖面。
- 在地图上绘制采样点、等高线和分级颜色，提供坡度图例。
- 在采样范围内按起终点和最大坡度约束规划路线，返回距离、累计上升/下降与坡度指标。
- 路线按坡度着色并标注高程。网格采样不能证明真实可通行性，不替代道路、地质或现场测量。

### 场景导演与分享

- 内置镜头配方；支持新建/删除场景、捕获/更新镜头、播放/停止及进度显示。
- 场景 JSON 导入/导出和运行记录下载。镜头捕获保存场景状态，视频成片需另用录屏工具。
- 分享链接保存相机、风格、图层、面板等状态，可携带一个跟踪目标；接收方仍需数据源可用。
- 清洁视图适合演示；必要的地图和数据署名仍需保留。

<a id="buildings"></a>
## 建筑识别：YOLO 与 LPM 思路互补

```text
当前视口影像
  → 建筑专用 YOLO-seg：整图识别 + 重叠裁剪补充
  → 多模态模型：参考候选、细化轮廓、独立查找遗漏屋顶（可选）
  → 多边形校验、重叠匹配与去重融合
  → Cesium 表面投影与地图绘制
  → 返回模型、检测/补充/绘制数量与回退状态
```

- 优先采用 `yolov8n-building-seg.pt`。当前整图推理为 `imgsz=2048`，较大画面最多追加四个重叠裁剪；数量与尺寸均有限制。
- 多模态阶段复用配置的视觉模型，借鉴 LPM 的规范化多边形序列表达，参考候选并搜索遗漏的清晰屋顶。
- 精修超时、未配置或结果无效时保留可用 YOLO 结果；本地分割不可用时可尝试直接多模态识别并报告状态。
- 识别期间视角改变会使旧结果失效，防止绘制错位。单次建筑输出上限为 500，可能更少；达到上限不代表识别完整。
- **本版本没有接入官方 EarthVi/LPM 权重或 SAM2 推理管线。** 当前是借鉴论文思路的工程组合，不是论文模型复现，不承诺论文指标。
- **建筑识别不关联 OSM 名称、地址或属性。** OSM 专题图层独立存在。
- 图像质量、倾斜视角、遮挡、屋顶尺度与训练域差异仍会造成误检、漏检和坐标误差；这是实验性轮廓，不是地籍成果。

使用建议：选择清晰卫星影像，放大至屋顶可辨、尽量接近俯视，等待瓦片加载完成，在 AI 对话中输入“识别当前视口建筑”。精修需模型支持图像及结构化坐标输出；纯文本模型或不支持图像的中转无法完成该阶段。远程精修会将视口影像发送到所选服务。

论文参考：[Rethinking Language Models for Building Outline Extraction from Remote Sensing Imagery — Amazon Science / CVPR 2026 EarthVision](https://cdn.amazon.science/aa/3c/d4ea78084f199eaf08743fc57e50/scipub-approval152134-45892548-rethinking-language-models-for-building-outline-extraction-from-remote-sensing-imagery.pdf)。

<a id="configuration"></a>
## 配置与使用

### 密钥和模型

**POWER UP / 供应商设置**配置地图和数据源，**AI → 设置**配置模型、转写与搜索。入口隐藏时可用 `?setup=1` 打开供应商设置。

普通开发启动将配置保存到应用目录 `.env`，Pinokio 使用 `pinokio/ENVIRONMENT`；shell 配置可能显示为外部管理。手动配置参考 [.env.example](.env.example)，不要覆盖已有 `.env`。

| 配置项 | 能力 |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | Google 直连三维瓦片和地点搜索 |
| `CESIUM_ION_TOKEN` | ion 资产、可用三维和地形服务 |
| `OPENSKY_AUTH_MODE`、`OPENSKY_CLIENT_ID`、`OPENSKY_CLIENT_SECRET` | 航班认证；无认证可配 `anon` |
| `AISSTREAM_API_KEY` / `FIRMS_MAP_KEY` / `TOMTOM_API_KEY` | 船舶 / 火点 / 真实路况流 |
| `LL2_API_TOKEN` | 可选发射数据凭据 |
| `GEV_LLM_PROVIDER`、`GEV_LLM_MODEL`、`GEV_LLM_BASE_URL` | 聊天、工具调用、HUD 及可选图像精修 |
| `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`QWEN_API_KEY`、`MOONSHOT_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY` | 各供应商凭据 |
| `GEV_LLM_API_KEY` | 自定义 OpenAI 兼容服务的独立凭据 |
| `GEV_STT_PROVIDER`、`GEV_STT_MODEL`、`GEV_STT_BASE_URL`、`GEV_STT_API_KEY` | 转写服务 |
| `OPENAI_REALTIME_*` | Realtime 模型、声音、上下文 |
| `FIRECRAWL_API_KEY`、`FIRECRAWL_BASE_URL` | 云端/本地网页搜索 |
| `AGENT_PRO_SEARCH_ENABLED`、`AGENT_PRO_SEARCH_URL`、`AGENT_PRO_LOCAL_HEADER` | 本机 Agent Pro 搜索 |
| `GEV_YOLO_DEVICE` | 视觉设备，默认 CPU，兼容环境可用 CUDA / MPS |
| `GEV_LOCAL_SPEECH_MODEL_ID`、`GEV_LOCAL_SPEECH_MODEL_PATH` | 本地语音实际加载的权重 |
| `VOICEPRINT_*`、`VOICEDETECT_LIBRARY`、`VOICEDETECT_MODEL` | 声纹策略和运行库，详见语音说明 |

Google Maps 和 Cesium ion 凭据按设计在浏览器使用，应在供应商端限制来源和权限；其他私有凭据由服务端持有。地图、模型、搜索、语音可能分别计费，不应把系统理解为永久免费。

### 自定义中转与本地模型

- 自定义聊天选 `custom`，填写供应商给出的 API 根地址（通常以 `/v1` 结尾）、真实模型 ID 和对应 Key；不要填控制台网页或重复附加 `/chat/completions`。
- 聊天能连接不代表图像、工具调用和 `/audio/transcriptions` 同时兼容，需分别验证。
- Ollama 地址可用 `http://127.0.0.1:11434/v1`，模型需自行安装并启动。
- 本地语音选择独立转写服务，地址 `http://127.0.0.1:8765/v1`，模型 `local-whisper-small`，Key 留空。更换实际权重需安装并重启服务，只改 UI 名称不会切换权重。
- 本地 Firecrawl 可设 `FIRECRAWL_BASE_URL=http://127.0.0.1:3002/v2`；SearXNG 状态正常不等于 Firecrawl 搜索已可用。

### 常用操作

| 入口 | 示例 |
| --- | --- |
| AI 对话 | “带我去东京”“打开航班图层”“当前视口有多少数据中心？” |
| 建筑识别 | “识别当前视口建筑” |
| 地形 | “分析当前视口地形”，再指定起终点规划地形路线 |
| Realtime 语音 | “跟踪最近的飞机”“进入驾驶舱”“播放附近电台”“沿刚才的路线飞行” |
| 简报 | 刷新视口 → 保存快照 → 比较 → 导出报告 |
| 关注 | 保存区域 → 设置数量/持续时间 → 在页面内查看提醒 |

快捷键：`1`–`7` 切换风格，`H` 切换 HUD，`O` 环绕，`V` 清洁视图，`F` 数据面板，`D` 切换实体检测模式；`C` 在可用时切换驾驶舱，否则切换 CCTV。`Esc` 按当前状态退出驾驶舱、停止场景播放或关闭浮层/搜索。

<a id="architecture"></a>
## 接口、结构与开发

```text
浏览器：Cesium、界面、标注、视口分析
  └─ Vite / Node 同源代理（默认 4173）
       ├─ 地图、公开数据、所选 LLM / Realtime / 搜索
       ├─ 本地 YOLO（8766）
       └─ 本地 Whisper / 可选声纹（8765）
```

| 接口组 | 用途 |
| --- | --- |
| `/api/ai/config`、`/api/ai/test`、`/api/ai/chat`、`/api/ai/hud-summary` | AI 状态、连接测试、对话、摘要 |
| `/api/ai/transcribe`、`/api/ai/voiceprint/*` | 转写和声纹管理 |
| `/api/ai/search`、`/api/ai/local-services`、`/api/ai/diagnostics` | 搜索、服务状态、诊断 |
| `/api/vision/health`、`/api/vision/detect` | 本地视觉状态、检测 |
| `/api/vision/buildings-seg`、`/api/vision/buildings` | 建筑分割、多模态轮廓生成/细化 |
| `/api/terrain/heights`、`/api/terrain/analyze`、`/api/route` | 高程、地形、道路路线 |
| `/api/realtime/token`、`/api/google/*`、各数据源 `/api/*` | 会话、地点、图层代理 |
| `/api/setup/status`、`/api/setup/keys` | 本机开发模式的配置管理 |

请求方法、字段和限制以源码为准；这些是应用内部接口，不是通用公共 GIS API。

```text
GEV/
├── README.md / README.en.md  # 中文 / 英文
├── index.html / style.css    # 界面与样式
├── vite.config.js           # 开发服务与代理
├── src/
│   ├── main.js / ui.js       # 启动与控件
│   ├── data/                # 数据源、轨迹、天气和静态资料
│   ├── ai/                  # 多模型、视觉、简报、关注、报告
│   ├── voice/               # 转写路由、Realtime、地图动作
│   ├── annotations/         # 标注、手绘、地形样式
│   ├── scenes/ / styles/    # 场景导演与视觉效果
│   └── locale/              # 中英文文案
├── scripts/local-vision/    # YOLO 服务
├── scripts/local-speech/    # Whisper 与声纹
├── tools/building-extraction/ # 独立建筑提取工具
├── models/                  # 本机权重/运行库（自行安装，不随仓库分发）
└── docs/CURRENT-STATE.md     # 实现状态
```

```powershell
npm run doctor
npm test
npm run test:track
npm run build
npm run preview
```

Python 测试命令见本地服务 README；界面回归场景见 [TESTING.md](TESTING.md)。`npm run preview` 用于构建预览，部分代理和配置功能仅在开发服务中提供。单独托管 `dist/` 不能提供完整 `/api/*` 后端。

Pinokio 启动器位于 `pinokio/`，只启动 Web 应用，不代替 Python 服务安装。请使用本仓库获得这里列出的定制功能。

<a id="troubleshooting"></a>
## 常见问题与能力边界

| 现象 | 检查方式 |
| --- | --- |
| 页面打不开 | 检查应用目录、Node 版本、终端进程与 4173 端口占用 |
| 地图空白/三维不可用 | 检查网络和令牌权限，切换 Esri / OSM；三维覆盖并非全球一致 |
| 图层没有数据 | 检查密钥、区域覆盖、时间窗、限流和来源状态；空数据不表示现实不存在目标 |
| 视觉未连接 | 运行视觉 `start.ps1`，检查 `.gev-logs/` 和代理健康接口 |
| 健康正常但识别慢 | 首次推理加载权重；CPU 和画面复杂度影响耗时，避免重复并发提交 |
| 建筑漏检/细化超时 | 检查建筑权重和视觉模型兼容性，缩小范围、改善视角；回退结果需复核 |
| 语音无结果 | 检查麦克风、STT 路径和模型身份；启用声纹时检查档案与模式 |
| 中转有 Key 仍报错 | 核对 API 根地址、模型权限、额度、工具调用和图像能力 |
| 搜索不可用 | 检查 Firecrawl / Agent Pro 实际接口；GEV 不启动外部搜索栈 |
| 关注区无提醒 | 保持页面可见，启用对应图层并加载区域；首次观察通常先建立基线 |

数据可能延迟、缺失、静态或经过推算。影像识别、地形路线、摄像头覆盖和轨迹重建需结合来源核实；适合探索、教学、演示和辅助分析，不作为测绘验收、航行导航或安全关键决策的唯一依据。

<a id="acknowledgements"></a>
## 鸣谢 · God's Eye View

本项目基于 **God's Eye View** 开源项目进行扩展。感谢原作者 **Bilawal Sidhu** 与社区贡献者提供三维地球、公开数据集成、目标跟踪、驾驶舱、视觉风格、语音操作和场景导演等基础能力。

- 原项目 GitHub：[bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)
- 原作者：[Bilawal Sidhu](https://github.com/bilawalsidhu)
- 原项目许可：[MIT License](LICENSE)，保留版权和许可声明。
- 本版本扩展：中英文界面、多供应商 AI、本地语音与声纹、YOLO 建筑识别、地形分析、视口简报与关注区域等；不代表上游对本定制版本提供背书。

页头图标沿用项目现有 [public/logo.svg](public/logo.svg)，仅为文档添加背景与 PNG 展示形式。感谢 CesiumJS、Vite、Ultralytics、faster-whisper、voice-detect.cpp、OpenStreetMap 及其他数据/模型维护者；详细来源和授权见 [DATA_SOURCES.md](DATA_SOURCES.md) 与各模型说明。

<a id="license"></a>
## 许可、署名与文档

- 应用代码沿用 [MIT License](LICENSE)，保留原作者 Bilawal Sidhu 的版权声明。
- 第三方数据、三维资产、模型各自遵循许可，MIT 不覆盖它们。TeleGeography 含非商业限制，OSM 衍生数据遵循 ODbL；地图、新闻、天气等适用供应商条款。
- Ultralytics 代码/权重适用 AGPL-3.0 或其另行提供的许可；第三方建筑权重需核查模型卡和授权。
- 密钥、配置、缓存、声纹不应提交到版本库；Git 忽略也不能阻止网盘同步。默认回环访问，网络共享边界见 [SECURITY.md](SECURITY.md)。

| 文档 | 内容 |
| --- | --- |
| [English README](README.en.md) | 对应英文版本 |
| [当前实现状态](docs/CURRENT-STATE.md) | 功能路径与实现说明 |
| [数据来源与署名](DATA_SOURCES.md) | 来源、许可、覆盖、模拟说明 |
| [本地视觉](scripts/local-vision/README.md) | 模型、安装、API、限制、测试 |
| [本地语音](scripts/local-speech/README.md) | Whisper、声纹、配置、隐私 |
| [模型资产署名](public/models/README.md) | 三维模型来源与许可 |
| [安全说明](SECURITY.md) / [测试指南](TESTING.md) | 部署边界与验证场景 |
| [贡献指南](CONTRIBUTING.md) / [变更记录](CHANGELOG.md) | 协作与历史记录 |

独立建筑提取 CLI、分块批处理脚本和 GeoJSON 查看器位于 [`tools/building-extraction/`](tools/building-extraction/README.md)，包含中英文使用说明。
