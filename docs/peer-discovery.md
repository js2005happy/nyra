# Agent Card 公开发现（第 3 批 G-P1-4）

不靠线下传码发现并加上一台别人的机器人：对方的 well-known 端点
公开了名片，就能拉到、验签名、记进发现账本，再发好友请求——
对方仍须批准，双向批准的流程一点没绕。

## 发现 ≠ 加好友

```sh
nyra peer discover https://other.example.com
nyra peer discover list
```

- 发现只是“在网上找到一张名片”：拉对方的
  `GET /.well-known/agent-card.json`、验格式、验签名（有签名时）、
  记进发现账本（`~/.nyra/peer-discovery.json`）。
- 发现本身不建好友关系、不发任何请求、不耗对方的 grant。
- 种子地址是机主给的（CLI 参数）：本批不做局域网 mDNS 扫描、
  不做公开爬取——发现范围由机主点名，不静默扫网。

```sh
nyra peer discover https://other.example.com --as pilot [--token <token>]
```

`--as <好友名>` 时同时发好友请求：内部复用 `addFriendRequest`
（不带好友码——码是线下人工比对的路子，发现走的是“名片本身
就是公开信息”的路子）。发完请求后对方仍须在自己那边 accept，
另一边同样走一遍，不绕过批准。

对方的 well-known 端点要求出示 grant token 时，用 `--token` 带上
（只用于这次拉取，不存）。

## 名片签名：更可信，不是准入

名片没签名照样能发现（标 `absent`），签名对不上标 `invalid`
并拒绝记入账本（伪造名片不进发现列表）；TOFU 钉住的钥匙变了
（mismatch）同样拒绝，并报出原因。

签名是“验得过就更可信”，不是准入门槛。准入仍走信任圈 + 双向批准，
签名不替它们做决定。签名本身见下。

## 名片 JWS 签名（G-P1-7）

借 CrewAI 的 AgentCardSigningConfig 的形态（JWS 签名片，私钥走
密码箱，带 kid），只取最小可用的一套：

- 算法只认 ES256（P-256，Node 原生 crypto 就能签验，不引新依赖）。
- 私钥只存密码箱（条目 `peer-card-signing-key`），公钥 JWK 随名片
  一起发；私钥原文绝不进账本、审计与事件。
- 签的是名片指纹（完整 SHA-256）：JWS payload =
  `{ iss, card_hash, iat, exp }`，验签时重算名片哈希比对——
  名片正文被改过一个字就验不过。签名有效期 30 天，过期须对方
  重新签发，不静默续。

```sh
nyra peer card keygen [--yes]              # 生成 P-256 钥匙（已有钥匙时重生成须 --yes）
nyra peer card sign on|off                 # 开 / 关名片 JWS 签名
nyra peer card trust <好友名> [--fp <指纹>]   # 钉住对方名片的签名公钥（TOFU）
nyra peer card verify <好友名>             # 拉对方名片，验钉住的钥匙还对不对得上
```

- 开关在 `config.json` 的 `peer_card.signing`；开时网关发的名片带
  `signature` 与 `public_key`，没钥匙时发素名片，不报错。
- 信任模型是 TOFU（首次见面钉住，像 SSH known_hosts）：第一次拉
  到带签名的名片时把公钥指纹记进好友账本（`card_key_fp`），以后
  再拉必须同一把钥匙，否则拒绝；换钥匙须机主显式重钉
  （`nyra peer card trust <好友名>`）。
- `card verify` 对不上时返回码 1，并报出当前指纹——先别信这张名片，
  确认对方是否换了钥匙再重钉。

## per-peer token（出站）

方向别搞反：

- 入站（别人调我）：对方拿的是我签发的 grant（`nyra peer grant`，
  每 peer 独立、按条吊销）。
- 出站（我调别人）：我拿的是对方签发给我的 token，每 peer 一条，
  存在我自己的密码箱里（条目 `peer-token-<好友名>`），调对方网关
  时当 Bearer 带上。

```sh
nyra peer token set <好友名>        # 交互输入 token，原文只进密码箱
nyra peer token list               # 列出哪些好友存了 token（只列名字，不回原文）
nyra peer token revoke <好友名> --yes   # 吊销一条（只影响这一家）
```

吊销一家不影响别家：token 按 peer 分条存，删一条只影响那一家；
对方吊销我那条时，我这边再调就 401/404，拉名片时当“没拿到名片”
处理，不静默换别的 token 顶上。

## 诚实边界

- 没有真实对方机器人时，用本地假 peer 端点验全流程（假 well-known
  服务 + 假签名名片）：发现、验签、TOFU 钉住、双向批准的流程都验过，
  但那是假 peer；真实对方机器人（另一台真机上的 Nyra）的联调还没做过。
- 发现只认机主给的地址：没有 mDNS、没有公开爬取、没有中心注册表——
  “发现”不是“搜索全网”。
