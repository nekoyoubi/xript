using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class SlotLimitsTests
{
    /// <summary>
    /// Two command slots that disagree with the manifest budget in opposite directions:
    /// one carries its own, one says nothing and inherits.
    /// </summary>
    private static string HostManifest(long manifestTimeoutMs, long slotTimeoutMs) => $$"""
        {
            "xript": "0.8",
            "name": "limits-host",
            "limits": { "timeout_ms": {{manifestTimeoutMs}} },
            "slots": [
                {
                    "id": "bounded.commands",
                    "accepts": ["application/x-xript-command"],
                    "description": "fills here run under the slot's own budget",
                    "multiple": true,
                    "limits": { "timeout_ms": {{slotTimeoutMs}} }
                },
                {
                    "id": "inherited.commands",
                    "accepts": ["application/x-xript-command"],
                    "description": "fills here inherit the manifest budget",
                    "multiple": true
                }
            ]
        }
        """;

    private const string SpinnerMod = """
        {
            "xript": "0.8", "name": "spinner", "version": "1.0.0",
            "entry": { "script": "main.js", "format": "script", "exports": {
                "spin": { "description": "burns wall clock" },
                "quick": { "description": "returns at once" }
            }},
            "fills": {
                "bounded.commands": [
                    { "id": "bounded.spin", "handler": "spin" },
                    { "id": "bounded.quick", "handler": "quick" }
                ],
                "inherited.commands": [{ "id": "inherited.spin", "handler": "spin" }]
            }
        }
        """;

    // `spin` outlasts every budget under test, so whether it returns is decided entirely
    // by the deadline in force.
    private const string SpinnerSource = """
        xript.exports.register('spin', function() {
            var end = Date.now() + 3000;
            while (Date.now() < end) {}
            return 'finished';
        });
        xript.exports.register('quick', function() { return 'quick'; });
        """;

    private static XriptRuntime MakeRuntime(long manifestTimeoutMs, long slotTimeoutMs, long? hardTimeoutMs = null)
    {
        var options = new RuntimeOptions { Capabilities = [] };
        if (hardTimeoutMs is { } hard)
            options.HardLimits = new ExecutionLimits { TimeoutMs = hard };

        var rt = XriptRuntime.Create(HostManifest(manifestTimeoutMs, slotTimeoutMs), options);
        rt.LoadMod(SpinnerMod, new Dictionary<string, string> { ["main.js"] = SpinnerSource });
        return rt;
    }

    [Fact]
    public void A_Slot_Can_Tighten_Below_The_Manifest_Budget()
    {
        using var rt = MakeRuntime(manifestTimeoutMs: 10_000, slotTimeoutMs: 50);

        var error = Assert.Throws<ExecutionLimitException>(() => rt.InvokeCommand("bounded.spin"));
        Assert.Equal("timeout_ms", error.Limit);
    }

    [Fact]
    public void A_Slot_Can_Widen_Past_The_Manifest_Budget()
    {
        using var rt = MakeRuntime(manifestTimeoutMs: 50, slotTimeoutMs: 10_000);

        Assert.Equal("finished", rt.InvokeCommand("bounded.spin").GetString());
    }

    [Fact]
    public void A_Slot_Without_Limits_Inherits_The_Manifest_Budget()
    {
        using var rt = MakeRuntime(manifestTimeoutMs: 50, slotTimeoutMs: 10_000);

        var error = Assert.Throws<ExecutionLimitException>(() => rt.InvokeCommand("inherited.spin"));
        Assert.Equal("timeout_ms", error.Limit);
    }

    [Fact]
    public void The_Embedders_Hard_Ceiling_Still_Clamps_A_Widening_Slot()
    {
        using var rt = MakeRuntime(manifestTimeoutMs: 50, slotTimeoutMs: 10_000, hardTimeoutMs: 100);

        var error = Assert.Throws<ExecutionLimitException>(() => rt.InvokeCommand("bounded.spin"));
        Assert.Equal("timeout_ms", error.Limit);
    }

    [Fact]
    public void A_Tightened_Slot_Does_Not_Disturb_A_Call_That_Fits()
    {
        using var rt = MakeRuntime(manifestTimeoutMs: 10_000, slotTimeoutMs: 50);

        Assert.Equal("quick", rt.InvokeCommand("bounded.quick").GetString());
    }
}
