namespace Xript.Runtime;

public class CommonJsDetectedException : Exception
{
    public string Artifact { get; }

    public CommonJsDetectedException(string artifact)
        : base($"CommonJS artifacts detected in mod entry (found: {artifact}). xript mods must be authored as ES modules (entry.format: \"module\", top-level export) or as classic scripts using xript.exports.register — never CommonJS. Fix your tsconfig to emit ESM (module: \"esnext\", moduleResolution: \"bundler\"/\"nodenext\") or remove the require()/module.exports usage. See https://xript.dev/guides/authoring-mods-in-typescript.")
    {
        Artifact = artifact;
    }
}
