# jx-json

大文件 JSON 格式化工具（Vite + React + TypeScript）：左侧输入原始 JSON，右侧自动美化呈现（语法着色、折叠、虚拟滚动）。

## 性能

- **100MB JSON 全量格式化 ≈ 250ms**（浏览器端到端，WebAssembly 核心）
- 虚拟滚动查看器只渲染可视行（100MB → 约 300 万行依旧流畅滚动、可折叠）
- 折叠状态在重新格式化后保持

## 运行

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # 类型检查 + 生产构建
npm run gen-sample   # 生成测试样本（public/sample-*.json）
```

测试样本：`node scripts/gen-sample.mjs <mb> <typical|dense> [outfile]`
（`typical` 为 API 风格对象数组；`dense` 为短 token 密集型最坏形状。）

页面支持 `#bench=<样本URL>` 测试钩子：绕过 textarea 粘贴路径，直接对 Worker 管线灌入大样本（大于约 50MB 的文本建议走该路径或后续的文件入口，浏览器对超大 textarea 粘贴本身会成为瓶颈）。

## 架构

```
src/
├── worker/
│   ├── reformat.ts        # 字节级单遍重排器（纯 JS 参考实现 + 回退）
│   ├── jx_core.wasm       # Rust 编译的 WASM 核心（~13KB）
│   ├── format.worker.ts   # Worker：WASM 优先，JS 回退
│   └── protocol.ts        # 消息契约与 ViewModel
├── engine/
│   └── formatController.ts# 主线程编排（latest-wins、错误行列换算）
├── viewer/
│   ├── JsonViewer.tsx     # 虚拟滚动 + 折叠 + 语法着色
│   ├── FoldState.ts       # 折叠区间 → 可见行映射
│   └── tokens.ts          # 行级分词着色
└── App.tsx                # 双栏布局与状态栏
```

核心思想：**美化 = 重排空白，不需要解析值**。WASM 核心（`src-wasm/`，Rust no_std）
扫描 UTF-8 字节流识别结构与 token 边界，token 原样复制到预分配缓冲（数字不丢精度、
字符串不解码），同时产出行偏移与折叠区间 typed arrays；Worker 内整体执行，主线程
零阻塞。JS 版（`reformat.ts`）语义完全一致，作为参考实现与 WASM 不可用时的回退。

### WASM 关键约束（踩坑记录）

- 线性内存与模块静态数据共存：竞技场必须整体位于静态区之上（`jx_arena_base()`），
  否则 bump 增长会覆盖静态变量，产生布局敏感的诡异损坏。
- 整数→指针需统一 provenance：所有访问经 `ANCHOR` 静态量派生，且基指针对优化器
  不透明（`black_box`）——否则 -O1 起只写不读的输出缓冲会被当死存储删除。
- 行偏移数组增长必须先保证 `line_count+1` 槽位再写入（越界写曾引发连锁损坏）。

### 重建 WASM 核心

```bash
rustup target add wasm32-unknown-unknown
cargo build --manifest-path src-wasm/Cargo.toml --target wasm32-unknown-unknown --release
cp src-wasm/target/wasm32-unknown-unknown/release/jx_core.wasm src/worker/jx_core.wasm
```
