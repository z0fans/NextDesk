<?php

namespace Plugin\NextDeskFilter;

use App\Services\Plugin\AbstractPlugin;
use Illuminate\Http\Request;

class Plugin extends AbstractPlugin
{
    /**
     * Boot the plugin and register hooks.
     *
     * Uses the 'client.subscribe.servers' filter hook to intercept
     * the server list before it's sent to the client.
     *
     * Logic:
     * - If the request comes from NextDesk (detected via User-Agent or flag param),
     *   return all servers including rdp-only tagged nodes.
     * - If the request comes from any other client (Clash Verge, Shadowrocket, etc.),
     *   filter out servers that have the protected tag.
     *
     * Safety:
     * - All errors are caught; on any failure the original $servers is returned
     *   unchanged so the plugin can never break subscription delivery.
     */
    public function boot(): void
    {
        $this->filter('client.subscribe.servers', function (array $servers, $user, Request $request) {
            try {
                return $this->filterServers($servers, $user, $request);
            } catch (\Throwable $e) {
                // Fail-open: any error in this plugin must not break subscription delivery.
                // Log the error and return the original server list unchanged.
                \Log::error('[NextDeskFilter] Filter failed, returning original servers', [
                    'error' => $e->getMessage(),
                    'file' => $e->getFile(),
                    'line' => $e->getLine(),
                    'user_id' => $user->id ?? null,
                ]);
                return $servers;
            }
        });
    }

    /**
     * Core filtering logic. Separated for testability and clear error scope.
     */
    private function filterServers(array $servers, $user, Request $request): array
    {
        $protectedTag = $this->getConfig('protected_tag', 'rdp-only');
        $clientIdentifier = strtolower((string) $this->getConfig('client_identifier', 'nextdesk'));

        // Skip filtering if no protected tag is configured (treat as disabled)
        if (empty($protectedTag) || empty($clientIdentifier)) {
            return $servers;
        }

        // Detect if request comes from NextDesk client.
        // Check both User-Agent header and ?flag= query parameter.
        $userAgent = strtolower($request->header('User-Agent', ''));
        $flag = strtolower((string) $request->input('flag', ''));
        $isNextDesk = str_contains($userAgent, $clientIdentifier)
            || str_contains($flag, $clientIdentifier);

        if ($isNextDesk) {
            // NextDesk client: return all servers unchanged
            \Log::debug('[NextDeskFilter] NextDesk client detected, returning all servers', [
                'user_id' => $user->id ?? null,
                'server_count' => count($servers),
            ]);
            return $servers;
        }

        // Other clients: filter out servers with protected tag
        $filtered = array_values(array_filter($servers, function ($server) use ($protectedTag) {
            $tags = $this->normalizeTags($server['tags'] ?? []);
            return !in_array($protectedTag, $tags, true);
        }));

        \Log::debug('[NextDeskFilter] Non-NextDesk client, filtered protected nodes', [
            'user_id' => $user->id ?? null,
            'total' => count($servers),
            'after_filter' => count($filtered),
            'removed' => count($servers) - count($filtered),
        ]);

        return $filtered;
    }

    /**
     * Normalize the tags field to an array of strings.
     * XBoard tags are typically stored as a JSON array, but defensive handling
     * is needed for legacy data, strings, or null values.
     */
    private function normalizeTags($tags): array
    {
        if (is_array($tags)) {
            return array_map('strval', $tags);
        }
        if (is_string($tags) && $tags !== '') {
            // Handle JSON-encoded string or comma-separated string
            $decoded = json_decode($tags, true);
            if (is_array($decoded)) {
                return array_map('strval', $decoded);
            }
            return array_map('trim', explode(',', $tags));
        }
        return [];
    }
}
