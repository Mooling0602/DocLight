# DocLight ✦ 轻量可视化文档站

简洁优雅、现代感的自托管文档站：**浏览器里直接所见即所得排版**，深浅色主题自动跟随系统。

![TypeScript](https://img.shields.io/badge/TypeScript-ES2022-3178C6) ![node](https://img.shields.io/badge/node-%E2%89%A520-339933)

## 启动

```bash
npm install               # 安装依赖（含运行时依赖 smol-toml）
npm start                 # 构建并自动探测空闲端口（默认从 4173 起）
PORT=8080 npm start       # 临时指定起始端口（环境变量覆盖配置文件）
```

启动后按提示访问，例如 `http://localhost:4173`。

### 配置文件（TOML）

正式配置写在 TOML 文件里：默认读取 `<项目根>/doclight.toml`，也可用 `DOCLIGHT_CONFIG`
指向别处。**文件不存在时静默使用内置默认值**（首次运行开箱即用）；但**文件存在却解析失败
时会报错退出并指出行号**，不会静默忽略。未设置的键直接省略：

```toml
port = 4173
host = "127.0.0.1"          # 省略表示监听全部网卡
strictPort = false          # true 时端口占用直接报错，不再向后探测
dataDir = "/var/lib/doclight"

icp = "浙ICP备12345678号-1"
police = "京公网安备11010502030123号"
copyright = "© 2026 Mooling"
# icpUrl / policeUrl 未配置时按内置规则推导，无需写出
```

### 配置优先级

```
内置默认值  <  doclight.toml  <  环境变量
```

配置文件是正式载体，环境变量只作**临时覆盖**：且仅覆盖它显式设置的那些键，其余键仍读文件。
**变量存在即视为设置**——`DOCLIGHT_ICP=""` 会清空备案号而**不**回退到文件，方便临时关闭悬挂。
路径由 `DOCLIGHT_CONFIG` 指定（它只定位文件，不参与值的覆盖）。

### 环境变量（覆盖配置文件）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DOCLIGHT_CONFIG` | `<项目根>/doclight.toml` | 配置文件路径 |
| `PORT` | `4173` | 起始端口；被占用时自动向后探测 |
| `DOCLIGHT_HOST` | 全部网卡 | 监听地址，如 `127.0.0.1` |
| `DOCLIGHT_DATA_DIR` | `<项目根>/data` | 数据目录（`pages.json`、`auth.json`） |
| `DOCLIGHT_STRICT_PORT` | 未设置 | 非空即启用；端口占用直接报错，不再向后探测 |
| `DOCLIGHT_ICP` | 未设置 | 网站备案号，如 `浙ICP备12345678号-1` |
| `DOCLIGHT_ICP_URL` | 工信部备案系统 | 覆盖备案号链接 |
| `DOCLIGHT_POLICE` | 未设置 | 公安联网备案号，如 `京公网安备11010502030123号` |
| `DOCLIGHT_POLICE_URL` | 按备案号推导的查询页 | 覆盖公安备案号链接 |
| `DOCLIGHT_COPYRIGHT` | 未设置 | 版权行，如 `© 2026 Mooling` |

> 类型以 TOML 为准：`strictPort` 只认布尔 `true`，端口必须是 `1–65535` 的整数，
> 否则启动时报错退出——**不会**静默退回默认值。环境变量是字符串，`DOCLIGHT_STRICT_PORT`
> 沿用「非空即启用」的旧语义（空串视为关闭）。

> 作为 systemd 服务运行时建议在 TOML 里固定 `port` 并设 `strictPort = true`：
> 反向代理只指向一个固定端口，静默漂移会导致代理落空。

### 备案号悬挂

面向中国大陆服务器的合规要求：备案号需悬挂在页面底部并链接至主管机关查询系统。
配置后效果如下（未配置则整块不存在）：

```toml
# doclight.toml
icp = "浙ICP备12345678号-1"
police = "京公网安备11010502030123号"
copyright = "© 2026 Mooling"
```

实现上有三点是刻意为之：

- **服务端注入，而非前端渲染**。合规检查抓取的是原始 HTML，不执行 JavaScript；
  若把备案号交给 SPA 生成，人工访问看着正常，机器核查却是空页。因此页脚由
  `src/beian.ts` 在服务端渲染并写入 `public/index.html` 的注入标记位，
  `curl` 直接就能看到。
- **Nix 模块把备案信息写进生成的 TOML，不再走环境变量**。这从根本上绕开了 systemd
  对 `Environment` 的字符串解析：含空格的值（如 `© 2026 Mooling`）不再有被截断的风险，
  服务只通过 `DOCLIGHT_CONFIG` 拿到文件路径。
- 若仍需环境变量传递，注意**不能写进 systemd 的 `Environment` 列表**：列表元素是裸字符串，
  nixpkgs 不加引号，`© 2026 Mooling` 会被 systemd 解析成第二个赋值而截断成 `©`。

## 功能

| 类别 | 能力 |
| --- | --- |
| 可视化编辑 | H1–H3、粗斜下删、行内代码 / 代码块、列表、引用、链接、图片、分隔线；撤销重做、快捷键（⌘S/B/I/U/Z）、Tab 缩进 |
| 内容安全 | 服务端 XSS 清洗（剥离脚本/事件属性/危险协议）、粘贴自动清理排版垃圾 |
| 页面管理 | 新建（slug 自动生成并永久绑定）、重命名、编辑 slug、删除、侧栏搜索 |
| 空间管理 | 新建 / 重命名 / 编辑 slug / 删除（含空间内全部页面） |
| 阅读体验 | 正文默认限宽，桌面端可拖拽把手调整宽度（双击复位、本地记忆，自动限制在可视区域内） |
| 主题 | 跟随系统 `prefers-color-scheme` / 手动浅色·深色三态切换，本地记忆，绘制前预置防闪烁 |
| 配置管理 | TOML 配置文件（`doclight.toml`，缺省静默用默认值、非法则报错退出）+ 环境变量临时覆盖 |
| 工程细节 | TypeScript 编译、SPA 回退路由、原子化 JSON 写入、请求日志、移动端抽屉导航、打印样式 |

## 目录结构

```
DocLight/
├── src/
│   ├── server.ts      # 后端：静态资源 + REST API + 端口探测
│   ├── config.ts      # 分层配置：内置默认值 < TOML 文件 < 环境变量
│   ├── beian.ts       # 备案号页脚渲染（服务端注入）
│   ├── client/app.ts  # 前端单页应用
│   └── tests/         # TypeScript 回归测试
├── doclight.toml      # 配置文件（可选，默认路径；不存在则用内置默认值）
├── template/pages.json # 示例站点（首次启动复制到数据目录）
├── data/              # 运行时数据目录（已 gitignore，首启自动创建）
│   ├── pages.json     # 文档数据（由 template/ 初始化）
│   └── auth.json      # 站长账号（敏感，绝不提交）
├── flake.nix          # Nix 打包 + NixOS 模块（含备案配置）
└── public/
    ├── index.html     # 应用骨架
    ├── style.css      # 主题变量 + 组件样式
    └── app.js         # TypeScript 编译产物（自动生成）
```

> 首次启动时若数据目录里没有 `pages.json`，会从 `template/pages.json` 复制一份示例站点过去；
> `data/` 整个目录都在 `.gitignore` 中，因此运行时内容不会与仓库里的示例数据混在一起。
> 想更换默认示例，直接编辑 `template/pages.json` 即可。

## 开发与测试

```bash
npm run build  # 编译服务端、客户端与测试
npm test       # 编译并运行所有回归测试
```

## Nix / NixOS

仓库自带 `flake.nix`（已启用 flakes），无需本机安装 Node 或 npm：

```bash
# 直接运行，数据写入 ${XDG_DATA_HOME:-~/.local/share}/doclight
nix run .

# 换个起始端口 / 指定数据目录（环境变量覆盖配置）
PORT=8080 nix run .
DOCLIGHT_DATA_DIR=/tmp/docs nix run .

# 用配置文件
DOCLIGHT_CONFIG=/path/to/doclight.toml nix run .

# 构建到 ./result（命令名 doclight）
nix build .#default
./result/bin/doclight

# 开发环境（nodejs_22 / typescript-language-server / nixfmt）
nix develop

# 跑回归测试（复用包定义，在构建目录里执行 npm test）
nix flake check
```

`nix run .` 会在源码变化时重新编译；注意 flake 取的是 **Git 树**，新增文件需要先 `git add`（不必 commit）。

NixOS 上也可以声明式部署：

```nix
{
  inputs.doclight.url = "github:Mooling0602/DocLight";

  # 在 NixOS 配置里
  imports = [ inputs.doclight.nixosModules.default ];

  services.doclight = {
    enable = true;
    port = 4173;
    address = "127.0.0.1"; # 默认只监听回环，公网经反向代理
    openFirewall = false;

    # 备案信息（面向大陆服务器）；不填则页面底部不出现该区块
    icp = "浙ICP备12345678号-1";
    police = "京公网安备11010502030123号";
    copyright = "© 2026 Mooling";

    # 逃生口：直接写入生成 TOML 的任意配置项（细粒度选项优先级更高）
    settings = {
      host = "127.0.0.1";
    };
  };
}
```

模块把上述选项生成一份 TOML 交给服务，只通过 `DOCLIGHT_CONFIG` 传路径——备案信息不再走
环境变量，因此 `© 2026 Mooling` 这类含空格的值不会再被 systemd 截断。

服务以 `DynamicUser` 运行，数据落在 `/var/lib/doclight`（systemd `StateDirectory`）。
配置了 `address = "0.0.0.0"` 时才需要 `openFirewall = true`。

> **为什么数据目录必须外置**：包安装到只读的 Nix store，而 DocLight 会写 `pages.json`
> 和 `auth.json`。模块把 `dataDir` 写进生成的 TOML 并同时设置 `DOCLIGHT_DATA_DIR` 对齐
> systemd 状态目录；`strictPort = true` 也由模块固定注入，端口占用直接失败——否则自动
> 探测会静默漂到下一个端口，反向代理就落空了。
>
> 合并顺序为 `模块默认值 < settings < 细粒度选项`，模块强制项（`strictPort`、`dataDir`）
> 最后注入、不可覆盖。注意 `port` / `address` 的默认值是 `null`（而非具体值），这样
> `settings.port` 才能生效；真正默认值在合并后补上。

### 支持的架构

flake 声明 `x86_64-linux`、`aarch64-linux`、`aarch64-darwin`。构建只需 Node 与
TypeScript，无平台相关代码；`package-lock.json` 里的 `optionalDependencies` 覆盖各平台
的编译器版本，aarch64 上直接 `nix build` 即可。

## REST API

```
GET    /api/tree          空间和页面元信息树
GET    /api/pages         页面元信息列表
GET    /api/pages/:slug   单页详情
POST   /api/pages         新建 {title, space, parent?}
PUT    /api/pages/:slug   更新 {title?, content?, slug?, space?, parent?}
DELETE /api/pages/:slug   删除页面及其子页面
POST   /api/spaces        新建 {title, desc?}
PUT    /api/spaces/:slug  更新 {title?, desc?, slug?}
DELETE /api/spaces/:slug  删除空间及其页面
```

> 页面和空间的写操作需要登录。定位：个人 / 小团队本地知识库；多用户权限、协同编辑不在范围内。
