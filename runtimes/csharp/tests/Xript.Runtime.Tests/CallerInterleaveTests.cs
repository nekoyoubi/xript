using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// Jint settles a call's promise continuations before the call returns, so two mods' async
/// exports never interleave on this runtime: every continuation is credited to the mod whose
/// call queued it, and a subscription made after an await belongs to that mod.
/// </summary>
public class CallerInterleaveTests
{
    private const string ModSource = """
        xript.exports.register('go', async function (tag) {
            who(tag + ':before');
            await null;
            events.on('note.posted', function () { return tag; });
            who(tag + ':after');
            await null;
            who(tag + ':end');
            return tag;
        });
        """;

    [Fact]
    public void Async_Continuations_Are_Credited_To_Their_Own_Mod()
    {
        var seen = new List<string>();
        var bindings = new HostBindings();
        bindings.AddFunction("who", (HostCallInfo info, JsonElement[] args) =>
        {
            seen.Add($"{args[0].GetString()}={info.ModId}");
            return JsonDocument.Parse("null").RootElement;
        });
        using var rt = XriptRuntime.Create("""
            {
                "xript": "0.10", "name": "interleave-host",
                "bindings": { "who": { "description": "Records the calling mod.", "params": [{ "name": "tag", "type": "string" }] } },
                "events": [{ "id": "note.posted", "description": "A note was posted." }]
            }
            """, new RuntimeOptions { HostBindings = bindings });
        foreach (var name in new[] { "mod-a", "mod-b" })
        {
            rt.LoadMod(
                $$"""{ "xript": "0.10", "name": "{{name}}", "version": "1.0.0", "entry": { "script": "mod.js", "exports": { "go": { "description": "go" } } } }""",
                new Dictionary<string, string> { ["mod.js"] = ModSource });
        }

        rt.InvokeModExport("mod-a", "go", [JsonDocument.Parse("\"a\"").RootElement]);
        rt.InvokeModExport("mod-b", "go", [JsonDocument.Parse("\"b\"").RootElement]);

        Assert.Equal(
            ["a:before=mod-a", "a:after=mod-a", "a:end=mod-a", "b:before=mod-b", "b:after=mod-b", "b:end=mod-b"],
            seen);
        var owners = rt.Execute("JSON.stringify(events.subscribers('note.posted').owners)").Value.GetString();
        Assert.Equal("""[{"owner":"mod-a","count":1},{"owner":"mod-b","count":1}]""", owners);
    }
}
