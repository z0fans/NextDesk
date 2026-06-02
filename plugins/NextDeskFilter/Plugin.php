<?php

namespace Plugin\NextdeskFilter;

use App\Models\ServerGroup;
use App\Services\Plugin\AbstractPlugin;

class Plugin extends AbstractPlugin
{
    private array $protectedGroupIdCache = [];

    private function debugLog(string $msg): void
    {
        $logFile = storage_path('logs/nextdesk_filter_debug.log');
        $dir = dirname($logFile);
        if (!is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        $ts = date('Y-m-d H:i:s');
        file_put_contents($logFile, "[{$ts}] {$msg}\n", FILE_APPEND);
    }

    public function boot(): void
    {
        // Force Clash Meta format for NextDesk clients
        // This hook fires BEFORE protocol/format selection in ClientController
        $this->listen('client.subscribe.before', [$this, 'forceClashFormat']);

        // Filter rdp-only nodes for non-NextDesk clients
        $this->filter('client.subscribe.servers', [$this, 'filterProtectedNodes'], 25);

        // Add a marker proxy after protocol compatibility filtering. NextDesk
        // requires this marker and removes it before saving the runtime config.
        $this->filter('protocol.servers.filtered', [$this, 'appendNextDeskSubscriptionMarker'], 100);
    }

    /**
     * Force XBoard to use Clash Meta format when NextDesk client is detected.
     * XBoard selects output format based on request 'flag' input or User-Agent.
     * Since NextDesk UA is not recognized, we inject 'flag=meta' into the request.
     */
    public function forceClashFormat(): void
    {
        try {
            $request = request();
            $userAgent = strtolower($request->header('User-Agent', ''));
            $clientIdentifier = strtolower((string) $this->getConfig('client_identifier', 'nextdesk'));

            if (empty($clientIdentifier)) {
                return;
            }

            if (str_contains($userAgent, $clientIdentifier)) {
                // Merge 'flag=meta' into request input so XBoard routes to ClashMeta protocol
                $request->merge(['flag' => 'meta']);
                $this->debugLog("Forced Clash Meta format for NextDesk client, UA={$userAgent}");
            }
        } catch (\Throwable $e) {
            // Fail-open: never break subscription delivery
            $this->debugLog("ERROR in forceClashFormat: {$e->getMessage()}");
        }
    }

    public function filterProtectedNodes(array $servers, $user, $request): array
    {
        try {
            $protectedMarker = trim((string) $this->getConfig('protected_tag', 'rdp-only'));
            $clientIdentifier = strtolower((string) $this->getConfig('client_identifier', 'nextdesk'));

            // Skip filtering if not configured
            if (empty($protectedMarker) || empty($clientIdentifier)) {
                return $servers;
            }

            // Detect if request comes from NextDesk client
            $userAgent = strtolower($request->header('User-Agent', ''));
            $flag = strtolower((string) $request->input('flag', ''));
            $isNextDesk = str_contains($userAgent, $clientIdentifier)
                || str_contains($flag, $clientIdentifier);

            if ($isNextDesk) {
                // NextDesk client: ONLY return servers with protected marker
                $filtered = array_values(array_filter($servers, function ($server) use ($protectedMarker) {
                    return $this->serverHasProtectedMarker($server, $protectedMarker);
                }));
                $count = count($filtered);
                $this->debugLog("NextDesk client detected, user={$user->id}, returning only {$count} {$protectedMarker} servers");
                return $filtered;
            }

            // Other clients: filter out servers with protected marker
            $filtered = array_values(array_filter($servers, function ($server) use ($protectedMarker) {
                return !$this->serverHasProtectedMarker($server, $protectedMarker);
            }));

            $removed = count($servers) - count($filtered);
            if ($removed > 0) {
                $this->debugLog("Filtered {$removed} {$protectedMarker} nodes for non-NextDesk client, user={$user->id}");
            }

            return $filtered;
        } catch (\Throwable $e) {
            $this->debugLog("ERROR: {$e->getMessage()} at {$e->getFile()}:{$e->getLine()}");
            return $servers;
        }
    }

    public function appendNextDeskSubscriptionMarker(array $servers, $request = null): array
    {
        try {
            $request = $request ?? (function_exists('request') ? request() : null);
            if (!$this->isNextDeskRequest($request)) {
                return $servers;
            }

            foreach ($servers as $server) {
                if (($server['name'] ?? '') === '__nextdesk_subscription_issuer_librascloud') {
                    return $servers;
                }
            }

            $servers[] = [
                'id' => '__nextdesk_subscription_marker',
                'name' => '__nextdesk_subscription_issuer_librascloud',
                'type' => 'http',
                'host' => '127.0.0.1',
                'port' => 9,
                'password' => 'nextdesk',
                'protocol_settings' => [],
            ];
        } catch (\Throwable $e) {
            $this->debugLog("ERROR in appendNextDeskSubscriptionMarker: {$e->getMessage()}");
        }

        return $servers;
    }

    private function isNextDeskRequest($request): bool
    {
        if (!$request) {
            return false;
        }

        $clientIdentifier = strtolower((string) $this->getConfig('client_identifier', 'nextdesk'));
        if (empty($clientIdentifier)) {
            return false;
        }

        $userAgent = strtolower($request->header('User-Agent', ''));
        $flag = strtolower((string) $request->input('flag', ''));

        return str_contains($userAgent, $clientIdentifier)
            || str_contains($flag, $clientIdentifier);
    }

    private function serverHasProtectedMarker(array $server, string $protectedMarker): bool
    {
        $tags = $this->normalizeTags($server['tags'] ?? []);
        if (in_array($protectedMarker, $tags, true)) {
            return true;
        }

        $groupNames = $this->normalizeGroupNames($server['groups'] ?? []);
        if (in_array($protectedMarker, $groupNames, true)) {
            return true;
        }

        $groupIds = $this->normalizeGroupIds($server['group_ids'] ?? []);
        if (empty($groupIds)) {
            return false;
        }

        $protectedGroupIds = $this->resolveProtectedGroupIds($protectedMarker);
        return count(array_intersect($groupIds, $protectedGroupIds)) > 0;
    }

    private function resolveProtectedGroupIds(string $protectedMarker): array
    {
        if (isset($this->protectedGroupIdCache[$protectedMarker])) {
            return $this->protectedGroupIdCache[$protectedMarker];
        }

        $ids = [];
        if (is_numeric($protectedMarker)) {
            $ids[] = (string) $protectedMarker;
        }

        try {
            if (class_exists(ServerGroup::class)) {
                $id = ServerGroup::where('name', $protectedMarker)->value('id');
                if ($id !== null) {
                    $ids[] = (string) $id;
                }
            }
        } catch (\Throwable $e) {
            $this->debugLog("WARN: failed to resolve protected group '{$protectedMarker}': {$e->getMessage()}");
        }

        $this->protectedGroupIdCache[$protectedMarker] = array_values(array_unique($ids));
        return $this->protectedGroupIdCache[$protectedMarker];
    }

    private function normalizeGroupIds($groupIds): array
    {
        if (is_string($groupIds)) {
            $decoded = json_decode($groupIds, true);
            if (json_last_error() === JSON_ERROR_NONE) {
                return $this->normalizeGroupIds($decoded);
            }
            return array_values(array_filter(array_map('trim', explode(',', $groupIds)), 'strlen'));
        }

        if (!is_array($groupIds)) {
            return [];
        }

        $normalized = [];
        foreach ($groupIds as $groupId) {
            if (is_string($groupId) || is_numeric($groupId)) {
                $normalized[] = trim((string) $groupId);
            }
        }

        return array_values(array_unique(array_filter($normalized, 'strlen')));
    }

    private function normalizeGroupNames($groups): array
    {
        if (!is_array($groups)) {
            return [];
        }

        $normalized = [];
        foreach ($groups as $group) {
            if (is_string($group) || is_numeric($group)) {
                $normalized[] = trim((string) $group);
                continue;
            }
            if (is_array($group) && isset($group['name']) && (is_string($group['name']) || is_numeric($group['name']))) {
                $normalized[] = trim((string) $group['name']);
            }
        }

        return array_values(array_unique(array_filter($normalized, 'strlen')));
    }

    private function normalizeTags($tags): array
    {
        if (is_string($tags)) {
            $decoded = json_decode($tags, true);
            if (json_last_error() === JSON_ERROR_NONE) {
                return $this->normalizeTags($decoded);
            }
            return array_values(array_filter(array_map('trim', explode(',', $tags)), 'strlen'));
        }

        if (!is_array($tags)) {
            return [];
        }

        $normalized = [];
        foreach ($tags as $tag) {
            if (is_string($tag) || is_numeric($tag)) {
                $normalized[] = trim((string) $tag);
                continue;
            }
            if (is_array($tag)) {
                foreach (['name', 'tag', 'label', 'value'] as $key) {
                    if (isset($tag[$key]) && (is_string($tag[$key]) || is_numeric($tag[$key]))) {
                        $normalized[] = trim((string) $tag[$key]);
                        break;
                    }
                }
            }
        }

        return array_values(array_unique(array_filter($normalized, 'strlen')));
    }
}
