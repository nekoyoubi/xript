using Xript.Runtime;
using Xript.Runtime.Tests.Helpers;

namespace Xript.Runtime.Tests;

/// <summary>
/// The in-sandbox fragment API end to end: what a mod calls, and what a host receives once
/// the command buffer is finalized.
/// </summary>
public class FragmentOpApiTests
{
    private static FragmentOp[] Fire(XriptRuntime rt, string body)
    {
        rt.Execute($"hooks.fragment.update('probe', function(bindings, fragment) {{ {body} }});");
        return rt.FireFragmentHook("probe", "update");
    }

    [Fact]
    public void A_String_List_Stays_A_List()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var ops = Fire(rt, """fragment.replaceChildren(".list", ["<li onclick='x()'>a</li>", "<li>b</li>"]);""");

        var op = Assert.Single(ops);
        var list = Assert.IsType<PropValue.Arr>(op.Value);
        Assert.Equal(["<li>a</li>", "<li>b</li>"], list.Items.Select(PropValue.Stringify));
    }

    [Fact]
    public void An_Empty_List_Is_An_Explicit_Clear()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var ops = Fire(rt, """fragment.replaceChildren(".list", []);""");

        Assert.Empty(Assert.IsType<PropValue.Arr>(Assert.Single(ops).Value).Items);
    }

    [Fact]
    public void RemoveAttr_Is_The_Inverse_Of_SetAttr()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var op = Assert.Single(Fire(rt, """fragment.removeAttr("#go", "disabled");"""));

        Assert.Equal("removeAttr", op.Op);
        Assert.Equal("disabled", op.Prop);
        Assert.Equal("disabled", op.Attr);
        Assert.Null(op.Value);
    }

    [Fact]
    public void SetAttr_False_Or_Null_Finalizes_As_RemoveAttr()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var ops = Fire(rt, """
            fragment.setAttr("#go", "disabled", false);
            fragment.setAttr("#go", "title", null);
            fragment.setAttr("#go", "aria-pressed", "false");
            """);

        Assert.Equal(["removeAttr", "removeAttr", "setAttr"], ops.Select(op => op.Op));
        Assert.Equal("false", PropValue.Stringify(ops[2].Value!));
    }

    [Fact]
    public void A_Truthy_Toggle_Condition_Is_Strict_True()
    {
        using var rt = XriptRuntime.Create(TestManifests.Minimal);
        var op = Assert.Single(Fire(rt, """fragment.toggle("#warn", 1);"""));

        Assert.Equal(PropValue.True, op.Value);
    }

    [Fact]
    public void A_NonPrimitive_SetAttr_Value_Is_Refused_With_A_Diagnostic()
    {
        var diagnostics = new List<FragmentDiagnosticEvent>();
        using var rt = XriptRuntime.Create(TestManifests.Minimal, new RuntimeOptions
        {
            OnFragmentDiagnostic = diagnostics.Add,
        });
        var ops = Fire(rt, """
            fragment.setAttr("#go", "title", { label: "x" });
            fragment.setAttr("#go", "title", ["a", "b"]);
            """);

        Assert.Empty(ops);
        Assert.Equal(2, diagnostics.Count);
        Assert.Equal(DiagnosticCodes.OpInvalidValue, diagnostics[0].Diagnostic.Code);
        Assert.Equal("#go", diagnostics[0].Diagnostic.Node);
        Assert.Equal("title", diagnostics[0].Diagnostic.Prop);
    }
}
