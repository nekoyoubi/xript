using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class NestedNamespaceTests
{
    private const string TwoLevelManifest = """
        {
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "app": {
                    "description": "app namespace",
                    "members": {
                        "brick": {
                            "description": "brick namespace",
                            "members": {
                                "list": { "description": "lists bricks" }
                            }
                        }
                    }
                }
            }
        }
        """;

    private const string ThreeLevelManifest = """
        {
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "a": {
                    "description": "a",
                    "members": {
                        "b": {
                            "description": "b",
                            "members": {
                                "c": {
                                    "description": "c",
                                    "members": {
                                        "deep": { "description": "deep fn" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        """;

    [Fact]
    public void Nested_Namespace_Function_Resolves()
    {
        var bindings = new HostBindings();
        bindings.AddNestedNamespace("app", new Dictionary<string, HostNamespaceMember>
        {
            ["brick"] = HostNamespaceMember.Nested(new Dictionary<string, HostNamespaceMember>
            {
                ["list"] = HostNamespaceMember.Fn(_ => JsonDocument.Parse("[\"a\",\"b\"]").RootElement.Clone())
            })
        });

        using var rt = XriptRuntime.Create(TwoLevelManifest, new RuntimeOptions { HostBindings = bindings });

        var result = rt.Execute("app.brick.list().length");
        Assert.Equal(2, result.Value.GetInt64());
    }

    [Fact]
    public void Nested_Namespace_Is_Deep_Frozen()
    {
        var bindings = new HostBindings();
        bindings.AddNestedNamespace("app", new Dictionary<string, HostNamespaceMember>
        {
            ["brick"] = HostNamespaceMember.Nested(new Dictionary<string, HostNamespaceMember>
            {
                ["list"] = HostNamespaceMember.Fn(_ => JsonDocument.Parse("[]").RootElement.Clone())
            })
        });

        using var rt = XriptRuntime.Create(TwoLevelManifest, new RuntimeOptions { HostBindings = bindings });

        Assert.True(rt.Execute("Object.isFrozen(app)").Value.GetBoolean());
        Assert.True(rt.Execute("Object.isFrozen(app.brick)").Value.GetBoolean());
    }

    [Fact]
    public void Arbitrary_Depth_Recursion_Works()
    {
        var bindings = new HostBindings();
        bindings.AddNestedNamespace("a", new Dictionary<string, HostNamespaceMember>
        {
            ["b"] = HostNamespaceMember.Nested(new Dictionary<string, HostNamespaceMember>
            {
                ["c"] = HostNamespaceMember.Nested(new Dictionary<string, HostNamespaceMember>
                {
                    ["deep"] = HostNamespaceMember.Fn(_ => JsonDocument.Parse("42").RootElement.Clone())
                })
            })
        });

        using var rt = XriptRuntime.Create(ThreeLevelManifest, new RuntimeOptions { HostBindings = bindings });

        var result = rt.Execute("a.b.c.deep()");
        Assert.Equal(42, result.Value.GetInt64());
    }

    [Fact]
    public void Capability_Gates_At_Leaf_Function()
    {
        const string gated = """
            {
                "xript": "0.1",
                "name": "test",
                "bindings": {
                    "ns": {
                        "description": "ns",
                        "members": {
                            "sub": {
                                "description": "sub",
                                "members": {
                                    "danger": { "description": "danger", "capability": "perm" }
                                }
                            }
                        }
                    }
                },
                "capabilities": { "perm": { "description": "permission" } }
            }
            """;

        var bindings = new HostBindings();
        bindings.AddNestedNamespace("ns", new Dictionary<string, HostNamespaceMember>
        {
            ["sub"] = HostNamespaceMember.Nested(new Dictionary<string, HostNamespaceMember>
            {
                ["danger"] = HostNamespaceMember.Fn(_ => JsonDocument.Parse("1").RootElement.Clone())
            })
        });

        using var rt = XriptRuntime.Create(gated, new RuntimeOptions { HostBindings = bindings });

        var result = rt.Execute("try { ns.sub.danger(); 'ok' } catch(e) { e.message }");
        Assert.Contains("requires the", result.Value.GetString());
    }

    [Fact]
    public void Flat_Namespace_Still_Works()
    {
        var bindings = new HostBindings();
        bindings.AddNamespace("player", new Dictionary<string, HostFunction>
        {
            ["getName"] = _ => JsonDocument.Parse("\"Hero\"").RootElement.Clone()
        });

        using var rt = XriptRuntime.Create("""
            {
                "xript": "0.1",
                "name": "test",
                "bindings": {
                    "player": {
                        "description": "player",
                        "members": { "getName": { "description": "name" } }
                    }
                }
            }
            """, new RuntimeOptions { HostBindings = bindings });

        Assert.Equal("Hero", rt.Execute("player.getName()").Value.GetString());
    }
}
