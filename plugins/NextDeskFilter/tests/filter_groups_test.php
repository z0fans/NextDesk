<?php

namespace App\Services\Plugin {
    abstract class AbstractPlugin
    {
        protected array $config = [];

        public function setTestConfig(array $config): void
        {
            $this->config = $config;
        }

        public function getConfig(string $key, $default = null)
        {
            return $this->config[$key] ?? $default;
        }
    }
}

namespace App\Models {
    class ServerGroup
    {
        public static function where(string $field, string $value): ServerGroupQuery
        {
            return new ServerGroupQuery($field, $value);
        }
    }

    class ServerGroupQuery
    {
        public function __construct(private string $field, private string $value)
        {
        }

        public function value(string $column): ?int
        {
            if ($this->field === 'name' && $this->value === 'rdp-only' && $column === 'id') {
                return 11;
            }

            return null;
        }
    }
}

namespace {
    function storage_path(string $path): string
    {
        return sys_get_temp_dir() . '/' . $path;
    }

    require_once __DIR__ . '/../Plugin.php';

    final class FakeRequest
    {
        public function __construct(private string $userAgent, private array $input = [])
        {
        }

        public function header(string $key, string $default = ''): string
        {
            return strtolower($key) === 'user-agent' ? $this->userAgent : $default;
        }

        public function input(string $key, string $default = ''): string
        {
            return $this->input[$key] ?? $default;
        }
    }

    function assertSameValue($expected, $actual, string $message): void
    {
        if ($expected !== $actual) {
            fwrite(STDERR, "{$message}\nExpected: " . var_export($expected, true) . "\nActual: " . var_export($actual, true) . "\n");
            exit(1);
        }
    }

    $plugin = new \Plugin\NextdeskFilter\Plugin();
    $plugin->setTestConfig([
        'protected_tag' => 'rdp-only',
        'client_identifier' => 'nextdesk',
    ]);

    $servers = [
        ['id' => 201, 'name' => 'Public', 'tags' => [], 'group_ids' => ['1']],
        ['id' => 203, 'name' => 'RDP 01', 'tags' => [], 'group_ids' => ['1', '11']],
        ['id' => 204, 'name' => 'RDP 02', 'tags' => [], 'group_ids' => ['11']],
    ];
    $user = (object) ['id' => 1];

    $nextdesk = $plugin->filterProtectedNodes($servers, $user, new FakeRequest('NextDesk/1.0.95'));
    assertSameValue([203, 204], array_column($nextdesk, 'id'), 'NextDesk should receive protected group nodes.');

    $marked = $plugin->appendNextDeskSubscriptionMarker($nextdesk, new FakeRequest('NextDesk/1.0.95'));
    assertSameValue(
        '__nextdesk_subscription_issuer_librascloud',
        $marked[2]['name'],
        'NextDesk subscriptions should include authorization marker proxy.'
    );

    $regular = $plugin->filterProtectedNodes($servers, $user, new FakeRequest('clash-verge/v2.0.0'));
    assertSameValue([201], array_column($regular, 'id'), 'Regular clients should not receive protected group nodes.');

    fwrite(STDOUT, "filter_groups_test passed\n");
}
