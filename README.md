# LyricFlux

> 在 Obsidian 笔记中嵌入音频播放器 + 逐行滚动歌词 + 逐字高亮，支持侧边栏同步滚动，支持双语注释。

---

## 这是什么

LyricFlux 是基于 [obsidian-lyrics](https://github.com/eatgrass/obsidian-lyric) 的修改版本，在原版基础上新增：

- **逐字高亮（卡拉OK）** — 播放时按字变色 + 光晕，支持中/日/英/俄文
- **双语注释语法** — `<注释>` 格式，注释不参与逐字高亮，显示为第二语言
- **侧边栏歌词面板** — 右侧栏实时显示歌词，当前行放大高亮，非当前行缩小淡化
- **侧边栏逐字高亮** — 侧边栏当前行同步逐字变色
- **循环播放** — 侧边栏的状态栏可选择开启或关闭循环播放按钮
- **侧边栏按钮** — 左侧栏一键打开歌词面板
- **外链歌词** — 支持 `lyrics [[file.lrc]]` 引用 vault 内或绝对路径的歌词文件
- **中文界面** — 设置页、插件简介全部中文化

---

## 安装

### 方式一：BRAT 安装

1. 在 Obsidian 中安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. 打开 BRAT 设置 → 点击 **Add Beta plugin** → 输入仓库地址：
   ```
   https://github.com/fhb263/obsidian-lyricflux
   ```
3. 安装完成后，在 设置 → 第三方插件 → 启用 **LyricFlux**

### 方式二：手动安装

1. 从本仓库的 [Releases](https://github.com/fhb263/obsidian-lyricflux/releases) 下载最新版本的三个文件：
   - `main.js`
   - `styles.css`
   - `manifest.json`
2. 将这三个文件复制到你的 Vault 目录下：
   ```
   <你的Vault>/.obsidian/plugins/lyricflux/
   ```
3. 重启 Obsidian → 设置 → 第三方插件 → 启用 **LyricFlux**

---

## 使用方法

### 笔记内三种写法
#### ①半内链 — MP3文件 + 内嵌时间戳（基于库的相对路径）

在笔记中插入 ` ```lrc ` 代码块：

````markdown
```lrc
source [[music.mp3]]
[00:01.00] 第一行歌词
[00:03.50] 第二行歌词
[00:06.00] 第三行歌词
```
````

#### ②全内链 — MP3文件 + LRC文件（基于库的相对路径）

使用 `lyrics` 指令引用 vault 内的 LRC/SRT 文件，无需内嵌歌词：

````markdown
```lrc
source [[海阔天空.mp3]]
lyrics [[海阔天空.lrc]]
```
````

- `source [[音频文件]]` — 指定音频源（支持 Obsidian 内部链接或相对路径）
- `lyrics [[歌词文件]]` — 指定歌词文件（LRC 或 SRT 格式）

#### ③全外联 — MP3文件 + LRC文件（支持引用盘符的绝对路径）

也可以使用盘符的绝对路径指向 vault 外的音频和歌词文件：

````markdown
```lrc
source C:\Users\用户名\Downloads\musics\海阔天空.mp3
lyrics C:\Users\用户名\Downloads\lyrics\海阔天空.lrc
```
````

- `source` 和 `lyrics` 均支持直接使用 Windows 绝对路径
- 无需将文件放入 vault，适合管理大量本地音乐文件的用户

### 支持格式

- **LRC** — `[hh:mm:ss.xx] 歌词内容`
- **SRT** — SubRip 字幕格式

### 逐字高亮（卡拉OK效果）

在 设置 → LyricFlux → 逐字高亮 中开启。开启后：

- 主编辑区：当前行歌词按字逐个变色 + 光晕效果
- 侧边栏：当前行歌词同步逐字变色
- 支持中文（按单字拆分）、日文（假名与英数字合并为一组）、英文（按空格分词，空格保留）、俄文
- 播放中切换开关可实时重新渲染

### 双语注释语法

用 `<注释>` 格式包裹第二语言，`<>` 内内容不参与逐字高亮：

````markdown
```lrc
source [[music.mp3]]
[00:01.00] こんにちは世界<Hello World>
[00:03.50] 今天天气真好<The weather is nice today>
```
````

- 主编辑区：第一语言正常显示，第二语言显示为灰色小字
- 侧边栏：注释紧跟在第一语言文字下方
- 逐字高亮仅对第一语言文字生效

### 侧边栏歌词面板

1. 点击左侧栏的音乐图标，或 `Ctrl+P` 输入 "Open LyricFlux"
2. 打开含 `lrc` 代码块的笔记，歌词自动同步到侧边栏
3. 当前行放大高亮，非当前行缩小淡化
4. 开启逐字高亮后，侧边栏当前行同步逐字变色
5. 点击侧边栏歌词行可跳转播放位置

### 右键菜单

在阅读模式（Reading View）中右键歌词区域：

- 播放 / 暂停
- 跳转到此时间
- 编辑源码
- 复制时间戳
- 自动滚动
- 逐句模式

---

## 插件设置

| 设置项      | 说明                       | 默认  |
| -------- | ------------------------ | --- |
| 自动滚动     | 播放时自动跟随当前歌词行滚动           | 开   |
| 逐句模式     | 启用后每句结束自动暂停（适合跟读/学习）     | 关   |
| 逐字高亮     | 开启为卡拉OK级逐字高亮，关闭则为逐行高亮    | 关   |
| LRC笔记文件夹 | 设定 LRC 歌词文件的存储目录（支持相对路径） | 空   |

---

## 自定义样式

通过 CSS 类名自定义样式：

### 主编辑区

| CSS 选择器 | 说明 |
|------------|------|
| `.lyrics-line` | 每行歌词容器 |
| `.lyrics-timestamp` | 时间戳文字 |
| `.lyrics-text` | 歌词正文容器 |
| `.lyrics-highlighted` | 当前播放高亮行 |
| `.lyrics-text.lyrics-karaoke` | 逐字高亮模式 |
| `.lyrics-word` | 逐字高亮的单个字/词 |
| `.lyrics-word-active` | 当前已高亮的字/词 |
| `.lyrics-lang-secondary` | 注释/第二语言文字 |

### 侧边栏

| CSS 选择器 | 说明 |
|------------|------|
| `.lyrics-panel-content` | 侧边栏歌词容器 |
| `.lyrics-panel-line` | 侧边栏每行歌词 |
| `.lyrics-panel-highlighted` | 侧边栏当前行 |
| `.lyrics-panel-text` | 侧边栏歌词文字容器 |
| `.lyrics-panel-annotation` | 侧边栏注释文字 |
| `.lyrics-panel-word` | 侧边栏逐字高亮的单个字/词 |
| `.lyrics-panel-word-active` | 侧边栏逐字高亮的当前字 |

---

## 技术栈

| 层面 | 技术 | 版本 |
|------|------|------|
| 运行平台 | Obsidian（Electron / 移动端） | ≥ 0.15.0 |
| 前端框架 | Svelte | ^4.2.2 |
| 语言 | TypeScript | 5.2.2 |
| 构建工具 | esbuild + esbuild-svelte | 0.17.3 |

---
## 插件存在已知问题，但无计划

| #   | 问题            | 说明                        |
| --- | ------------- | ------------------------- |
| 1   | **关闭笔记即暂停**   | 插件本质是笔记内播放器，关闭标签页歌曲随之暂停   |
| 2   | **歌单无法点播即放**  | 点击后需悬停或锁定标签页，侧边栏才会响应并开始播放 |
| 3   | **歌单覆盖当前标签页** | 若已有活动标签页，点击歌单会直接覆盖而非新建标签  |
| 4   | **逐字高亮非逐字对齐** | 当前只能按句分配时间，无法做到逐字精准匹配     |
| 5   | **歌单列表无筛选类型** | 曾经做出过但太丑故无计划再做            |

---

## 许可证

基于 [MIT License](LICENSE)。
