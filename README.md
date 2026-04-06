# Minecraft: Legacy Console Edition String Table Compiler

This tool can compile .xml language files from Legacy Console Edition asset folders into a new languages.loc file and a strings.h file.

Example usage:

```
npm i
node index.js build languages.loc --folder "../../MinecraftConsoles/Minecraft.Client/Windows64Media/loc"
```
This will generate a `strings.h` and `languages.loc` file based on the data in those folders.

```
node index.js restore languages.loc strings.h
```
This will generate xml files based on the contents of langauges.loc and strings.h files located in the same directory. The output is "restored" by default

These two functions can be used to turn languages.loc / strings.h into xml (restore), edit the xml, then turn it back into languages.loc / strings.h (build).

### License
The contents of index.js are AI generated and cannot be copyrighted. Use them however you wish, I literally do not care what you do with it. However, the code does work.
The additions in this fork were also fully AI generated.
