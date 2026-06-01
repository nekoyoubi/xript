using Jint;
using Jint.Runtime.Modules;

namespace Xript.Runtime;

internal sealed class DenyExternalModuleLoader : IModuleLoader
{
    private readonly HashSet<string> _allowed = [];

    internal void Allow(string specifier) => _allowed.Add(specifier);

    internal void Disallow(string specifier) => _allowed.Remove(specifier);

    public ResolvedSpecifier Resolve(string? referencingModuleLocation, ModuleRequest moduleRequest)
    {
        if (_allowed.Contains(moduleRequest.Specifier))
            return new ResolvedSpecifier(moduleRequest, moduleRequest.Specifier, null, SpecifierType.Bare);

        throw new ImportDeniedException(moduleRequest.Specifier);
    }

    public Module LoadModule(Engine engine, ResolvedSpecifier resolved) =>
        throw new ImportDeniedException(resolved.Key);
}
