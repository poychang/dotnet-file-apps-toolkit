#:property PublishAot=false

/*yaml
name: inventory-app
environment: production
features:
  - validate
  - export
*/

/*json
{
  "name": "inventory-app",
  "enabled": true,
  "retries": 3
}
*/

/*sql
SELECT name, created_at
FROM users
WHERE active = 1;
*/

Console.WriteLine("Configuration samples live in the comments above.");
