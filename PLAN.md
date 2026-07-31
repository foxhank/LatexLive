# 实时 LaTeX 编辑器 (LiveLaTeX) — 实现方案

## 目标
Windows 桌面应用,左侧 LaTeX 源码编辑、右侧实时 PDF 预览,本机编译,一键启动,实时本地文件读写。

## 技术栈
- **Electron 3x** — 桌面外壳,主进程 + 渲染进程
- **CodeMirror 6** — 源码编辑器(语法高亮、行号、可折叠)
- **pdf.js (pdfjs-dist)** — PDF 渲染(分页/缩放/文本层,可承载跳转)
- **electron-store** — 用户设置持久化(编译器路径、字体等)
- **chokidar** — 监听 PDF 文件变化以触发预览刷新
- **synctex-js** — 解析 `.synctex.gz` 做正反向跳转(无外部二进制依赖;若库不可用回退到 `synctex view -i line:col:input -o output` 命令)
- **electron-builder** — 打包成单文件 `.exe`(portable + nsis 安装版)

## 目录结构
```
latex_comp/
  package.json
  electron-builder.yml
  src/
    main/                 # 主进程
      index.ts            # 应用入口、窗口管理、IPC 路由
      ipc.ts              # 所有 IPC 处理器(file/compile/synctex)
      compiler.ts         # 探测/调用 LaTeX 编译器,防抖队列
      fileWatcher.ts      # .synctex.gz + .pdf 变化监听
      synctex.ts           # synctex 正反向查询(库优先,命令行回退)
    preload/
      index.ts            # contextBridge 暴露安全 API
    renderer/
      index.html
      main.ts             # 渲染进程入口
      editor/             # CodeMirror 封装
      viewer/             # pdf.js 封装,处理跳转与刷新
      ipc.ts              # 调用 preload API 的封装
      components/         # 工具栏、状态栏、设置对话框
  assets/
    icon.ico
```

## 数据流与关键流程

### 文件读写
- 渲染进程 → `window.api.file.open()` → 主进程 `dialog.showOpenDialog` → 读 `.tex` → 返回内容 + 路径
- 保存:`window.api.file.save(content)` → 写盘;`Ctrl+S` 及编辑防抖(1.5s 无新输入)自动保存到当前路径;无路径时弹「另存为」

### 编译(防抖自动)
- 编辑器变更 → 防抖 800ms → 主进程 `compiler.queue(filePath)`
- 编译命令:`<engine> -interaction=nonstopmode -synctex=1 -output-directory=<tmp> <file>`
  - engine 默认 `xelatex`,可配 `pdflatex`/`lualatex`/`latexmk`
  - 若引擎探测失败,设置页提示用户填路径
- 解析 `.log` 抽取错误行号 → 经 IPC 推送到编辑器 gutter 高亮
- 编译产物 `.pdf` 写到 `<tmp>/<jobname>.pdf`,用 chokidar 监听变化 → 推送 `pdf:updated` → pdf.js 重新加载(保留当前页/缩放/滚动位置)

### 正反向同步(SyncTeX)
- 正向(Ctrl+点击编辑器某行):CodeMirror 取行号 → `synctex view -i line:col:input -o output` 或库查询 → 返回 PDF 页码+坐标 → pdf.js `scrollToPage(page, x, y)` + 临时高亮标记
- 反向(Ctrl+点击 PDF):pdf.js 取页码+页面坐标 → synctex 反查 → 编辑器 `scrollToLine(line)` + 光标定位
- 编译时强制 `-synctex=1`,确保 `.synctex.gz` 存在

### 设置(编译器路径)
- 首次启动自动探测 PATH 里的 `xelatex`/`pdflatex`/`latexmk`;探测不到时弹设置对话框让用户填
- 设置存 electron-store: `{ engine, enginePath, editorFont, theme, debounceMs }`

## 安全
- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- preload 用 contextBridge 白名单暴露 API,渲染进程无法直接 require Node 模块
- 编译命令参数经路径校验,防注入

## 打包
- electron-builder:target `nsis`(安装版)+ `portable`(单 exe 直接双击运行)
- pdf.js worker 走 `Worker` URL,打包时随 app 资源一起走 `asar`(或 unpacked 以保证 worker 可加载)
- 启动应用即打开默认空文档或上次文件,无需额外步骤 → 「一键启动」

## 实现步骤(分阶段,每步可独立验证)
1. **脚手架**:package.json、electron、esbuild/ts、主/preload/渲染三进程最小可跑(空窗口)
2. **文件读写 IPC**:打开/保存/另存为/最近文件;`Ctrl+O`/`Ctrl+S`
3. **CodeMirror 6 集成**:LaTeX 语法高亮、行号、编辑事件 → 防抖保存
4. **pdf.js 预览面板**:静态加载示例 PDF,缩放/翻页
5. **编译器模块**:探测 PATH + 用户配置路径;跑通 `xelatex` 编一个最小 `.tex`
6. **自动编译联动**:防抖 → 编译 → `.log` 错误高亮 → `pdf:updated` 刷新预览(保留视图状态)
7. **SyncTeX 正反向跳转**:库优先,命令行回退
8. **设置对话框**:引擎选择、路径、防抖时长、主题
9. **打包**:electron-builder 配置,产出 nsis + portable

## 验收标准
- 双击 exe 打开应用,左侧编辑右侧空白预览
- 打开 `.tex`、编辑、Ctrl+S 保存;停止输入 ~1s 后自动编译,右侧 PDF 自动刷新
- Ctrl+点源码行 → PDF 跳转;Ctrl+点 PDF → 源码定位
- 未配置编译器时引导到设置页
```
