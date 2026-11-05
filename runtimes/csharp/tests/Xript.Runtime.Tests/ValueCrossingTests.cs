using System.Text.Json;
using System.Text.Json.Nodes;
using Jint.Runtime;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// Value crossing rules on every path a value takes between script and host: binding arguments
/// and results, callbacks, hook and event payloads and results, export arguments and results,
/// and retained callbacks.
/// </summary>
public class ValueCrossingTests
{
    private const string Manifest = """
        {
          "xript": "0.10",
          "name": "value-crossing",
          "bindings": {
            "value": { "description": "Returns the host value." },
            "echo": { "description": "Returns its arguments as an array." },
            "keep": { "description": "Retains a callback.", "params": [{ "name": "fn", "type": "function", "retain": true }] },
            "p": {
              "description": "Callback probes.",
              "members": {
                "call": { "description": "Calls fn with the remaining arguments and returns what it returned.", "params": [{ "name": "fn", "type": "function" }] }
              }
            }
          },
          "hooks": { "probe": { "description": "Reports its payload." } },
          "events": [{ "id": "probed", "description": "Reports its payload." }]
        }
        """;

    private const string Measure = "function (v) { var d = 0; while (Array.isArray(v)) { v = v[0]; d++; } return d; }";

    private sealed class Host
    {
        internal JsonElement[] Received = [];
        internal JsonElement Value = Json("null");
        internal JsonElement? CallbackResult;
        internal RetainedCallback? Kept;
    }

    private static (XriptRuntime Runtime, Host Host) Create(bool fidelity)
    {
        var host = new Host();
        var bindings = new HostBindings();
        bindings.AddFunction("value", _ => host.Value);
        bindings.AddFunction("echo", args =>
        {
            host.Received = args;
            return ArrayOf(args);
        });
        bindings.AddFunction("keep", args =>
        {
            host.Kept = XriptCallback.From(args[0])!.Retain();
            return Json("null");
        });
        bindings.AddNamespace("p", new Dictionary<string, HostFunction>
        {
            ["call"] = args =>
            {
                var result = XriptCallback.From(args[0])!.Invoke(args[1..]);
                host.CallbackResult = result;
                return result;
            },
        });
        var runtime = XriptRuntime.Create(Manifest, new RuntimeOptions { HostBindings = bindings, ValueFidelity = fidelity });
        return (runtime, host);
    }

    private static JsonElement Json(string text) =>
        JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = XriptValue.MaxDepth + 10 }).RootElement.Clone();

    private static JsonElement ArrayOf(JsonElement[] items) =>
        Json("[" + string.Join(",", items.Select(item => item.GetRawText())) + "]");

    private static string Raw(JsonElement[] items) => ArrayOf(items).GetRawText();

    private static void SameJson(string expected, JsonElement actual) =>
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(expected), JsonNode.Parse(actual.GetRawText())), $"got {actual.GetRawText()}");

    private static string Run(XriptRuntime rt, string script) => rt.Execute(script).Value.GetString()!;

    private static string Nested(int levels) => new string('[', levels) + "1" + new string(']', levels);

    private static string NestedScript(int levels) => $"(function () {{ var v = 1; for (var i = 0; i < {levels}; i++) v = [v]; return v; }})()";

    private static int DepthOf(JsonElement value)
    {
        var depth = 0;
        while (value.ValueKind == JsonValueKind.Array)
        {
            value = value[0];
            depth++;
        }
        return depth;
    }

    [Fact]
    public void BigInts_Cross_As_Markers_With_Fidelity()
    {
        var (rt, host) = Create(fidelity: true);
        using var _ = rt;
        rt.Execute("echo(10n, -5n, Object(7n), { n: [12345678901234567890n] })");
        Assert.Equal(
            """[{"$xript":"bigint","value":"10"},{"$xript":"bigint","value":"-5"},{"$xript":"bigint","value":"7"},{"n":[{"$xript":"bigint","value":"12345678901234567890"}]}]""",
            Raw(host.Received));
        Assert.True(XriptValue.TryGetBigInt(host.Received[1], out var negative) && negative == -5);
        SameJson("""{"$xript":"bigint","value":"-3"}""", rt.Execute("-3n").Value);

        host.Value = Json("""{ "big": {"$xript":"bigint","value":"-42"}, "list": [{"$xript":"bigint","value":"0"}] }""");
        Assert.Equal("bigint|true|true", Run(rt, "(function () { var v = value(); return [typeof v.big, v.big === -42n, v.list[0] === 0n].join('|'); })()"));
        Assert.Equal("true", Run(rt, "String(echo(2n ** 70n)[0] === 2n ** 70n)"));

        rt.Execute("p.call(function () { return { n: 9n }; })");
        SameJson("""{"n":{"$xript":"bigint","value":"9"}}""", host.CallbackResult!.Value);

        rt.Execute("hooks.probe(function (n) { return typeof n + ':' + (n + 1n); })");
        Assert.Equal("bigint:8", rt.FireHook("probe", new FireHookOptions { Data = XriptValue.BigInt(7) })[0].GetString());
    }

    [Fact]
    public void BigInts_Without_Fidelity_Fail_Loudly_Naming_The_Binding()
    {
        var (rt, host) = Create(fidelity: false);
        using var _ = rt;
        Assert.Equal(
            "BindingError|echo|echo(): a BigInt cannot cross to the host without value fidelity",
            Run(rt, "(function () { try { echo({ n: 1n }); return 'crossed'; } catch (e) { return [e.name, e.binding, e.message].join('|'); } })()"));
        Assert.Equal("BindingError", Run(rt, "(function () { try { echo(Object(1n)); } catch (e) { return e.name; } })()"));

        var result = Assert.Throws<ValueCrossingException>(() => rt.Execute("[1n]"));
        Assert.StartsWith("execute(): ", result.Message);
        Assert.Equal("execute", result.Binding);

        Assert.Equal(
            "p.call(): a BigInt cannot cross to the host without value fidelity",
            Run(rt, "(function () { try { p.call(function () { return 1n; }); } catch (e) { return e.message; } })()"));

        host.Value = Json("""{"$xript":"bigint","value":"1"}""");
        Assert.Equal("object|bigint", Run(rt, "(function () { var v = value(); return typeof v + '|' + v['$xript']; })()"));
    }

    [Fact]
    public void Symbols_Cross_As_Markers_Only_As_Whole_Values()
    {
        var (rt, host) = Create(fidelity: true);
        using var _ = rt;
        SameJson("""{"$xript":"symbol","description":"r"}""", rt.Execute("Symbol('r')").Value);
        SameJson("""{"k":1}""", rt.Execute("({ s: Symbol('r'), k: 1 })").Value);
        rt.Execute("p.call(function () { return Symbol(); })");
        SameJson("""{"$xript":"symbol"}""", host.CallbackResult!.Value);
        rt.Execute("events.on('probed', function () { return Symbol('e'); }); hooks.probe(function () { return Symbol('h'); })");
        SameJson("""{"$xript":"symbol","description":"e"}""", rt.Emit("probed")[0]);
        SameJson("""{"$xript":"symbol","description":"h"}""", rt.FireHook("probe")[0]);

        rt.Execute("echo(Symbol('x'), Symbol(), Symbol(''), { s: Symbol('y'), k: 1 }, [Symbol('z')])");
        Assert.Equal(
            """[{"$xript":"symbol","description":"x"},{"$xript":"symbol"},{"$xript":"symbol","description":""},{"k":1},[null]]""",
            Raw(host.Received));
        Assert.True(XriptValue.TryGetSymbol(host.Received[1], out var none) && none is null);

        host.Value = Json("""[{"$xript":"symbol","description":"d"}, {"$xript":"symbol"}, {"$xript":"symbol","description":"d"}]""");
        Assert.Equal(
            "symbol|d|undefined|false",
            Run(rt, "(function () { var v = value(); return [typeof v[0], v[0].description, String(v[1].description), v[0] === v[2]].join('|'); })()"));
        Assert.Equal("true", Run(rt, "(function () { var s = Symbol('t'); var r = echo(s)[0]; return String(typeof r === 'symbol' && r.description === 't' && r !== s); })()"));
    }

    [Fact]
    public void Symbols_Without_Fidelity_Stay_Null()
    {
        var (rt, host) = Create(fidelity: false);
        using var _ = rt;
        rt.Execute("echo(Symbol('x'), { s: Symbol('y') }, [Symbol()])");
        Assert.Equal("""[null,{},[null]]""", Raw(host.Received));
        Assert.Equal(JsonValueKind.Null, rt.Execute("Symbol('r')").Value.ValueKind);
        host.Value = Json("""{"$xript":"symbol"}""");
        Assert.Equal("object", Run(rt, "typeof value()"));
    }

    [Fact]
    public void Lone_Surrogates_Cross_Intact_With_Fidelity()
    {
        var (rt, host) = Create(fidelity: true);
        using var _ = rt;
        rt.Execute("echo('a\\uD800b', { k: '\\uDC00' }, '\\uD83D\\uDE00')");
        Assert.Equal(
            """[{"$xript":"string","units":[97,55296,98]},{"k":{"$xript":"string","units":[56320]}}]""",
            Raw(host.Received[..2]));
        Assert.Equal("😀", host.Received[2].GetString());
        Assert.True(XriptValue.TryGetString(host.Received[0], out var text) && text == "a\uD800b");
        SameJson("""{"$xript":"string","units":[56319]}""", rt.Execute("'\\uDBFF'").Value);
        Assert.Equal("3|55296|true", Run(rt, "(function () { var r = echo('a\\uD800b')[0]; return [r.length, r.charCodeAt(1), r === 'a\\uD800b'].join('|'); })()"));

        host.Value = Json("""[{"$xript":"string","units":[55296]}, "\uD800"]""");
        Assert.Equal("55296|55296", Run(rt, "(function () { var v = value(); return v[0].charCodeAt(0) + '|' + v[1].charCodeAt(0); })()"));
        Assert.True(XriptValue.TryGetString(XriptValue.String("a\uD800"), out var roundTrip) && roundTrip == "a\uD800");
        Assert.Equal(JsonValueKind.String, XriptValue.String("plain").ValueKind);
    }

    [Fact]
    public void Lone_Surrogates_Without_Fidelity_Become_Replacement_Characters()
    {
        var (rt, host) = Create(fidelity: false);
        using var _ = rt;
        rt.Execute("echo('a\\uD800b', { k: '\\uDC00' })");
        Assert.Equal("a�b", host.Received[0].GetString());
        Assert.Equal("�", host.Received[1].GetProperty("k").GetString());
        Assert.Equal("�", rt.Execute("'\\uDBFF'").Value.GetString());
        Assert.Equal("�", rt.Execute("({ v: '\\uDBFF' })").Value.GetProperty("v").GetString());
        rt.Execute("echo({ ['k\\uD800']: 1 })");
        Assert.True(host.Received[0].TryGetProperty("k�", out var replaced) && replaced.GetInt32() == 1);
    }

    [Fact]
    public void Cycles_Cross_As_Back_References_With_Fidelity()
    {
        var (rt, host) = Create(fidelity: true);
        using var _ = rt;
        rt.Execute("var o = { n: 1 }; o.self = o; o.list = [o]; echo(o)");
        Assert.Equal("""[{"n":1,"self":{"$xript":"cycle","up":1},"list":[{"$xript":"cycle","up":2}]}]""", Raw(host.Received));
        Assert.True(XriptValue.TryGetCycle(host.Received[0].GetProperty("self"), out var up) && up == 1);

        rt.Execute("var s = { k: 1 }; echo({ a: s, b: s, c: [s, s] })");
        Assert.Equal("""[{"a":{"k":1},"b":{"k":1},"c":[{"k":1},{"k":1}]}]""", Raw(host.Received));

        Assert.Equal("true|true|1", Run(rt, "(function () { var o = { n: 1 }; o.self = o; o.list = [o]; var r = echo(o)[0]; return [r.self === r, r.list[0] === r, r.n].join('|'); })()"));
        SameJson("""{"a":[{"$xript":"cycle","up":2}]}""", rt.Execute("(function () { var o = { a: [] }; o.a.push(o); return o; })()").Value);

        host.Value = Json("""{ "a": { "self": {"$xript":"cycle","up":1} }, "b": [{"$xript":"cycle","up":2}], "c": {"$xript":"cycle","up":0}, "d": {"$xript":"cycle","up":9}, "e": {"$xript":"cycle","up":1.5} }""");
        Assert.Equal(
            "true|true|object|object|object",
            Run(rt, "(function () { var v = value(); return [v.a.self === v.a, v.b[0] === v, typeof v.c, typeof v.d, typeof v.e].join('|'); })()"));
    }

    [Fact]
    public void Cycles_Without_Fidelity_Fail_Loudly_Naming_The_Binding()
    {
        var (rt, _) = Create(fidelity: false);
        using var __ = rt;
        Assert.Equal(
            "BindingError|echo(): a cyclic value cannot cross to the host without value fidelity",
            Run(rt, "(function () { var o = {}; o.o = o; try { echo(o); return 'crossed'; } catch (e) { return e.name + '|' + e.message; } })()"));
        Assert.StartsWith("execute(): ", Assert.Throws<ValueCrossingException>(() => rt.Execute("var c = []; c.push(c); c")).Message);
        Assert.Equal(
            "BindingError|p.call(): a cyclic value cannot cross to the host without value fidelity",
            Run(rt, "(function () { try { p.call(function () { var o = {}; o.o = o; return o; }); } catch (e) { return e.name + '|' + e.message; } })()"));

        rt.Execute("hooks.probe(function () { var o = {}; o.o = o; return o; })");
        Assert.StartsWith("hooks.probe(): ", Assert.Throws<ValueCrossingException>(() => rt.FireHook("probe")).Message);
        rt.Execute("events.on('probed', function () { var o = {}; o.o = o; return o; })");
        Assert.StartsWith("events.emit(): ", Assert.Throws<ValueCrossingException>(() => rt.Emit("probed")).Message);
        Assert.Equal("""{"a":{"k":1},"b":{"k":1}}""", rt.Execute("var s = { k: 1 }; ({ a: s, b: s })").Value.GetRawText());
    }

    [Fact]
    public void Malformed_Markers_Are_Plain_Data()
    {
        var (rt, host) = Create(fidelity: true);
        using var _ = rt;
        host.Value = Json("""
            [
                {"$xript":"bigint"},
                {"$xript":"bigint","value":"1","x":1},
                {"$xript":"bigint","value":"1.5"},
                {"$xript":"bigint","value":1},
                {"$xript":"symbol","description":1},
                {"$xript":"string","units":[70000]},
                {"$xript":"cycle"},
                {"$xript":"NaN","value":"1"}
            ]
            """);
        Assert.Equal("object,object,object,object,object,object,object,object", Run(rt, "value().map(function (v) { return typeof v; }).join(',')"));
    }

    [Theory]
    [InlineData(true, """[{"$xript":"NaN"},{"$xript":"-0"},{"$xript":"Infinity"},"s",false,{"d":[{"$xript":"-Infinity"}]}]""")]
    [InlineData(false, """[null,0,null,"s",false,{"d":[null]}]""")]
    public void Wrapper_Objects_Unwrap_At_Every_Depth(bool fidelity, string expected)
    {
        var (rt, host) = Create(fidelity);
        using var _ = rt;
        const string values = "new Number(NaN), new Number(-0), new Number(Infinity), new String('s'), new Boolean(false), { d: [new Number(-Infinity)] }";
        rt.Execute($"echo({values})");
        Assert.Equal(expected, Raw(host.Received));
        Assert.Equal(expected, rt.Execute($"[{values}]").Value.GetRawText());
        rt.Execute($"p.call(function () {{ return [{values}]; }})");
        Assert.Equal(expected, host.CallbackResult!.Value.GetRawText());
    }

    [Fact]
    public void To_Json_Applies_Like_Json_Stringify_And_A_Throwing_One_Is_Skipped()
    {
        var (rt, host) = Create(fidelity: true);
        using var _ = rt;
        Assert.Equal("""{"d":"key:d","l":["key:0"]}""", rt.Execute("({ d: { toJSON: function (k) { return 'key:' + k; } }, l: [{ toJSON: function (k) { return 'key:' + k; } }] })").Value.GetRawText());
        Assert.Equal("""{"a":1,"b":[{"c":2}]}""", rt.Execute("({ toJSON: function () { throw new Error('no'); }, a: 1, b: [{ toJSON: function () { throw 'no'; }, c: 2 }] })").Value.GetRawText());
        Assert.Equal("ok", Run(rt, "(function () { echo({ toJSON: function () { throw new Error('no'); }, a: 1 }); return 'ok'; })()"));
        Assert.Equal(1, host.Received[0].GetProperty("a").GetInt32());
        Assert.Equal("\"1970-01-01T00:00:00.000Z\"", rt.Execute("({ t: new Date(0) })").Value.GetProperty("t").GetRawText());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void A_Throwing_Getter_Fails_The_Call_With_Its_Own_Error(bool fidelity)
    {
        var (rt, _) = Create(fidelity);
        using var __ = rt;
        const string topLevel = "({ get g() { throw new RangeError('gx'); } })";
        const string nested = "({ a: [{ ok: 1 }, { get g() { throw new RangeError('gx'); } }] })";
        foreach (var value in new[] { topLevel, nested })
        {
            Assert.Equal("true|gx", Run(rt, $"(function () {{ try {{ echo({value}); return 'crossed'; }} catch (e) {{ return (e instanceof RangeError) + '|' + e.message; }} }})()"));
            Assert.Equal("true|gx", Run(rt, $"(function () {{ try {{ p.call(function () {{ return {value}; }}); return 'crossed'; }} catch (e) {{ return (e instanceof RangeError) + '|' + e.message; }} }})()"));
            var thrown = Assert.Throws<JavaScriptException>(() => rt.Execute(value));
            Assert.Equal("gx", thrown.Message);
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void A_Revoked_Proxy_Fails_The_Call_With_The_Engines_Type_Error(bool fidelity)
    {
        var (rt, host) = Create(fidelity);
        using var __ = rt;
        rt.Execute("function revoked() { var r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; }");
        foreach (var value in new[] { "revoked()", "{ a: [1, revoked()] }", "[revoked()]" })
        {
            host.Received = [];
            Assert.Equal("true", Run(rt, $"(function () {{ try {{ echo({value}); return 'crossed'; }} catch (e) {{ return String(e instanceof TypeError); }} }})()"));
            Assert.Empty(host.Received);
            Assert.Equal("true", Run(rt, $"(function () {{ try {{ p.call(function () {{ return {value}; }}); return 'crossed'; }} catch (e) {{ return String(e instanceof TypeError); }} }})()"));
            var thrown = Assert.Throws<JavaScriptException>(() => rt.Execute($"({value})"));
            Assert.Equal("TypeError", ((Jint.Native.Object.ObjectInstance)thrown.Error).Get("name").ToString());
        }
    }

    [Fact]
    public void A_Callback_Return_Carries_BigInts_And_Symbols()
    {
        var (rt, host) = Create(fidelity: true);
        using var __ = rt;
        rt.Execute("p.call(function () { return -4n; })");
        SameJson("""{"$xript":"bigint","value":"-4"}""", host.CallbackResult!.Value);
        rt.Execute("p.call(function () { return { list: [1n, { n: Object(2n) }] }; })");
        SameJson("""{"list":[{"$xript":"bigint","value":"1"},{"n":{"$xript":"bigint","value":"2"}}]}""", host.CallbackResult!.Value);
        rt.Execute("p.call(function () { return Symbol('c'); })");
        SameJson("""{"$xript":"symbol","description":"c"}""", host.CallbackResult!.Value);
        Assert.Equal("bigint|symbol", Run(rt, "(function () { var a = p.call(function () { return 3n; }); var b = p.call(function () { return Symbol('s'); }); return typeof a + '|' + typeof b; })()"));
    }

    [Theory]
    [InlineData("42", "42", null)]
    [InlineData("null", "null", null)]
    [InlineData("undefined", "undefined", null)]
    [InlineData("'boom'", "boom", null)]
    [InlineData("{ message: 'plain' }", "plain", null)]
    [InlineData("{ valueOf: 5 }", "callback threw", null)]
    [InlineData("{ toString: function () { return 's'; } }", "callback threw", null)]
    [InlineData("new TypeError('typed')", "typed", "TypeError")]
    [InlineData("new Error()", "", "Error")]
    [InlineData("{ message: 5 }", "5", null)]
    [InlineData("{ message: null }", "callback threw", null)]
    [InlineData("true", "true", null)]
    [InlineData("(function () { var f = function () {}; f.toString = function () { return 'fn'; }; return f; })()", "fn", null)]
    public void A_Thrown_Value_Reaches_The_Host_With_The_Javascript_Message(string thrown, string message, string? name)
    {
        CallbackException? caught = null;
        var bindings = new HostBindings();
        bindings.AddFunction("call", args =>
        {
            caught = Assert.Throws<CallbackException>(() => XriptCallback.From(args[0])!.Invoke());
            return Json("null");
        });
        using var rt = XriptRuntime.Create(
            """{ "xript": "0.10", "name": "throws", "bindings": { "call": { "description": "Calls fn and catches.", "params": [{ "name": "fn", "type": "function" }] } } }""",
            new RuntimeOptions { HostBindings = bindings });
        rt.Execute($"call(function () {{ throw {thrown}; }})");
        Assert.Equal("threw", caught!.Reason);
        Assert.Equal(message, caught.Message);
        Assert.Equal(name, caught.ScriptErrorName);
    }

    [Fact]
    public void A_Getter_Runs_Once_Per_Crossing()
    {
        var (rt, _) = Create(fidelity: true);
        using var __ = rt;
        Assert.Equal("1", Run(rt, "(function () { var n = 0; echo({ get g() { n++; return NaN; }, h: undefined }); return String(n); })()"));
        rt.Execute("var reads = 0;");
        rt.Execute("({ get g() { reads++; return [1n]; } })");
        Assert.Equal("1", Run(rt, "String(reads)"));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Values_A_Thousand_Levels_Deep_Cross_Both_Ways_On_Every_Path(bool fidelity)
    {
        var (rt, host) = Create(fidelity);
        using var _ = rt;
        rt.Execute($"var measure = {Measure};");

        Assert.Equal("1001", Run(rt, $"String(measure(echo({NestedScript(1000)})))"));
        Assert.Equal(1000, DepthOf(host.Received[0]));
        Assert.Equal(1000, DepthOf(rt.Execute(NestedScript(1000)).Value));

        host.Value = Json(Nested(1000));
        Assert.Equal("1000", Run(rt, "String(measure(value()))"));

        rt.Execute("hooks.probe(function (v) { return [measure(v), v]; })");
        var hook = rt.FireHook("probe", new FireHookOptions { Data = Json(Nested(1000)) })[0];
        Assert.Equal(1000, hook[0].GetInt32());
        Assert.Equal(1000, DepthOf(hook[1]));

        rt.Execute("events.on('probed', function (v) { return [measure(v), v]; })");
        var emitted = rt.Emit("probed", new FireHookOptions { Data = Json(Nested(1000)) })[0];
        Assert.Equal(1000, emitted[0].GetInt32());
        Assert.Equal(1000, DepthOf(emitted[1]));

        Assert.Equal("1000", Run(rt, $"String(measure(p.call(function (v) {{ return v; }}, {NestedScript(1000)})))"));
        Assert.Equal(1000, DepthOf(host.CallbackResult!.Value));

        rt.Execute("keep(function (v) { return [measure(v), v]; })");
        var kept = host.Kept!.Invoke(Json(Nested(1000)));
        Assert.Equal(1000, kept[0].GetInt32());
        Assert.Equal(1000, DepthOf(kept[1]));

        rt.Execute("xript.exports.register('deep', function (v) { return [measure(v), v]; })");
        var exported = rt.InvokeExport("deep", [Json(Nested(1000))]);
        Assert.Equal(1000, exported[0].GetInt32());
        Assert.Equal(1000, DepthOf(exported[1]));

        rt.Execute($"try {{ echo({NestedScript(XriptValue.MaxDepth)}); }} catch (e) {{ }}");
        Assert.Equal(XriptValue.MaxDepth, DepthOf(host.Received[0]));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Past_The_Depth_Limit_A_Crossing_Fails_With_The_Binding_Prefix(bool fidelity)
    {
        var (rt, host) = Create(fidelity);
        using var _ = rt;
        var past = XriptValue.MaxDepth + 1;

        Assert.Equal(
            $"BindingError|echo(): a value nested deeper than {XriptValue.MaxDepth} levels cannot cross to the host",
            Run(rt, $"(function () {{ try {{ echo({NestedScript(past)}); return 'crossed'; }} catch (e) {{ return e.name + '|' + e.message; }} }})()"));
        Assert.StartsWith("execute(): ", Assert.Throws<ValueCrossingException>(() => rt.Execute(NestedScript(past))).Message);

        host.Value = Json(Nested(past));
        Assert.Equal(
            $"BindingError|value(): a value nested deeper than {XriptValue.MaxDepth} levels cannot cross into the sandbox",
            Run(rt, "(function () { try { value(); return 'crossed'; } catch (e) { return e.name + '|' + e.message; } })()"));

        rt.Execute("hooks.probe(function () { return 1; })");
        Assert.StartsWith("hooks.probe(): ", Assert.Throws<ValueCrossingException>(() => rt.FireHook("probe", new FireHookOptions { Data = Json(Nested(past)) })).Message);
        Assert.StartsWith("events.emit(): ", Assert.Throws<ValueCrossingException>(() => rt.Emit("probed", new FireHookOptions { Data = Json(Nested(past)) })).Message);

        rt.Execute("keep(function (v) { return v; })");
        Assert.StartsWith("keep(): ", Assert.Throws<ValueCrossingException>(() => host.Kept!.Invoke(Json(Nested(past)))).Message);
        Assert.Equal("1", Run(rt, "String(1)"));
    }

    [Fact]
    public void A_Binding_Error_Carries_Its_Prefix_Once()
    {
        var (rt, _) = Create(fidelity: true);
        using var __ = rt;
        var message = Run(rt, "(function () { try { p.call(function () { return Promise.resolve(1); }); } catch (e) { return e.message; } })()");
        Assert.StartsWith("p.call(): callback returned a promise", message);
        Assert.Equal(1, message.Split("p.call(): ").Length - 1);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Retained_Callbacks_Carry_The_Same_Rules(bool fidelity)
    {
        var (rt, host) = Create(fidelity);
        using var _ = rt;
        rt.Execute("keep(function (v) { if (v === 'cycle') { var o = {}; o.o = o; return o; } if (v === 'getter') return { get g() { throw new TypeError('kept'); } }; return [typeof v, v]; })");
        if (fidelity)
        {
            SameJson("""["bigint",{"$xript":"bigint","value":"5"}]""", host.Kept!.Invoke(XriptValue.BigInt(5)));
            SameJson("""{"o":{"$xript":"cycle","up":1}}""", host.Kept.Invoke(Json("\"cycle\"")));
        }
        else
        {
            Assert.StartsWith("keep(): ", Assert.Throws<ValueCrossingException>(() => host.Kept!.Invoke(Json("\"cycle\""))).Message);
        }
        var threw = Assert.Throws<CallbackException>(() => host.Kept!.Invoke(Json("\"getter\"")));
        Assert.Equal("threw", threw.Reason);
        Assert.Equal("TypeError", threw.ScriptErrorName);
    }

    [Fact]
    public void Event_And_Export_Payloads_Decode_Markers()
    {
        var (rt, _) = Create(fidelity: true);
        using var __ = rt;
        rt.Execute("events.on('probed', function (n) { return [typeof n, '\\uD800']; })");
        SameJson("""["bigint",{"$xript":"string","units":[55296]}]""", rt.Emit("probed", new FireHookOptions { Data = XriptValue.BigInt(3) })[0]);

        rt.Execute("xript.exports.register('ring', function (v) { return [v.self === v, 4n]; })");
        SameJson("""[true,{"$xript":"bigint","value":"4"}]""", rt.InvokeExport("ring", [Json("""{"self":{"$xript":"cycle","up":1}}""")]));
    }

    [Fact]
    public void A_Promise_Result_Settles_Or_Fails_Clearly()
    {
        var (rt, _) = Create(fidelity: true);
        using var __ = rt;
        Assert.Equal(5, rt.Execute("Promise.resolve(5)").Value.GetInt32());
        SameJson("""{"a":{"$xript":"NaN"}}""", rt.Execute("(async function () { await null; return { a: NaN }; })()").Value);
        Assert.Equal("nope", Assert.Throws<JavaScriptException>(() => rt.Execute("Promise.reject(new Error('nope'))")).Message);
        var pending = Assert.Throws<InvalidOperationException>(() => rt.Execute("new Promise(function () {})"));
        Assert.Contains("still pending", pending.Message);
        Assert.Contains("cannot await", pending.Message);

        rt.Execute("xript.exports.register('later', async function (v) { return v + 1; }); xript.exports.register('never', function () { return new Promise(function () {}); }); xript.exports.register('fails', async function () { throw new Error('bad'); });");
        Assert.Equal(3, rt.InvokeExport("later", [Json("2")]).GetInt32());
        Assert.Contains("still pending", Assert.Throws<InvokeException>(() => rt.InvokeExport("never", [])).Message);
        Assert.Equal("bad", Assert.Throws<InvokeException>(() => rt.InvokeExport("fails", [])).Message);
        Assert.Equal(2, rt.Execute("1 + 1").Value.GetInt32());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void A_Callback_Handed_Back_During_Its_Call_Is_The_Scripts_Own_Function(bool fidelity)
    {
        var (rt, _) = Create(fidelity);
        using var __ = rt;
        Assert.Equal(
            "true|true|true",
            Run(rt, "(function () { var f = function () {}; var r = echo(f, { g: f, list: [f] }); return [r[0] === f, r[1].g === f, r[1].list[0] === f].join('|'); })()"));
        Assert.Equal(
            "true|true",
            Run(rt, "(function () { var other = function () {}; return [p.call(function (x) { return x === other; }, other), p.call(function (x) { return x.f === other; }, { f: other })].join('|'); })()"));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void A_Callback_Handed_Back_After_Its_Call_Is_Undefined_And_Never_Its_Marker(bool fidelity)
    {
        var (rt, host) = Create(fidelity);
        using var __ = rt;
        rt.Execute("echo(function () {}, { f: function () {} })");
        var stale = host.Received[0];
        host.Value = ArrayOf([stale, host.Received[1]]);
        Assert.Equal(
            "undefined|true|undefined|false",
            Run(rt, "(function () { var v = value(); var s = JSON.stringify(v); return [typeof v[0], 'f' in v[1], typeof v[1].f, s.indexOf('$xriptCallback') !== -1].join('|'); })()"));
        rt.Execute("keep(function (x, y) { return typeof x + '|' + typeof y.f; })");
        Assert.Equal("undefined|undefined", host.Kept!.Invoke(stale, host.Received[1]).GetString());

        rt.Execute("hooks.probe(function (x) { return typeof x; }); events.on('probed', function (x) { return typeof x; }); xript.exports.register('kind', function (x) { return typeof x; })");
        Assert.Equal("undefined", rt.FireHook("probe", new FireHookOptions { Data = stale })[0].GetString());
        Assert.Equal("undefined", rt.Emit("probed", new FireHookOptions { Data = stale })[0].GetString());
        Assert.Equal("undefined", rt.InvokeExport("kind", [stale]).GetString());
    }

    [Fact]
    public void A_Callback_Handed_To_Another_Runtime_Is_Undefined()
    {
        var (rt, _) = Create(fidelity: true);
        using var __ = rt;
        JsonElement held = default;
        var foreignBindings = new HostBindings();
        foreignBindings.AddFunction("foreign", _ => held);
        using var other = XriptRuntime.Create(
            """{ "xript": "0.10", "name": "other", "bindings": { "foreign": { "description": "Returns a marker from elsewhere." } } }""",
            new RuntimeOptions { HostBindings = foreignBindings, ValueFidelity = true });
        string? seen = null;
        var bindings = new HostBindings();
        bindings.AddFunction("cross", args =>
        {
            held = args[0];
            seen = other.Execute("(function () { var v = foreign(); return typeof v + '|' + JSON.stringify([v]); })()").Value.GetString();
            return Json("null");
        });
        using var origin = XriptRuntime.Create(
            """{ "xript": "0.10", "name": "origin", "bindings": { "cross": { "description": "Hands its callback to another runtime.", "params": [{ "name": "fn", "type": "function" }] } } }""",
            new RuntimeOptions { HostBindings = bindings });
        origin.Execute("cross(function () {})");
        Assert.Equal("undefined|[null]", seen);
    }

    [Fact]
    public void Script_Data_Shaped_Like_A_Callback_Marker_Stays_Data()
    {
        var (rt, host) = Create(fidelity: false);
        using var _ = rt;
        rt.Execute("echo({ '$xriptCallback': 0 }, function () {})");
        Assert.Null(XriptCallback.From(host.Received[0]));
        Assert.Equal("""{"$xriptCallback":0}""", host.Received[0].GetRawText());
    }
}
