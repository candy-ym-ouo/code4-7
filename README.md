# 手工艺材料追踪器

面向染布、木工、陶艺和金工爱好者的真实库存与项目材料追踪系统。

系统记录材料来源、批次、颜色变化、剩余数量、项目计划用料和实际消耗。前端使用 Vue 3，后端使用 Node.js + Fastify，业务数据保存在 PostgreSQL。项目不提供演示模式，不预置虚假材料、项目或统计数字。

## 已实现能力

- 首次初始化（首位管理员）、多操作员登录、角色管理和密码修改。
- 来源与存放位置管理。
- 材料档案、工艺类型、单位、低库存阈值和颜色档案。
- 批次入库、来源追溯、有效期和库存流水。
- 库存调整、差异阈值、双人复核暂存、自动耗尽、归档和并发余额保护。
- 项目、材料需求、计划与实际消耗对比。
- 消耗、损耗、撤销和反向库存流水。
- 颜色变化时间线和批次当前颜色。
- 材料、批次、来源、颜色、库存状态和位置搜索筛选。
- 受保护图片附件。
- CSV、完整工作区 JSON 导出。
- 仪表盘、审计日志和健康检查。
- PostgreSQL 数据持久化和本地附件文件存储。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Web | Vue 3、TypeScript、Vite、Pinia、Vue Router、Element Plus |
| API | Node.js 22、TypeScript、Fastify、Zod |
| 数据库 | PostgreSQL 16、SQL migrations、不可变库存流水 |
| 鉴权 | Argon2id、HttpOnly 会话 Cookie |
| 测试 | Vitest、API smoke test、生产构建检查 |

## 目录

```text
origin/
├── apps/
│   ├── api/                 Node.js API、SQL migrations、测试
│   └── web/                 Vue 3 前端
├── packages/
│   └── contracts/           前后端共享枚举、校验和单位换算
├── ops/
│   ├── healthcheck.sh
│   └── smoke-test.mjs
├── docs/
│   └── api.md
└── .env.example
```

## 本地开发

要求：

- Node.js 22+ 和 pnpm 10。
- PostgreSQL 16。

```bash
cd origin
pnpm install
cp .env.example .env
# 将 DATABASE_URL 指向可用的 PostgreSQL 16，并设置 SESSION_SECRET
pnpm db:migrate
pnpm dev
```

开发地址：

- Web：`http://localhost:5173`
- API：`http://localhost:3000`

`.env` 会被 API 自动加载，Web 的 Vite 代理会把 `/api` 转发到本地 API。首次打开会进入初始化页面并创建首位管理员；之后由管理员在「操作员管理」中创建其他操作员账号，不提供公开注册。超阈值结余调整需要至少两名启用的操作员才能完成双人复核。

## 测试与构建

```bash
pnpm typecheck
pnpm test
pnpm build
```

对已初始化的运行环境执行完整 API 验收链：

```bash
SMOKE_BASE_URL=http://127.0.0.1:8080 \
SMOKE_LOGIN_NAME='admin' \
SMOKE_PASSWORD='你的管理员密码' \
SMOKE_REVIEW_PASSWORD='复核员初始密码（至少10位，设置后额外验证双人复核）' \
node ops/smoke-test.mjs
```

验收脚本会真实创建来源、材料、批次、项目、需求、消耗和颜色变化，验证余额从 1000g 降到 500g、撤销后恢复 1000g、最新流水为 `REVERSAL`、颜色和搜索正确。设置 `SMOKE_REVIEW_PASSWORD` 时还会创建第二位操作员，验证超阈值调整暂存、申请人不能自批、拒绝不动余额、他人批准后余额 1000g 变 800g，以及重复批准幂等不重复增减余额。

建议只在专用验收数据库执行该脚本，因为它会留下测试业务数据。

## 业务一致性

- 批次是库存的最小核算单位，材料列表只做聚合。
- 创建批次和首条 `OPENING` 流水在同一事务完成。
- 消耗、调整和撤销都在事务中锁定批次。
- 批次余额绝不允许小于 0。
- 消耗记录保存实际使用量和损耗量，总扣减量等于两者之和。
- 撤销不删除历史，而是新增 `REVERSAL` 流水。
- 调整差异阈值为 `|调整数量| / 调整前结余`（`ADJUSTMENT_REVIEW_THRESHOLD_RATIO`，
  默认 0.1；调整前结余为 0 时一律需复核）。阈值内直接入账；超阈值只写入
  `adjustment_requests` 暂存单（`PENDING`），不改余额。
- 超阈值调整必须由非申请人的另一位操作员复核；批准、余额更新和库存流水写入
  在同一事务提交，拒绝只关闭单据不动余额。
- 调整单状态机（`PENDING → APPROVED/REJECTED/CANCELED`）配合调整单行锁与
  流水 `adjustment_request_id` 唯一索引保证重复批准幂等，绝不重复增减余额。
- 颜色变化更新当前颜色快照，但不自动修改库存。
- 计划用料不扣库存，实际消耗才扣库存。
- 数量使用 PostgreSQL `numeric(18,6)`，API 使用十进制字符串。
- 归档代替核心数据硬删除。
- 审计日志只追加，不更新、不删除。

## 文档

- [API 文档](docs/api.md)

## 数据安全

- 修改 `.env.example` 中的默认数据库密码。
- 使用 `openssl rand -hex 32` 生成 `SESSION_SECRET`。
- 生产环境设置 `COOKIE_SECURE=true` 并使用 HTTPS。
- 定期备份 PostgreSQL 数据库和 `UPLOAD_DIR` 附件目录，并验证备份可恢复。
- 不要将 `.env`、备份文件或上传目录提交到版本控制。
