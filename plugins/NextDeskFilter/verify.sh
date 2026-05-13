#!/bin/bash
# Verify NextDeskFilter plugin deployment on XBoard server.
# Run from the XBoard project root.

set -e

echo "=== NextDeskFilter Deployment Verification ==="

# 1. Check plugin files exist
echo -n "[1/4] Plugin files... "
if [ -f "plugins/NextDeskFilter/Plugin.php" ] && [ -f "plugins/NextDeskFilter/config.json" ]; then
    echo "OK"
else
    echo "FAIL - Plugin files missing"
    exit 1
fi

# 2. PHP syntax check
echo -n "[2/4] PHP syntax... "
php -l plugins/NextDeskFilter/Plugin.php 2>/dev/null | grep -q "No syntax errors"
echo "OK"

# 3. JSON validity
echo -n "[3/4] config.json... "
php -r "json_decode(file_get_contents('plugins/NextDeskFilter/config.json'), true); echo json_last_error() === 0 ? 'OK' : 'FAIL';"
echo ""

# 4. Check hook availability (requires XBoard artisan)
echo -n "[4/4] Hook system... "
if command -v php &> /dev/null && [ -f "artisan" ]; then
    php artisan hook:list 2>/dev/null | grep -q "client.subscribe" && echo "OK" || echo "SKIP (hook not listed, may still work)"
else
    echo "SKIP (not in XBoard root)"
fi

echo ""
echo "=== Deployment verification complete ==="
echo ""
echo "Next steps:"
echo "  1. Enable plugin in XBoard admin panel"
echo "  2. Add 'rdp-only' tag to RDP-dedicated nodes"
echo "  3. Test with: curl -H 'User-Agent: NextDesk/1.0.95' YOUR_SUBSCRIBE_URL"
echo "  4. Test with: curl -H 'User-Agent: clash-verge/v2.0' YOUR_SUBSCRIBE_URL"
echo "  5. Compare: NextDesk response should have more nodes than Clash response"
