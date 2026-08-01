# LiveLaTeX

LiveLaTeX 是一款专注于实时预览的 LaTeX 编辑器。现有的 LaTeX 编辑器大多需要手动保存后编译，或在云端在线编译，无法在编辑的同时即时看到渲染结果，故开发了这款软件。

LiveLaTeX 将编辑器与 PDF 预览放在同一窗口：左侧为源码编辑器（支持语法高亮），右侧为实时 PDF 预览。编辑内容会通过临时副本自动触发编译并刷新预览，无需手动保存；确认无误后按 Ctrl+S 保存到原文件，即使编辑出错也不会污染原始文档。应用内置 TinyTeX 编译器自动检测与缺失宏包自动安装，开箱即用。

## 特性

- 左侧 CodeMirror 6 编辑器，支持 LaTeX 语法高亮
- 右侧 pdf.js 实时 PDF 预览，支持缩放与翻页
- 编辑即预览：基于临时副本编译，不修改原文件
- 本地编译：使用 XeLaTeX / pdfLaTeX / LuaLaTeX 等引擎
- 自动安装缺失宏包（如 cite、algorithms 等）
- 打开、保存、另存为本地 `.tex` 文件

## 使用方式

1. 从 [Releases](https://github.com/foxhank/LatexLive/releases) 页面下载对应版本的压缩包，解压后双击 `LiveLaTeX.exe` 启动。
2. 从 TinyTeX 官方发布页下载 LaTeX 编译器：
   - 下载地址：https://github.com/rstudio/tinytex-releases/releases
   - 选择 Windows 版本 `TinyTeX-1-windows-*.exe`（约 70 MB）
   - 解压或安装后将 `TinyTeX` 文件夹放置于应用目录下的 `resources/texlive/`（即 `resources/texlive/TinyTeX/bin/windows/xelatex.exe`）。
   - 也可以安装 TinyTeX 到任意位置，然后在应用的设置页中手动指定编译器路径。
3. 打开应用，通过"打开"按钮（或 Ctrl+O）选择 `.tex` 文件，开始编辑。右侧预览会在停止输入后自动刷新。

## 系统要求

- Windows 10 及以上（x64）
- 无需预装 Python 或 Node.js（已内置）

## 从源码构建

```bash
npm install
npm run setup:tex    # 下载并解压 TinyTeX 编译器（约 300 MB），只需一次
npm run dev          # 开发模式
npm run dist         # 打包发布
```

## 许可

MIT License
