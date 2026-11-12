#:property PublishAot=false

/** C# documentation-style comment. It is never rendered by the toolkit. */
/* This is just a normal comment. */
/*
markdown
The tag must directly follow the opening delimiter, so this is ordinary text.
*/
/* markdown
A space before the tag also keeps this an ordinary comment.
*/
/*markdownExtra
Unknown tags are ignored.
*/
/*yaml key: value */
// /*yaml
// key: value
// */

Console.WriteLine("Only ordinary comments here.");
