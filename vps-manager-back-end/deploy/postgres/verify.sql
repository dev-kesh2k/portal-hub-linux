SELECT 'users' AS entity, COUNT(*)::int AS total FROM users
UNION ALL
SELECT 'user_permissions', COUNT(*)::int FROM user_permissions
UNION ALL
SELECT 'servers', COUNT(*)::int FROM servers
UNION ALL
SELECT 'websites', COUNT(*)::int FROM websites
UNION ALL
SELECT 'hub_settings', COUNT(*)::int FROM hub_settings
ORDER BY 1;

SELECT id, username, role FROM users ORDER BY username;
SELECT id, name, type FROM servers;
SELECT id, name, url FROM websites ORDER BY name;
SELECT key, value FROM hub_settings ORDER BY key;
