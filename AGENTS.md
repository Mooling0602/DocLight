# 项目协作规范（AGENTS.md）

> AGENTS.md file use the language which the maintainer uses.

## 语言规范

- 项目说明、协作沟通和普通文档使用中文。
- Git 提交信息使用英文，并遵循语义化提交规范，例如 `feat: add page search`、`fix: handle missing page data`。
- 文档注释和 docstring 使用英文。

## Git 分支说明

- main 分支受到保护（但保护有限，需要注意不要用 gh CLI 操作该分支），严禁强制推送到此分支。
- vibe 分支是工作分支，通常与 AI Agent 协作提交代码，并向 main 分支提交 PR。每次 PR 完成后，进行一次强制覆盖同步（origin/main -> origin/vibe -> vibe）
- github-web-edits 是项目维护者使用 GitHub 网页编辑器进行小的修改的分支，通常提交 PR 到 main 分支并直接变基合并，或审查后进行 merge 提交合并。
- feature/xxx 是临时分支，一般在开发专门的功能需求时使用，完成后应先提交 PR 到 vibe 分支进行后续处理，PR 关闭后分支将直接删除。

## Git 提交尾注

可选的，AI Agents 可以在提交信息尾部添加协作签名：

```plaintext
Co-Authored-By: Tool Name <tool-provider@domain.com>
```

这将会将 Agent 工具加入到签名信息和贡献者列表中。请注意在添加前获得用户同意（但也不必反复询问），并避免填入错误的信息。只有在确认自己身份的情况下，才添加此尾注。如果已使用了 GitHub Bot 身份进行提交和其他操作，则不添加此尾注。

作为参考，下面是一些常用工具的标准尾注格式。如果不确定或者和记忆、全局规范发生了冲突，可以先询问用户。

### 作为 DeepSeek Harness 提交

```plaintext
Co-Authored-By: DeepSeek Harness <service@deepseek.com>
```

### 作为 Qoder 提交

```plaintext
Co-Authored-By: Qoder <contact@qoder.com>
```

### 作为 Claude Code 提交

```plaintext
Co-Authored-By: Claude Code <noreply@anthropic.com>
```

### 其他

接受外部 PR，厂商或者任何人可以推荐模板到此部分中。

## Git 同步

项目以 main 为默认分支和同步基准，每轮工作完成后，在确认 PR 已成功合并并关闭的情况下，可以从 origin/main 覆盖到其他分支，以便同步 Git 历史并开展新工作。
