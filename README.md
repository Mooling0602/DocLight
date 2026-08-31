# DocLight ✦ 轻量可视化文档站

简洁优雅、现代感的自托管文档站：**浏览器里直接所见即所得排版**，深浅色主题自动跟随系统。

![tech](https://img.shields.io/badge/依赖-0%20个-5457cf) ![node](https://img.shields.io/badge/node-%E2%89%A514-blue)

## 启动

```bash
node server.js            # 自动探测空闲端口（默认从 4173 起）
PORT=8080 node server.js  # 指定起始端口
```

启动后按提示访问，例如 `http://localhost:4173`。

## 功能

| 类别 | 能力 |
| --- | --- |
| 可视化编辑 | H1–H3、粗斜下删、行内代码 / 代码块、列表、引用、链接、图片、分隔线；撤销重做、快捷键（⌘S/B/I/U/Z）、Tab 缩进 |
| 内容安全 | 服务端 XSS 清洗（剥离脚本/事件属性/危险协议）、粘贴自动清理排版垃圾 |
| 页面管理 | 新建（slug 自动生成并永久绑定）、重命名、删除、侧栏搜索 |
| 主题 | 跟随系统 `prefers-color-scheme` / 手动浅色·深色三态切换，本地记忆，绘制前预置防闪烁 |
| 工程细节 | 零依赖单文件后端、SPA 回退路由、原子化 JSON 写入、请求日志、移动端抽屉导航、打印样式 |

## 目录结构

```
docsite/
├── server.js          # 后端：静态资源 + REST API + 端口探测
├── data/pages.json    # 文档数据（首启自动生成示例）
└── public/
    ├── index.html     # 应用骨架
    ├── style.css      # 主题变量 + 组件样式
    └── app.js         # 编辑器 / 路由 / 交互逻辑
```

## REST API

```
GET    /api/pages         页面元信息列表
GET    /api/pages/:slug   单页详情
POST   /api/pages         新建 {title}
PUT    /api/pages/:slug   更新 {title?, content?}
DELETE /api/pages/:slug   删除
```

> 定位：个人 / 小团队本地知识库。多用户权限、协同编辑不在范围内。
