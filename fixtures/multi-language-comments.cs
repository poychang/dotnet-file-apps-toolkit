#:property PublishAot=false

/*md
## Deployment notes

Uses the `deploy.ps1` script and the XML manifest below.
*/

/*xml
<manifest version="1.0">
  <item id="a" enabled="true" />
</manifest>
*/

/*bash
#!/usr/bin/env bash
dotnet run --file multi-language-comments.cs -- --verbose
*/

/*powershell
Get-ChildItem -Filter *.cs | ForEach-Object { dotnet run --file $_.FullName }
*/

/*csharp
var greeting = $"Hello {name}";
Console.WriteLine(greeting);
*/

/*YML
nested:
  key: value
*/

/*unknownLanguage
This stays an ordinary comment.
*/

Console.WriteLine("Multi-language comments sample.");
