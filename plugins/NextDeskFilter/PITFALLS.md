# NextDeskFilter 开发踩坑记录

> 本文档记录开发和部署此 XBoard 插件过程中遇到的问题及解决方案，供后续开发参考。

---

## 问题 1：PHP 语法错误导致面板完全卡死

### 症状
- 插件上传后，点"启用"、"升级"、"卸载"均无响应
- 所有用户的订阅下发报错
- Laravel 日志中无任何错误记录（Octane 环境下语法错误不写日志）

### 根因
Plugin.php 第 39 行使用了非法的字符串插值赋值语法：

```php
// ❌ 错误 — 字符串插值中不能赋值
$this->debugLog("returning all {$count = count($servers)} servers");

// ✅ 正确 — 先赋值再插值
$count = count($servers);
$this->debugLog("returning all {$count} servers");
```

### 为什么面板也卡死
XBoard 在执行插件管理操作（启用/卸载/升级）时会尝试 `require` 插件文件。如果文件有语法错误，PHP 直接 fatal error，整个请求挂掉。

### 修复方式
1. 在服务器上直接覆盖修复 Plugin.php
2. 或手动删除插件目录 + `php artisan octane:reload`

### 预防措施
**上传前必须执行：**
```bash
php -l Plugin.php
```
确认 `No syntax errors detected` 后再打包上传。

---

## 问题 2：目录名大小写不匹配

### 症状
- 插件上传后 namespace autoload 失败
- 类找不到，订阅报错

### 根因
XBoard 根据 `config.json` 中的 `code` 字段自动生成目录名：
- `code: "nextdesk_filter"` → 目录名 `NextdeskFilter`（把 `nextdesk` 当作一个词）
- 而我们的 namespace 写的是 `Plugin\NextDeskFilter`（大写 D）

**PHP namespace 必须和目录名完全一致（区分大小写）。**

### 修复
```php
// ❌ 错误
namespace Plugin\NextDeskFilter;

// ✅ 正确（匹配 XBoard 生成的目录名）
namespace Plugin\NextdeskFilter;
```

### 预防措施
- 先上传一次，用 `ls plugins/` 确认 XBoard 生成的实际目录名
- namespace 必须和目录名字母完全一致

---

## 问题 3：闭包 vs 方法引用（Octane/Swoole 兼容性）

### 症状
不确定是否直接导致了问题，但参考同服务器上正常运行的 PremiumEntry 插件，它使用方法引用而非闭包。

### 最佳实践
```php
// ❌ 避免 — 闭包在 Octane 环境下可能有序列化问题
$this->filter('hook.name', function (array $servers, $user, $request) {
    // ...
});

// ✅ 推荐 — 和 PremiumEntry 保持一致
$this->filter('hook.name', [$this, 'methodName'], 25);
```

### 原因
Octane 会在 worker 之间复用应用实例。闭包捕获的 `$this` 引用在某些情况下可能导致状态泄漏或序列化失败。使用 `[$this, 'method']` 格式更安全。

---

## 问题 4：日志不写入 Laravel 日志

### 症状
插件报错但 `storage/logs/laravel-*.log` 中无记录。

### 根因
XBoard 使用 Octane (Swoole) 运行。在 Swoole worker 中：
- `\Log::error()` 可能不会写入文件（取决于 Octane 配置）
- PHP fatal error（如语法错误）直接终止 worker，不经过 Laravel 异常处理

### 解决方案
使用 `file_put_contents` 直接写文件（和 PremiumEntry 一致）：

```php
private function debugLog(string $msg): void
{
    $logFile = storage_path('logs/nextdesk_filter_debug.log');
    $ts = date('Y-m-d H:i:s');
    file_put_contents($logFile, "[{$ts}] {$msg}\n", FILE_APPEND);
}
```

---

## 问题 5：Octane 缓存旧代码

### 症状
- 删除/替换了插件文件，但行为没变
- 旧的报错持续出现

### 根因
Octane 把 PHP 代码加载到内存中，文件变更不会自动生效。

### 修复
```bash
php artisan octane:reload
```

如果 reload 无效，强制重启：
```bash
php artisan octane:stop
php artisan octane:start --host=127.0.0.1 --port=9501 &
```

---

## 调试 Checklist

开发 XBoard 插件时，按此顺序排查问题：

1. **`php -l Plugin.php`** — 语法检查（最常见问题）
2. **`php -r "require 'Plugin.php';"`** — 能否被 PHP 加载
3. **`ls plugins/`** — 确认目录名和 namespace 大小写一致
4. **`cat storage/logs/nextdesk_filter_debug.log`** — 查看插件自己的日志
5. **`php artisan octane:reload`** — 确保新代码生效
6. **`php artisan tinker --execute="..."`** — 查看数据库中插件状态

### 快速诊断命令

```bash
# 一键检查插件健康状态
php -r "require '/www/wwwroot/libras/plugins/NextdeskFilter/Plugin.php';" 2>&1 && echo "OK" || echo "SYNTAX ERROR"

# 查看数据库中的插件记录
php artisan tinker --execute="echo json_encode(\DB::table('v2_plugins')->where('code','nextdesk_filter')->first(), JSON_PRETTY_PRINT);"

# 查看插件调试日志
tail -20 /www/wwwroot/libras/storage/logs/nextdesk_filter_debug.log
```

---

## 版本历史

| 版本 | 问题 | 修复 |
|:---|:---|:---|
| 1.0.0 | 闭包注册 + `\Log` facade + Request 类型声明 | 初版，导致报错 |
| 1.0.1 | 改为方法引用 + file_put_contents 日志 | 但 namespace 大小写错误 |
| 1.0.2 | namespace 改为 `NextdeskFilter` | 但有语法错误（字符串插值赋值） |
| 1.0.3 | 修复语法错误 | ✅ 正确版本 |
