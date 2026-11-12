#!/usr/bin/env dotnet
#:property PublishAot=false

/*markdown
# Inventory Utility

This application validates **inventory** files.

- Run with `dotnet run --file tagged-markdown.cs`
- Supports *JSON* input
- See [the docs](https://learn.microsoft.com/dotnet/core/sdk/file-based-apps)

> Rendering never executes anything: <script>alert('nope')</script>

| Option | Default |
|:-------|--------:|
| strict | true    |

```yaml
mode: validate
```
*/

Console.WriteLine("Inventory utility ready.");
