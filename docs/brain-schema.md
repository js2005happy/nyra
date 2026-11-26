# 脑文件夹 Schema（H10）

`~/.nyra` 的结构契约：`src/assets/brain-schema.json.txt`（版本化，当前 v1）。

## 口径

- 只核对顶层一层（文件/目录、是否必需、权限位），不递归子目录。
- 缺必需文件、类型不对、权限位不对 → `nyra doctor` 的“脑文件夹结构”一项失败。
- 未登记的条目只上报、不判失败：`nyra doctor` 会列出来（最多 10 个，其余只计数），不影响通过。

## 加文件 / 删文件时

新功能往 `~/.nyra` 加文件或目录时，先更新 `src/assets/brain-schema.json.txt`（加一条 `entries`），再让 doctor 通过；删条目同理。权限位在 schema 文件里写成 `"0600"` 这样的八进制字符串（JSON 里没有八进制字面量），加载时解析成数字；只在代码确实强制该权限位的地方填 `mode`（目前只有 `vault.json` 与 `keys.json` 的 0600）。

## 迁移时

下次迁移 `~/.nyra` 结构（例如升级）时，先验 schema 再动手：跑 `nyra doctor`，看“脑文件夹结构”一项；迁移后重跑一次，确认没有新增的未登记条目被漏掉。

## 校验入口

- `src/brainSchema.ts`：`loadBrainSchema()`（读内置 schema，形状不对直接抛错）与 `validateBrainSchema(home)`（返回 `{ schemaVersion, ok, checked, issues, unknown }`）。
- `nyra doctor`：自动跑这一项，不用单独命令。
- 测试：`tests/node/test-brain-schema.test.ts`（缺必需、类型错、权限错、未登记不失败、doctor 联动）。

## 局限

- v1 只核对顶层一层：子目录里的文件（例如 `sessions/` 下的会话文件）不在 schema 里，坏了靠各自模块自己的校验。
- 未登记条目不判失败是故意的（新功能不至于把 doctor 打红），代价是 schema 可能滞后：定期跑 `nyra doctor` 看未登记列表，及时补登记。
