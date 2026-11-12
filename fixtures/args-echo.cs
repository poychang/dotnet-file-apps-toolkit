#:property PublishAot=false

// Writes every argument after the first to the file named by the first argument, one per line.
File.WriteAllLines(args[0], args[1..]);
