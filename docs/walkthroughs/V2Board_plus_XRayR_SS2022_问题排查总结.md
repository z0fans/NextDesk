# V2Board + XRayR SS2022 问题排查总结

## 起因

XRayR 日志中频繁出现：
```
rejected common/drain: unable to drain connection > EOF > proxy/shadowsocks: failed to read 50 bytes > EOF
```

---

## 排查结果：三个独立问题

### ✅ 问题 1：V2rayNG.php 缺失 SS2022 密钥生成（已修复）

**影响**：使用 V2rayNG 客户端的用户拿到的密码是裸 UUID，而 XRayR 期望 `serverKey:userKey` 格式 → 100% 认证失败

**修复**：在 `buildShadowsocks` 中添加 `2022-blake3-*` 密钥生成逻辑

```diff
+ if (str_starts_with($server['cipher'], '2022-blake3-')) {
+     $length = ($server['cipher'] === '2022-blake3-aes-128-gcm') ? 16 : 32;
+     $serverKey = Helper::getServerKey($server['created_at'], $length);
+     $userKey = Helper::uuidToBase64($password, $length);
+     $password = "{$serverKey}:{$userKey}";
+ }
```

> 文件：[V2rayNG.php](file:///Users/yuu/Downloads/vibe_coding/v2board/v2board-master/app/Http/Controllers/Client/Protocols/V2rayNG.php)

---

### ✅ 问题 2：Shadowsocks.php 白名单不含 SS2022（已修复）

**影响**：原生 Shadowsocks 客户端（SIP008 协议）的订阅中完全看不到 SS2022 节点

**修复**：
1. 加密白名单增加 `2022-blake3-aes-128-gcm`、`2022-blake3-aes-256-gcm`、`2022-blake3-chacha20-poly1305`
2. `SIP008` 方法中添加 SS2022 的 `serverKey:userKey` 密钥生成

> 文件：[Shadowsocks.php](file:///Users/yuu/Downloads/vibe_coding/v2board/v2board-master/app/Http/Controllers/Client/Protocols/Shadowsocks.php)

---

### ℹ️ 问题 3：EOF 日志噪音（无需处理）

**结论**：`failed to read 50 bytes > EOF` **不是 Bug，不影响真实用户**

**根因**：Xray-core 的多用户 Shadowsocks 需要读取 50 字节来识别用户身份。公网扫描器/探测器连上 TCP 后没发完 50 字节就断开，触发此日志。

**来源溯源**：
- 来自 SS2022 端口（21002-21020），不是普通 SS
- Xray-core 作者确认：*"it is caused by the multi-user feature"* ([Issue #625](https://github.com/XTLS/Xray-core/issues/625))
- Xray 官方声明不再修复旧 SS 的此类问题，SS2022 改进了密钥安全但底层机制相同

**降噪方法**：`/etc/XrayR/config.yml` 中设置 `Log.Level: warning`

---

## 涉及的服务器

| 服务器 | IP | 面板 |
|---|---|---|
| 落地 1 | `103.219.195.160` | nodes.999850.xyz + api.961881.xyz |
| 落地 2 | `45.11.1.14` | nodes.999850.xyz |

## 其他已确认无问题的协议文件

ClashVerge、ClashMeta、Shadowrocket、Surge 等协议处理器均已正确实现 SS2022 密钥生成。
