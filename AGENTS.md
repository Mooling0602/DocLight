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
