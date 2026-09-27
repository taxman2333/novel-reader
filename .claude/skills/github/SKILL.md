---
name: github
description: 将本地项目通过 Git 同步到 GitHub。当用户要求提交代码、上传到 GitHub、检查敏感信息、检查 .gitignore、或配置远程仓库时使用。只处理 Git 与 GitHub 同步，不改动项目功能代码。
---

# /github — 同步到 GitHub

把当前本地项目通过 Git 同步到 GitHub。

## 职责边界

**本 Skill 只处理 Git 和 GitHub 同步。**

- **不要**在此修改项目功能代码
- **不要**因为要上传而顺便重构代码
- **不要**删除 Git 历史
- **不要**强制覆盖远程历史

---

## 第一步：检查 Git 状态

```bash
git rev-parse --is-inside-work-tree   # 是否已是 Git 仓库，否则先 git init
git branch --show-current
git status
git log --oneline -10
git remote -v
git branch -vv                        # 远程分支跟踪状态
```

明确：当前分支、工作区是否干净、有无未提交修改、最近提交、当前 remote、远程跟踪状态。

---

## 第二步：检查敏感信息

在提交和上传前检查项目中是否可能包含：

- API Key、Token、Password、Secret
- 私钥、证书
- 数据库密码
- `.env` 中的敏感配置
- 本地个人路径（如包含用户名的主目录路径）
- 个人隐私数据
- **小说正文或其他不应上传的数据**

**不要仅仅依赖文件名判断是否敏感**——要实际查看内容。

参考命令：

```bash
git status --porcelain=v1 --untracked-files=all
git diff --cached --name-status
```

对将提交的文件检查可疑模式（注意排除 `node_modules`、`dist`、`.git`）：

```bash
grep -rniE "(api[_-]?key|secret|passw(or)?d|token|private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY|ghp_|gho_|github_pat_|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,})" \
  --include="*.js" --include="*.mjs" --include="*.json" --include="*.md" --include="*.html" --include="*.css" \
  . --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git
```

**如果发现明显敏感信息**：

1. **不得提交**
2. **不得 push**
3. 提示用户处理
4. 必要时检查 `.gitignore`

---

## 第三步：检查 .gitignore

确保常见本地文件不会被错误上传。根据项目实际情况检查：

- `node_modules/`
- `dist/`、`build/`
- `.env`、`.env.*`
- 日志文件
- IDE 配置
- 系统临时文件
- 本地数据库文件
- 测试产生的大型临时文件

```bash
git check-ignore -v <路径>
```

**不要无脑覆盖已有 `.gitignore`。** 如果已有规则，**先理解后再修改**。

本项目的 `.gitignore` 已覆盖上述类别，`.claude/` 未被忽略（Skills 应当纳入版本控制）。

---

## 第四步：检查 GitHub Remote

```bash
git remote -v
```

- **如果已存在 GitHub remote**：使用现有 remote，**不要擅自修改 remote URL**。
  本项目 `origin` 已指向 `https://github.com/taxman2333/novel-reader`（Private）。
- **如果不存在 remote**：检查 GitHub CLI 是否安装并登录：

  ```bash
  gh auth status
  ```

  若可用，可用 `gh repo create` 创建仓库。创建时：

  - 优先使用当前项目名称作为仓库名
  - **默认倾向创建 private 仓库**
  - **如需创建 public 仓库，必须明确提醒用户**
  - **不要把包含个人隐私、密钥或敏感信息的项目创建为 public**

  如果 `gh` 不可用，不要假定命令一定可用，报告情况并等待用户处理。

---

## 第五步：准备提交

```bash
git status
git diff
git diff --stat
```

理解本次**实际**有哪些变化。**不要把与当前项目无关的文件一起提交。**

---

## 第六步：生成 Git Commit

根据实际修改内容生成清晰的 commit message，优先使用前缀：

| 前缀 | 用途 |
|---|---|
| `feat:` | 新功能 |
| `fix:` | 问题修复 |
| `refactor:` | 重构 |
| `docs:` | 文档 |
| `style:` | 样式/格式 |
| `test:` | 测试 |
| `chore:` | 构建、依赖、杂项 |

示例：

```
feat: add chapter navigation
fix: restore reading progress correctly
docs: update project roadmap
```

**不要生成无意义的提交信息**，例如 `update`、`modify`、`test`、`change`。

---

## 第七步：提交

确认需要提交的文件后，**逐个指定文件**：

```bash
git add <相关文件>
git commit -m "<合适的提交信息>"
```

**禁止 `git add .`**，除非确认当前工作区所有未提交内容都属于本次提交。

---

## 第八步：同步 GitHub

如果已存在 remote，根据当前分支：

```bash
git push
# 必要时
git push -u origin <branch>
```

如果项目尚未建立 GitHub 仓库且 `gh` 已登录，可使用类似：

```bash
gh repo create <repo-name> --source=. --private --push
```

**但必须根据当前环境实际情况决定，不要假定命令一定可用。**

### 本项目环境注意

本机 **`github.com:443` 被阻断**（`api.github.com` 可直连），因此 `gh` 命令正常但 `git push` 可能失败，报错形如 `Connection was reset` 或 `Failed to connect to github.com port 443`。

**遇到这类报错时，不要先去排查 GitHub 权限问题**——先确认本机代理是否可用：

```bash
netstat -ano -p tcp | grep LISTENING | grep -E ':(7890|7897|10809|1080)\b'
```

代理可用时，仓库级配置（当前已设置）：

```bash
git config --local http.proxy http://127.0.0.1:7890
```

**只在仓库级配置，不要修改全局 git 配置。**

---

## 第九步：Push 前检查

再次确认：

- 没有敏感信息
- `.gitignore` 正常
- 当前提交内容符合项目预期
- remote 地址正确
- 当前分支正确
- **如果是 public repository，明确告诉用户**

---

## 第十步：完成后报告

- GitHub 仓库地址
- 当前分支
- 本次 commit（hash 与信息）
- 本次上传了哪些主要内容
- 是否成功 push
- 当前 Git 状态
- **如果存在未上传或未提交的内容，明确列出**

---

## 重要规则

**禁止默认使用**：

```bash
git push --force
git reset --hard
git clean -fd
```

除非用户**明确要求**。

如果远程仓库与本地历史发生冲突，**不要自行强制覆盖**，先分析冲突原因并告诉用户。
