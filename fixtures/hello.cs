#:property PublishAot=false

Console.WriteLine("Hello from a .NET file-based app!");

if (args.Length > 0)
{
    Console.WriteLine($"Arguments: {string.Join(", ", args)}");
}
