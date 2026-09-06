# SAA-Nishiki（二式）

[English](README.md) | [日本語](README.ja.md) | **简体中文**

[Character Select SAA](https://github.com/mirabarukaso/character_select_stand_alone_app) 的分支版本。一个独立运行的应用，支持 AI 提示词、半自动标签补全以及 ComfyUI / Forge Neo (WebUI) API。
Nishiki 新增了日语标签翻译、带自定义字段与预设的胶囊式提示词编辑器、可编辑的列表管理器、撤销 / 重做、AI 提示词重写器、快速生成模式以及 Runpod Pod 目标。

当前版本：**v2.8.9-nishiki.1** —— 基于上游 SAA v2.8.9。下载与发布说明请见 [Releases](https://github.com/FUMIHITO-EGUCHI/saa-nishiki/releases)。

<img src="examples/nishiki_overall.png" width=75%>

## 目录
- [Nishiki 新增功能](#nishiki-新增功能)
- [安装与运行](#安装与运行)
- [更新](#更新)
- [Highlights（继承自上游）](#highlights)
- [AI 提示词](#ai-提示词)
- [Image API Interface](#image-api-interface)
- [FAQ](#faq)

------

# Nishiki 新增功能

## 日语标签翻译与本地化
- 通过覆盖 danbooru / e621 合并标签列表的日语词典（约 10 万条，`data/danbooru_e621_merged_ja.csv`），可以用日语搜索和显示标签。
- 角色名与作品名的日语本地化，以及标签分类显示。
- 在设置中将界面语言选为 `ja-JP` 后，标签、名称和分类以日语显示；没有日语条目的界面文字回退为英语。

<img src="examples/nishiki_jp_tag_search.png" width=75%>

## 提示词编辑器
原来的纯文本框被替换为字段列表加一个大的聚焦编辑器。每个字段都可以按 **胶囊**（每个标签一个芯片）或 **纯文本** 显示，显示模式在所有字段间共享。

<img src="examples/nishiki_tag_capsules.png" width=75%>

- **自定义提示词字段。** 在正向和负向两组中都可以添加、重命名、排序和删除自己的字段（例如 `Face`、`Body`、`Background`、`Style`）。最终提示词按你排列的顺序由各字段拼接而成。
- **单标签权重。** 点击胶囊打开权重弹窗，或在文本模式下使用 `Ctrl + 上 / 下`。批量对话框可一次修改多个标签的权重。
- **一键启用 / 禁用标签。** 禁用标签而不删除它；被禁用的标签保留在字段中，但不参与生成。
- **在字段之间移动标签。** 把胶囊拖到另一个字段（按住 `Ctrl` 或 `Alt` 为复制），或使用右键菜单中的 `Move to…` / `Copy to…`。权重和禁用状态随标签一起移动。文本模式下同样的命令作用于选中的文本。
- **预设。** 每个字段有自己的预设列表。提示词预设保存整个字段布局（字段、名称、顺序和内容）；应用时会精确还原该布局。
- **相关标签建议（离线）。** 聚焦一个胶囊后，字段下方会显示经常一起出现的标签（来自内置共现词典 `data/tag_related.txt`）以及同一词族的标签。点击即插入；用字段底部的 ✦ 按钮开关此功能。
- **搜索。** 自动补全默认同时匹配标签名的开头、中间和结尾。
- 文本编辑器随内容自动增高，长提示词不会被截断。

## 权重批量
为标签设置 **权重计划**（起始、步长、结束）并运行批量：SAA 固定种子，逐张只改变权重。`÷ batch count` 选项根据批量数量自动推算步长。以非随机种子启动批量时会弹出提示。

## 选择弹窗、收藏与列表管理器
- 角色、原创角色、角度、镜头和标签都在一个可搜索的选择弹窗中选取，带翻译和 **收藏** 分组。收藏的标签在胶囊上也会高亮。
- 角色槽位数量不再固定为三个，可按需添加。
- **列表管理器**（设置 → Lists）：为角色 / 原创角色 / 角度 / 镜头列表新增、覆盖或隐藏条目。上游数据保持只读；你的编辑以差分形式保存在 `settings/user_lists.json`，可导出 / 导入。列表条目可携带多标签提示词，条目编辑器内可打开标签词典选择器。

<img src="examples/nishiki_character_select.png" width=45%>

## 撤销 / 重做
每次提示词编辑、预设应用和 AI 重写结果都是全局编辑历史中的一个原子步骤。使用 `Ctrl + Z` / `Ctrl + Shift + Z`（或 `Ctrl + Y`）或工具栏按钮。

## AI 提示词重写器
在上游的远程 / 本地 `llama.cpp` AI 提示词之外，Nishiki 新增了基于 [Ollama](https://ollama.com/) 的 **重写（Refine）** 模式。重写会在每个批量的第一张图之前，用一次结构化请求改写整段提示词，并逐字段应用到编辑器。重写产生的编辑会记录到编辑历史中，可以撤销。
AI 结果显示在 **Info 面板的 AI 标签页** 中，不再每次生成后弹窗。

## 快速生成模式
设置 → Backend → **快速生成** 应用步数蒸馏 LoRA（DMD2 / Hyper-SD / Lightning / LCM），并覆盖基础、高清修复和 ADetailer 各阶段的步数、CFG、采样器与调度器。本地 ComfyUI 与 Pod 均适用。
在 RTX 4070 SUPER 上实测（600×1024，Hires 1.5x，ADetailer）：30 步 ≈ 29 秒 → DMD2 8 步 ≈ 16 秒。

## Runpod Pod 目标
在设置中注册一个 Runpod Pod（SSH 目标与密钥），然后通过工具栏中的状态胶囊在 **GPU: Local** 与 **GPU: Pod** 之间切换图像生成目标。生成的图像通过 SSH 流式传回并仅保存在本地；不会写入 Pod 的磁盘。Pod 也可以承载 LLM 功能（AI 提示词 / 重写）。Pod 端点支持带认证的 `https` / `wss` 后端。
AI 提示词 / 重写请求同样通过这条 SSH 中继发送到 Pod 上的 Ollama。安装、Pod 重启后的恢复脚本和故障排查见 [README_POD.md](README_POD.md)。

## 画廊与 Info 面板
- Info 面板跟随画廊中选中的图像，包括其内嵌的 PNG 参数。
- 右键菜单根据右击的对象而变化：胶囊、提示词字段、画廊图像、AI 字段。

## UI 外壳
新的视口布局、状态胶囊、生成进度指示、对话框外壳组件，以及重新设计的深色 / 浅色主题。

## 设置存储
设置按分区拆分并带有架构版本：
- `settings/app.json` —— 应用设置（后端、路径、AI、快速模式、Pod）
- `settings/state.json` —— 提示词 / 生成 / LoRA / ADetailer / ControlNet 的工作状态
- `settings/presets/<section>/<name>.json` —— 预设
- `settings/user_lists.json` —— 列表管理器差分
- `settings/legacy/` —— 拆分前的 `settings/*.json`，首次启动时移到这里，之后不再读取

全部自动保存并采用原子写入。除内置的 MiraITU 工作流文件外，`settings/` 不受 git 管理。

## 版本号
分支版本遵循 `<upstream-version>-nishiki.<generation>`（例如 `2.8.9-nishiki.1`）。基础部分跟随已合并的上游版本，每次合并上游时把 generation 重置为 `.1`；分支自身的发布则递增 generation。

------

> [!NOTE]
> 如果发现列表中没有、但可以正确生成的角色，请提交 issue 告知。
>
> 默认 thumbList 基于 `waiIllustriousSDXL_v160`。另有两个可选 thumbList：`waiANIMA_v10Base10` 和 `waiNSFWIllustrious_v120`，选择后会自动从 `HuggingFace` 下载。
> 可用 [SAA Thumb Generator](scripts/python/thumb-generator/README.md) 制作自己的 thumbList。

| 已验证 | [ComfyUI](https://github.com/comfyanonymous/ComfyUI)  | [Forge Neo](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo) |
| --- | --- | --- |
| Release | 0.28.0 | 2.27 |
| Refiner (SDXL) | Yes | Yes |
| Image Color Transfer (ALL) | Yes | No |
| Regional Condition / Couple (SDXL/Anima) | Yes | Yes |
| ControlNet/IPA (SDXL) | Yes | Yes |
| ADetailer (ALL) | Yes | Yes |
| API authentication| No | Yes |
| MiraITU | Yes | No |
| 快速生成模式 | Yes | No |
| Runpod Pod 目标 | Yes | No |

> [!IMPORTANT]
> `Forge Neo` 上的 `Regional Condition / Couple` 与 `ADetailer` 支持 `SDXL 和 Anima`；
> `ComfyUI` 上应支持 SAA 支持的所有 diffusion 模型（待验证）。
>
> *不支持 ComfyUI Desktop。*
> *A1111 因长期缺乏维护已从支持列表移除。它仍能与 SAA 一起工作，但不再测试。*
>
> *在线版 Character Select* [Hugging Face Space](https://huggingface.co/spaces/flagrantia/character_select_saa)
>
> 浏览器版 SAAC 请见 [README_SAAC.md](README_SAAC.md)。
> 面向 OpenClaw 的 Python CLI 工具请见 [SAA Agent](scripts/python/saa-agent/README_HUMAN.md) 与 [ClawHub](https://clawhub.ai/mirabarukaso/saa-agent)。

## thumbList 手动下载指南
<details>
<summary>如果 SAA 内的下载很慢或失败，请手动下载。</summary>

前往 [HF 数据集](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/tree/main)，将以下文件下载到 `data` 文件夹并按如下重命名：

### waiIllustriousSDXL_v160
[waiIllustriousSDXL_v160_thumbs.json](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/resolve/main/wai_character_thumbs_v160.json?download=true)

[waiIllustriousSDXL_v160_characters.csv](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/raw/main/wai_characters_v160.csv)

[waiIllustriousSDXL_v160_tag_assist.json](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/raw/main/waiIllustriousSDXL_v160_tag_assist.json)

### waiIllustriousSDXL_v120
[waiNSFWIllustrious_v120_thumbs.json](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/resolve/main/wai_character_thumbs_v120.json?download=true)

[waiNSFWIllustrious_v120_characters.csv](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/raw/main/wai_characters_v120.csv)

[waiNSFWIllustrious_v120_tag_assist.json](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/raw/main/waiIllustriousSDXL_v160_tag_assist.json)

### waiANIMA_v10Base10
[waiANIMA_v10Base10_thumbs.json](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/resolve/main/waiANIMA_v10Base10_thumbs.json?download=true)

[waiANIMA_v10Base10_characters.csv](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/raw/main/waiANIMA_v10Base10_characters.csv)

[waiANIMA_v10Base10_tag_assist.json](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/raw/main/waiANIMA_v10Base10_tag_assist.json)

</details>

# 安装与运行
> [!TIP]
> 启动 SAA 前先设置好 [Image API Interface](#image-api-interface)。
>
> ComfyUI 需要最新的 [ComfyUI_Mira](https://github.com/mirabarukaso/ComfyUI_Mira)。
>
> *一键整合包 v2.8.0（上游）*
> 完整包 [embeded_env_for_SAA](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/resolve/main/embeded_env_for_SAA.zip)

将仓库克隆到本地文件夹：
```
git clone https://github.com/FUMIHITO-EGUCHI/saa-nishiki.git
cd saa-nishiki
npm install
npm start
```

### 本地 CDP 调试（可选）

CDP 默认关闭。若要让 Chrome DevTools 或兼容的 MCP 客户端检查 Electron 渲染进程，请以本地调试端口启动 SAA：

```powershell
$env:SAA_CDP_PORT = "9222"
npm start
```

打包后的可执行文件使用等价选项：

```powershell
.\saa.exe --saa-cdp-port=9222
```

SAA 运行期间，DevTools 端点位于 `http://127.0.0.1:9222/json/list`。若 `9222` 被占用请换用其他端口。不要在不受信任或可从外部访问的机器上开启此选项，因为 CDP 可以检查并控制渲染进程。

# 更新
> [!IMPORTANT]
> **从 GitHub 更新不会更新数据集文件。**
> 手动删除 `data` 文件夹中的 `danbooru_e621_merged.csv`、`*_thumbs.json`、`*_characters.csv`、`*_tag_assist.json`，然后重启应用，即可从 HF 下载最新的缩略图数据库。

```
git fetch
git pull
npm install
```

设置、预设和列表管理器差分都位于 `settings/`，更新不会改动它们。

------
# Highlights
以下章节继承自上游 SAA。截图已尽可能用 Nishiki 界面重新截取。

## ComfyUI 与 Forge Neo 的 Diffusion 模型（UNET/CLIP/VAE）
> [!NOTE]
> 已测试验证：Anima / Qwen Image / Z Image / Flux / Krea2
> 支持 ComfyUI 与 Forge Neo，不支持原版 A1111。

<img src="examples/diffusion_models.png" width=25%>

> [!NOTE]
> 上图为旧版（上游）界面的截图。

<details>
<summary>Diffusion 模型详情</summary>

*ComfyUI* 请参考 [Comfy-Org@HF](https://huggingface.co/comfy-Org/)
`GGUF 模型` 需要自定义节点 [gguf](https://github.com/calcuis/gguf)（小写的那个）。
```
|---models
|   |---checkpoints
|   |---diffusion_models
|   |---text_encoders
|   |---vae
```

*Forge Neo* 请参考 [Download Models@Haoming02](https://github.com/Haoming02/sd-webui-forge-classic/wiki/Download-Models)
Forge 同样支持 `GGUF 模型`，但 `Diffusion 模型` 与 `Checkpoint` 使用同一文件夹，请自行按正确文件夹管理。
```
|---models
|   |---Stable-diffusion
|   |---text_encoder
|   |---VAE
```
</details>

## Mira Image Tiled Upscaler
> [!NOTE]
> MiraITU：基于视觉模型的内容感知图像超分辨率 ComfyUI 自定义节点。
> 把任意图像拖入 SAA/SAAC 即可放大。

| Before | 6x After (SDXL) | Before | 3x After (Flux.2) |
| --- | --- | --- | --- |
| <img src="examples/2025-12-29-031208_1898628601.png" width=256>   |  <img src="examples/2026-01-01-223655_3487267443.png" width=256> | <img src="examples/MiraITU_FLUX2_sample.png" width=256>   |  <img src="examples/MiraITU_FLUX2_sample_upscaled.png" width=256> |

<details>
<summary>MiraITU 详情</summary>

支持 1.5x 到 8x 的放大倍率。通过调整分块大小可以最大化优化显存占用，让 8GB 显卡也能完成 1.5x 到 3x（或更高）的放大，同时释放 24GB 以上高端显卡的潜力，实现 4x 到 8x 放大。

需要 [ComfyUI_Mira](https://github.com/mirabarukaso/ComfyUI_Mira) `0.5.6.0 或以上`
需要 [MiraSubPack](https://github.com/mirabarukaso/ComfyUI_MiraSubPack) `最新版`

以及 [Mira](https://github.com/mirabarukaso/ComfyUI_Mira#tagger) 的 Image Tagger

| Settings | Drag and Drop | Flux.2 |
| --- | --- | --- |
| <img src="examples/nishiki_miraitu_settings.png" width=256> | <img src="examples/nishiki_miraitu_drop.png" width=256>   | <img src="examples/nishiki_miraitu_flux2.png" width=256>   |

生成结果因模型而异。`SDXL` 模型需要 `tagger` 提供更精确的内容描述，并建议使用 `upscale 模型`。像 `Flux2` 这类可以连接 `reference latent` 的模型可以跳过 upscale 模型，直接拉伸原图，然后用 `Positive Prompt` 统一配置所有分块。

| 放大倍率 1024x1360(1536) | Tile Size | VAE 8G | VAE 24G~ |
| --- | --- | --- | --- |
| x1.5 | 768 | Full | Full |
| x2 | 1280 | Full/Tiled | Full |
| x3 | 1536 | Tiled | Full |
| x4 | 2048 | Tiled | Full |
| x6 | 2048/2560 | Tiled | Full |
| x8 | 2560/3072 | Tiled | Full/Tiled |

注：受 SDXL 模型限制，超过 8x 放大时画面切片会过于碎裂。更高倍率建议改用专用的 ComfyUI 工作流。
[ComfyUI Workflow MiraITU](https://github.com/mirabarukaso/ComfyUI_MiraSubPack/blob/main/examples/MiraITU_workflow.png)
</details>

## Image Tagger
支持 ONNX 格式的 [WD@SmilingWolf](https://huggingface.co/SmilingWolf)、[CL@cella110n](https://huggingface.co/cella110n/cl_tagger) 和 [Camie@Camais03](https://huggingface.co/spaces/Camais03/camie-tagger-v2-app) 模型。

<img src="examples/nishiki_image_tagger.png" width=35%>

<details>
<summary>Image Tagger 详情</summary>

从 [HF](https://huggingface.co) 下载带标签的模型，按以下规则重命名后复制到 `models/tagger` 文件夹：
  - cl_tagger_v2.onnx + cl_tagger_v2_tag_mapping.json
  - wd-eva02-large-tagger-v3.onnx + wd-eva02-large-tagger-v3_selected_tags.csv
  - wd-v1-4-convnext-tagger.onnx + wd-v1-4-convnext-tagger_selected_tags.csv

```
SAA
|---models
|   |---tagger
|       |---cl_tagger_1_02.onnx
|       |---cl_tagger_1_02_tag_mapping.json
|       |---wd-eva02-large-tagger-v3.onnx
|       |---wd-eva02-large-tagger-v3_selected_tags.csv
|       |---wd-vit-large-tagger-v3.onnx
|       |---wd-vit-large-tagger-v3_selected_tags.csv
|       |---camie-tagger-v2.onnx
|       |---camie-tagger-v2-metadata.json

Options:
Model Name  >>>  General Threshold(CL/WD/Camie)  >>>  Character Threshold(CL/WD)  >>> Categories(CL/Camie) or mCut(WD)
```

Image Tagger 运行在 Node.js 的 `onnxruntime-node` 上。*不需要任何后端支持*，但 GPU 加速似乎不起作用。
打标速度约为 CPU 模式下 `Python` + `onnxruntime` 的 1/3，`onnxruntime-gpu` 的 1/12。
好消息是，生成过程中也可以运行 `Image tagger`。

| Device | Avg Tagging Time | Model | Platform | Resolution | Recommend Value |
| --- | --- | --- | --- | --- | --- |
| onnxruntime | 1.053s | cl_tagger_1_02 | Python | 448 | 0.55/0.60 |
| onnxruntime-gpu | 0.297s | cl_tagger_1_02 | Python | 448 | 0.55/0.60 |
| onnxruntime-node | 3.185s | cl_tagger_1_02 | Electron(NodeJS@CPU) | 448 | 0.55/0.60 |
| onnxruntime-node | 2.917s | wd-eva02-large-tagger-v3 | Electron(NodeJS@CPU) | 448 | 0.35/0.85 |
| onnxruntime-node | 2.113s | camie-tagger-v2 | Electron(NodeJS@CPU) | 512 |  0.50/(NOT USE) |
</details>

## ControlNet / IP Adapter
<img src="examples/nishiki_controlnet.png" width=35%>

<details>
<summary>ControlNet / IP Adapter 详情</summary>

### ComfyUI
将 [ComfyUI_Mira](https://github.com/mirabarukaso/ComfyUI_Mira) 升级到 `0.5.6.0 或以上`。

`ControlNet` 需要 [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux) 1.1.5 [latest](https://github.com/Fannovel16/comfyui_controlnet_aux/commit/e8b689a513c3e6b63edc44066560ca5919c0576e)
`ControlNet` 模型放在 `ComfyUI\\models\\controlnet`

`IP Adapter` 需要 [comfyui-art-venture](https://github.com/sipherxyz/comfyui-art-venture) 1.1.7 [latest](https://github.com/sipherxyz/comfyui-art-venture/commit/210dc072b1f103f91be18a33bdeb13ab315aaae5) 与 [ComfyUI_IPAdapter_plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus) 2.0.0 [latest](https://github.com/cubiq/ComfyUI_IPAdapter_plus/commit/a0f451a5113cf9becb0847b92884cb10cbdec0ef)
`Clip Vision` 模型放在 `ComfyUI\\models\\clip_vision`
`IP Adapter` 模型放在 `ComfyUI\\models\\ipadapter`
`SDXL/ilXL/NoobXL` 推荐 `CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors` 搭配 `ipa_styleIpadapterFor_NoobAI-XL_v10.safetensors`，可能还需要 `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors`。
ComfyUI 只接受第一个 `IP Adapter` 槽位，其他设为 `On` 的槽位会被忽略。

### Forge Neo
ComfyUI 的 `Post` 会把处理后的图像直接送入 ControlNet 模型而无需预处理，接受 `none(null)` 作为 preProcessModel。
Forge 系 ControlNet 不支持 `none(null)`，它接受 `None(String)`。

*Forge Neo：*
  `ControlNet` 与 `IP Adapter` 模型放在 `models\\ControlNet`。
  使用 `None` 并始终 `On`。

### 用法
1. 把图像（或 openPose 图像）拖入 `Image Info`（或点 `Add` 再 `Paste`），选择 `Pre-processor`、`Resolution`、`Post-processor`，然后点 `Add ControlNet`。显示 `Added` 后预览会切换为预处理后的图像；关闭 `Image info`，在 `ControlNet` 标签页查看更多设置。**鼠标悬停在下拉框 / 文本项上可查看说明。**
2. 在 `ControlNet` 标签页可更换 `Pre-processor` 并点 `Refresh` 重新生成预览（或把 `Method` 设为 `On`，此时 SAA 预览不会更新）。
3. 图像太大无法存入设置文件，所以 `ControlNet` 设置在 SAA 关闭时不会保存；切换到其他设置文件也不会覆盖当前的 `ControlNet` 设置。
4. `ControlNet` 在普通与区域条件下都可用。
5. 初次使用 `ControlNet` 建议先试 `Canny` 或 `OpenPose`。
6. ComfyUI 不喜欢重复提交相同数据，提交相同数据可能收到 `Empty response error`。
7. [comfyui-art-venture](https://github.com/sipherxyz/comfyui-art-venture) 需要 `正方形图像`，非正方形输入会有警告。
8. 若 IPA 图像太大，`IP Adapter` 的 `Resolution` 会把输入图缩放到目标尺寸，多数情况下 `1024` 足够。
9. `Pre-Process Model` 选为 `IP Adapter` 时 `Info` 按钮不可用。

所有 `Pre-processor` 模型由 [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux)（ComfyUI）管理，大多从 Hugging Face 下载。
所有 `Post-processor` 模型（即 `Apply ControlNet Model`）需自行从 `ComfyUI Model Manager` 或 Hugging Face 下载。
</details>

## LoRA 槽位
Forge Neo（WebUI）支持其默认的 LoRA 提示词格式 `<lora:xxxxx:1.0>`。
ComfyUI 支持更详细的 LoRA 配置，详见 [LoRA from Text](https://github.com/mirabarukaso/ComfyUI_Mira#lora)。
点击 LoRA 槽位中的 `i` 按钮可查看 LoRA 信息；若存在与 LoRA 同名的 PNG，会显示在信息页中。

**在 ComfyUI API 中使用 LoRA 需要把 ComfyUI_Mira 更新到 0.5.6.0 或以上。**

<img src="examples/nishiki_lora_slot.png" width=45%>

## ADetailer
> [!TIP]
> 如果设置太复杂，只需记住调整右下角的金色参数（Denoise）。

*ComfyUI*
> [!CAUTION]
> 从未知 / 不可信站点下载任何 .pt 文件前请先核实！
> https://github.com/ltdrdata/ComfyUI-Impact-Pack/issues/843

`ADetailer` 需要 [Impact Pack](https://github.com/ltdrdata/ComfyUI-Impact-Pack) 8.28.3 [latest](https://github.com/ltdrdata/ComfyUI-Impact-Pack/commit/429d0159ad429e64d2b3916e6e7be9c22d025c3c) 与 [Impact Subpack](https://github.com/ltdrdata/ComfyUI-Impact-Subpack) [latest](https://github.com/ltdrdata/ComfyUI-Impact-Subpack/commit/50c7b71a6a224734cc9b21963c6d1926816a97f1)
`ADetailer` 模型放在 `ComfyUI\\models\\ultralytics\\bbox`
`SAM` 模型放在 `ComfyUI\\models\\sams`

*Forge Neo*
`ADetailer` 需要 [ADetailer Neo](https://github.com/Haoming02/ADetailer-Neo) [latest](https://github.com/Haoming02/ADetailer-Neo/commits/main/)
`Upscaler`、`Control Processor`、`ADetailer` 列表需从 API 读取。
默认 ADetailer 模型列表会在首次生成后更新，照常生成一张图即可。
`ADetailer` 模型放在 `sd-webui-forge-neo\\models\\adetailer` 或 `stable-diffusion-webui\\models\\adetailer`

<img src="examples/nishiki_adetailer.png" width=35%>

## 队列管理器
可以提交多个各自带有不同参数的生成任务。队列会自动开始处理并移除已完成的任务。
若出现错误，或你取消勾选 `Enable Generation`，队列会在当前任务结束后暂停并保留。
可以 `删除` 或 `查看详情` 队列中的任务。删除第一个任务会取消当前生成。
*建议队列长度不要超过 10,000。*

<img src="examples/nishiki_queue.png" width=35%>

## JSON/CSV 列表
**JSON/CSV 列表不会保存到设置文件中。**
支持 `*.json` 与 `*.csv` 文件，把它们拖入 `Image Info` 窗口（或点 `Add` 再 `Paste`）即可。文件格式请参考 `wai_characters.csv` 和 `wai_tag_assist.json`，可以直接把它们拖进 SAA 试试。
`__Random__` 不受种子约束地从列表中随机选一项，在 `Single` 与 `Batch (Random)` 模式下有效。
`__Enumerate__` 逐一枚举所有条目，仅在 `Batch (Random)` 模式下有效，在 `Single` 模式下退化为 `__Random__`。

<img src="examples/nishiki_json_csv.png" width=35%>

## 通配符
支持 `*.txt` 通配符文件，复制到 `data/wildcards`（打包版为 `resources\app\data\wildcards`）。
默认使用当前种子随机选择通配符。勾选 `wildcard random seed` 后，每次选择都会生成新的随机种子。
**不支持子文件夹。**

通配符标签前后都需要两个下划线 `__`：
```
__YourWildCardName__
```

也可以使用行内写法：
```
{ standing | sitting | on stomach | on back }
{ red | green | blue | blonde } { {long | short} hair | eyes}
```

<img src="examples/nishiki_wildcards.png" width=35%>

## Regional Condition / Couple
> [!TIP]
> 现已支持 Anima 模型。

三步体验 Regional Condition：
1. 勾选 `Regional Condition`。
2. 选择列表中的角色或你的 OC。
3. 用 `duo, masterpiece, best quality, amazing quality` 开头写 `common prompt`（别忘了质量词）。

*Forge Neo*
`Regional Condition` 需要 [SD Forge Attention Couple](https://github.com/Haoming02/sd-forge-couple) [latest](https://github.com/Haoming02/sd-forge-couple/commits/main/)

**左右两侧（Nishiki）。** 开启 Regional 后，Prompts 卡片把字段分为 **BOTH SIDES**（Common、Background、Style、共享 Negative 以及标记为 *Both* 的自定义字段）、**LEFT** / **RIGHT**（各侧的角色、Positive、各自的 Negative 和仅属于该侧的自定义字段）和 **ALL**（Exclude）。自定义字段的侧别在 Fields 编辑器中设置。**Swap** 一键交换左右（提示词、Negative、权重计划、角色、强度），可撤销；它取代了原来的“Swap Character”开关。点击角色行可打开角色选择器，每一侧都可从标题折叠。ComfyUI 上左右 Negative 与 Positive 使用同样的区域蒙版；Forge Neo 则合并为一个 Negative。

<img src="examples/nishiki_regional.png" width=35%>

## 半自动标签补全
标签数据来源：[DraconicDragon/dbr-e621-lists-archive/danbooru_e621_merged_2026-04-01_pt20-ia-dd-ed-spc.csv](https://github.com/DraconicDragon/dbr-e621-lists-archive/blob/main/tag-lists/danbooru_e621_merged/README.MD)

<img src="examples/nishiki_jp_tag_search.png" width=45%>

<details>
<summary>半自动标签补全详情</summary>
输入前几个字符即可搜索匹配的标签。Nishiki 默认同时匹配标签的开头、中间和结尾；`*tag` 与 `*tag*` 仍可作为显式的结尾 / 中间匹配模式使用。
可用鼠标选择，也可用 `键盘上下键` 配合 `Enter` / `Tab` 选择，按 `Esc` 关闭候选框。
`ctrl + 上` / `ctrl + 下` 调整当前标签或选中片段的权重（与 ComfyUI、WebUI 类似，细节逻辑可能略有不同）。

支持英语、中文和日语标签搜索。
**特别感谢 Kiratian(天痕) 协助翻译中文标签。**

*Anima 等模型的画师搜索*
用 `@` 符号激活，结果按分组 `1` 和 `8` 过滤。
在 `Anima 模型` 中应用 `Artist` 标签需在标签前加 `@`，例如 `mira` → `@mira`。

| Mark | ID | Category | Group |
| --- | --- | --- |  --- |
| `[G]` | 0 | General | Danbooru |
| `[A]` | 1 | Artist | Danbooru |
| `[©]` | 3 | Copyright | Danbooru |
| `[C]` | 4 | Character | Danbooru |
| `[M]` | 5 | Meta | Danbooru |
| `<G>` | 7 | General | E621 |
| `<A>` | 8 | Artist | E621 |
| `<©>` | 10 | Copyright | E621 |
| `<C>` | 11 | Character | E621 |
| `<S>` | 12 | Species | E621 |
| `<M>` | 14 | Meta | E621 |
| `<L>` | 15 | Lore | E621 |
| `Wildcards` | 255 | Wildcards | SAA |
</details>

## Image info
<details>
<summary>把图像拖入 SAA 窗口，支持 Png/Jpeg/Webp。</summary>
适用于 WebUI（Forge Neo 与 A1111）以及 ComfyUI（使用 ComfyUI_Mira 的图像保存节点）。
双击图像关闭。
`Send` 按钮会覆盖 `Common Prompt`、`Negative Prompt`、`Width & Height`、`CFG`、`Step` 和 `Seed`。
如果你有相同的 LoRA，`Common Prompt` 中的 LoRA 也会生效。不想在提示词中使用 LoRA 的话可以试试 `Send LoRA to Slot`。

<img src="examples/nishiki_image_info.png" width=45%>
</details>

## 角色列表
### 收藏
角色、原创角色和标签的收藏在选择弹窗中管理：打开弹窗，切换条目上的星标，之后可在顶部的收藏分组中找到它们。收藏的标签在胶囊上会高亮。收藏随设置一起保存。

### 预览与搜索
角色列表支持英文、中文和日文关键字搜索。

<img src="examples/nishiki_character_select.png" width=45%>

## 顶部按钮与右键菜单
顶部按钮从左到右：保存设置、重新加载模型列表、刷新页面、从右到左、主题切换、撤销、重做、GPU 目标（Local / Pod）。

<details>
<summary>右键菜单</summary>

菜单内容取决于右击的对象：胶囊（编辑权重、启用 / 禁用、相关标签、复制、删除、移动 / 复制到其他字段）、提示词字段（复制 / 清空字段、启用 / 禁用全部标签、发送 LoRA 到槽位、移动 / 复制选中内容）、画廊图像（复制图像 / 元数据、移除当前图像、清空画廊）、AI 字段（测试 AI 生成）。

**拼写检查（英语）**
右击带拼写错误（波浪下划线）的单词可查看建议。
<img src="examples/nishiki_spell_check.png" width=45%>

**AI 提示词生成测试**
右击 `AI prompt` 字段可在不生成图像的情况下获取 AI 提示词。结果显示在 Info 面板的 AI 标签页中；把 AI 规则切换为 `Last` 可在后续生成中沿用该结果。
<img src="examples/nishiki_ai_prompt_test.png" width=45%>

**复制图像 / 元数据**
右击 `Gallery` 可把当前图像或其元数据复制到剪贴板。
使用 Image Saver 节点的 ComfyUI 会输出类 a1111 格式的元数据。
复制图像基于把 base64 转回 PNG，但元数据会被 Chromium 内核裁掉；如需原图，请到 ComfyUI/WebUI 的输出文件夹查找。
SAAC：把图像从浏览器拖到本地文件夹，或使用浏览器右键的 `另存为`。
<img src="examples/nishiki_copy_image.png" width=35%>

**发送 LoRA 到槽位**
右击 `Common` 或 `Positive` 可把文本形式的 LoRA 发送到 LoRA 槽位。
<img src="examples/nishiki_send_lora.png" width=35%>
</details>

------
# AI 提示词
远程
1. 按设置向导配置 `Remote AI url`、`Remote AI model` 和 `API Key`。
2. 在 `AI Prompt` 中输入内容，例如 `make character furry, and I want a detailed portrait`。

本地
1. 自行编译 [Llama.cpp](https://github.com/ggml-org/llama.cpp)，或从[可信来源](https://github.com/ggml-org/llama.cpp/releases)下载。
2. 从 [HuggingFace](https://huggingface.co/) 下载模型，推荐 `oh-dcft-v3.1-claude-3-5-sonnet-20241022.Q8_0`（[这里](https://huggingface.co/mradermacher/oh-dcft-v3.1-claude-3-5-sonnet-20241022-GGUF)）之类的 GGUF。
3. 推荐服务器参数：`llama-server.exe -c 16384 --port <your local LLM port> -m "<your GGUF model here>"`
4. 把 `AI Prompt Generator` 设为 `Local`。
5. 把 `Local Llama.cpp server` 设为本地 AI 的地址和端口。
6. （可选）使用其他本地 AI 服务时请检查 API 设置。
7. 在 `AI Prompt` 中输入类似 `make character furry, and I want a detailed portrait` 的内容。

重写（Nishiki）
1. 安装 [Ollama](https://ollama.com/) 并拉取一个模型。
2. 把 AI 模式设为 `重写（Refine）`，填入 Ollama 地址和模型。
3. 照常编写提示词。每个批量的第一张图之前，重写会用一次结构化调用改写整段提示词并应用到编辑器；不满意可用 `Ctrl + Z` 撤销。
4. 若已注册 Runpod Pod，AI 主机可选择 `Pod`。

------
# Image API Interface
*ComfyUI*
> [!IMPORTANT]
> 若工作流无法正确加载，请改用 `2025-05-03-022732_1775747588.json`。

1. 在 ComfyUI 设置中启用 `DEV mode`，并把 `examples\2025-05-03-022732_1775747588.png` 载入 ComfyUI；确认已安装 [ComfyUI_Mira](https://github.com/mirabarukaso/ComfyUI_Mira) **v0.5.6.0 或以上**。
    1.1. 可能需要通过 ComfyUI → Manager → Install PIP packages → opencv-python 安装 `opencv-python`。
2. 把 `Image API Interface` 设为 `ComfyUI`。
3. 确认 `Image Interface IP Address:Port` 与你的 ComfyUI 页面一致。
4. 开始使用。

若 SAA 中预览有问题，在启动 BAT 中加入 `--preview-method latent2rgb`：
```
py ComfyUI\main.py --fast --use-sage-attention --cuda-malloc --windows-standalone-build --listen 0.0.0.0 --port 58188 --preview-method latent2rgb
```

*Forge Neo（WebUI）*
1. 在 `COMMANDLINE_ARGS`（webui-user.bat）中加入 ` --api` 启用 `API mode`。
2. 启动 WebUI。
3. 把 `Image API Interface` 设为 `WebUI`。
4. 确认 `Image Interface IP Address:Port` 与你的 WebUI 页面一致。
5. 开始使用。

## 第三方混合后端的自定义路径
> [!WARNING]
> 启用自定义路径会覆盖你的模型路径设置。
> 不建议在官方 WebUI（Forge Neo/A1111）和 ComfyUI 上使用。

编辑 `data/custom_path.yaml` 启用自定义路径：
1. 把 `use_custom_path` 设为 `true`。
2. 把 `enable` 设为 `false` 可禁用整个分类。
3. 注释掉不需要覆盖的单个自定义路径。
4. 路径列表支持单行字符串与多行字符串。
5. 支持绝对路径与相对路径（相对于 base_path）。

[#92 在 Stability Matrix 中使用 ComfyUI 时的自定义路径设置](https://github.com/mirabarukaso/character_select_stand_alone_app/issues/92)

## 远程使用时的文件夹路径问题
SAA 需要搜索 ComfyUI/WebUI 的 checkpoints 文件夹来获取模型、LoRA 等条目。若后端地址为远程（非 127.0.0.1），文件夹搜索会失败，SAA 会以 `Default` 模式运行。该模式下无法更换模型或通过槽位设置 LoRA。
两种解决办法：
1. `镜像文件夹` —— 把远程 `models` 文件夹复制到本地，然后让 SAA 使用本地文件夹。简单，但需要额外空间。
2. `符号链接或共享文件夹` —— 创建符号链接，或把远程 `models` 文件夹设为共享（建议只读），然后让 SAA 使用该文件夹。

## 高级安全设置（API 认证）
> [!WARNING]
> *不要把任何未加保护的本地端口转发到公网。*
> *仅限 WebUI（Forge Neo）。在 ComfyUI 提供正规且安全的方式之前，不要把 ComfyUI API 转发到公网。*

更多 WebUI（Forge Neo）命令行参数见 [Command-Line-Arguments-and-Settings](https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/Command-Line-Arguments-and-Settings)。

把 `webui-user.bat` 复制为 `webui-user-api.bat`，然后按以下参数编辑。
把 `user:pass` 替换为你的 `用户名:密码`。
`--api` `--api-auth` 启用 API 与 API 认证。
`--nowebui` 表示不需要浏览器界面。
`--port 58189` 把 API 端口设为 `58189`。
```
set COMMANDLINE_ARGS= --xformers --no-half-vae --api --api-auth user:pass --nowebui --port 58189
```
用新的 `webui-user-api.bat` 启动 Forge Neo。
把 `用户名:密码` 粘贴到 SAA → Settings → `WebUI API Auth`，然后把 `Enable` 设为 `ON`。

------
# Hires Fix 与 Image Color Transfer
Image Color Transfer 详情见 [Image Color Transfer](https://github.com/mirabarukaso/ComfyUI_Mira#image-color-transfer)。
*由于缺少生成规则且没有 openCV，WebUI 不再支持 Color transfer。*

确保所有放大模型位于 `upscale_models` 文件夹。

ComfyUI 注意事项：
需自行下载放大模型：`Manager` → `Model Manager`，用 `upscale` 过滤。

WebUI（Forge Neo/A1111）放大器注意事项：
WebUI 使用基于名称的放大模型列表。`静态放大器列表` 可用，并会在首次生成后更新为 API 列表。

Forge 使用基于文件的放大模型列表，比较混乱：
  **重要：如果 upscale_models 文件夹不存在，SAA 会使用静态放大器列表。**
  **不确定的话，生成一次即可，HiFix 模型列表会正确更新。**
  解决办法：
  1. 在 `models` 中创建 `upscale_models` 文件夹，把所有放大模型放进去。
  2. 以放大模型文件夹名（例如 `ESRGAN`）创建指向 `upscale_models` 的符号链接。
  3. 重启 Forge。`Hires Fix` 模型现在应该可用，并在首次生成后更新为 API 列表。

------
# 中文翻译与角色验证
衷心感谢以下无私奉献、付出宝贵时间提供中文翻译与角色数据验证的朋友（排名不分先后）：
**Silence, 燦夜, 镜流の粉丝, 樱小路朝日, 满开之萤, 以及两位不愿具名的朋友。**

# 角色列表特别感谢
lanner0403 [WAI-NSFW-illustrious-character-select](https://github.com/lanner0403/WAI-NSFW-illustrious-character-select)
Cell1310  [Illustrious XL (v0.1) Recognized Characters List](https://civitai.com/articles/10242/illustrious-xl-v01-recognized-characters-list)
mobedoor [#23](https://github.com/mirabarukaso/character_select_stand_alone_app/issues/23)
UdinXProgrammer [#62](https://github.com/mirabarukaso/character_select_stand_alone_app/issues/62)
Nurimtod [#75](https://github.com/mirabarukaso/character_select_stand_alone_app/issues/75) [#83](https://github.com/mirabarukaso/character_select_stand_alone_app/issues/83)
atmogenic [#84](https://github.com/mirabarukaso/character_select_stand_alone_app/issues/84) [#85](https://github.com/mirabarukaso/character_select_stand_alone_app/issues/85)
funnygeeker [#87](https://github.com/mirabarukaso/character_select_stand_alone_app/issues/87)

------
# FAQ
双击 `saa.exe` 没有反应？
1. 可能是文件下载失败或文件缺失。
2. 在控制台中运行：在资源管理器地址栏输入 `cmd` 打开控制台。
3. 输入 `saa` 回车，查看后端日志。

设置向导搞砸了……
1. 关闭应用。
2. 删除 `settings`（打包版为 `resources/app/settings`）中的 `app.json`。
3. 再试一次。

ERR_CONNECTION_REFUSED
1. 多数情况下是（ComfyUI/WebUI）后端 API 地址填错了。

有浏览器版的 SAA 吗？
1. 有。
2. 详见 `高级安全设置（API 认证）`。

Error HTTP 400 ...... Cannot execute because node StepAndCfg does not exist ......
1. 安装 `ComfyUI_Mira`。
2. 重启 ComfyUI。

放大模型列表为 `None`（ComfyUI）
1. 是否修改过默认目录配置？
2. 是否为非官方版本？
3. 查看 [#58](https://github.com/mirabarukaso/character_select_stand_alone_app/issues/58)

ComfyUI/WebUI is busy, cannot run new generation, please try again later.
参见 [README_SAAC.md](README_SAAC.md) 中的第 5、6 条。

我的设置和预设在哪里？
1. `settings/app.json`、`settings/state.json`、`settings/presets/`、`settings/user_lists.json`。参见[设置存储](#设置存储)。
2. Nishiki 之前的 `settings/*.json` 会在首次启动时移到 `settings/legacy/`。
