#:property PublishAot=false

var regular = "/*json\n{ \"not\": \"a real comment\" }\n*/";
var verbatim = @"/*yaml
key: value
*/";
var raw = """
    /*markdown
    # Not a heading
    */
    """;
var name = "world";
var interpolated = $"/*sql {name} */";
var rawInterpolated = $$"""
    /*xml {{name}}
    */
    """;
var slash = '/';
var star = '*';

Console.WriteLine(regular.Length + verbatim.Length + raw.Length + interpolated.Length + rawInterpolated.Length + slash + star);

/*yaml
real: true
*/
