# DocLight ✦ 轻量可视化文档站

简洁优雅、现代感的自托管文档站：**浏览器里直接所见即所得排版**，深浅色主题自动跟随系统。

![TypeScript](https://img.shields.io/badge/TypeScript-ES2022-3178C6) ![node](https://img.shields.io/badge/node-%E2%89%A520-339933)

## 启动

```bash
npm install               # 安装 TypeScript 构建与测试依赖
npm start                 # 构建并自动探测空闲端口（默认从 4173 起）
PORT=8080 npm start       # 指定起始端口
```

启动后按提示访问，例如 `http://localhost:4173`。

## 功能

| 类别 | 能力 |
| --- | --- |
| 可视化编辑 | H1–H3、粗斜下删、行内代码 / 代码块、列表、引用、链接、图片、分隔线；撤销重做、快捷键（⌘S/B/I/U/Z）、Tab 缩进 |
| 内容安全 | 服务端 XSS 清洗（剥离脚本/事件属性/危险协议）、粘贴自动清理排版垃圾 |
| 页面管理 | 新建（slug 自动生成并永久绑定）、重命名、删除、侧栏搜索 |
| 主题 | 跟随系统 `prefers-color-scheme` / 手动浅色·深色三态切换，本地记忆，绘制前预置防闪烁 |
| 工程细节 | TypeScript 编译、SPA 回退路由、原子化 JSON 写入、请求日志、移动端抽屉导航、打印样式 |

## 目录结构

```
DocLight/
├── src/
│   ├── server.ts      # 后端：静态资源 + REST API + 端口探测
│   ├── client/app.ts  # 前端单页应用
│   └── tests/         # TypeScript 回归测试
├── data/pages.json    # 文档数据（首启自动生成示例）
└── public/
    ├── index.html     # 应用骨架
    ├── style.css      # 主题变量 + 组件样式
    └── app.js         # TypeScript 编译产物（自动生成）
```

## 开发与测试

```bash
npm run build  # 编译服务端、客户端与测试
npm test       # 编译并运行所有回归测试
```

## REST API

```
GET    /api/tree          空间和页面元信息树
GET    /api/pages         页面元信息列表
GET    /api/pages/:slug   单页详情
POST   /api/pages         新建 {title, space, parent?}
PUT    /api/pages/:slug   更新 {title?, content?, slug?, space?, parent?}
DELETE /api/pages/:slug   删除页面及其子页面
POST   /api/spaces        新建 {title, desc?}
PUT    /api/spaces/:slug  更新 {title?, desc?}
DELETE /api/spaces/:slug  删除空间及其页面
```

> 页面和空间的写操作需要登录。定位：个人 / 小团队本地知识库；多用户权限、协同编辑不在范围内。
