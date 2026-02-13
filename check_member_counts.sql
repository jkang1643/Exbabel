-- Check member counts per church
SELECT 
    c.id, 
    c.name, 
    COUNT(p.user_id) as member_count,
    c.created_at
FROM churches c 
LEFT JOIN profiles p ON c.id = p.church_id 
GROUP BY c.id, c.name, c.created_at
ORDER BY member_count DESC, c.name 
LIMIT 20;
