using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jint;
using Jint.Native;
using Jint.Native.Object;
using Jint.Runtime;
using Jint.Runtime.Interop;

namespace Xript.Runtime;

/// <summary>
/// The host's side of the events bus. The bus itself is <c>EventBusKernel.js</c>, the same
/// JavaScript source every xript runtime installs, so its behavior cannot drift between engines;
/// this class evaluates it, hands it the host object, and keeps the host API it returns.
/// </summary>
internal sealed class EventBus
{
    private static readonly Lazy<string> KernelSource = new(LoadKernel);

    private static readonly JsonSerializerOptions EventJson = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly Engine _engine;
    private readonly string _token = Guid.NewGuid().ToString("N");
    private readonly ObjectInstance _api;
    private const string EmitBinding = "events.emit";
    private const string DeclareBinding = "declareEvent";

    private readonly Func<JsonElement, string, JsValue> _toJs;
    private readonly Func<JsValue, string, JsonElement> _toJson;

    internal EventBus(
        Engine engine,
        IReadOnlyList<EventDeclaration>? manifestEvents,
        HashSet<string> granted,
        CallerContext caller,
        bool installGlobal,
        Func<JsonElement, string, JsValue> toJs,
        Func<JsValue, string, JsonElement> toJson)
    {
        _engine = engine;
        _toJs = toJs;
        _toJson = toJson;

        var host = new JsObject(engine);
        host.Set("token", _token);
        host.Set("installGlobal", installGlobal ? JsBoolean.True : JsBoolean.False);
        host.Set("events", JsonSerializer.Serialize(manifestEvents ?? [], EventJson));
        host.Set("caller", new ClrFunction(engine, "caller", (_, _) =>
            caller.Current is { } current ? new JsString(current) : JsValue.Null));
        host.Set("enter", new ClrFunction(engine, "enter", (_, args) =>
        {
            caller.Push(args.Length > 0 && args[0].IsString() ? args[0].AsString() : null);
            return JsValue.Undefined;
        }));
        host.Set("leave", new ClrFunction(engine, "leave", (_, _) =>
        {
            caller.Pop();
            return JsValue.Undefined;
        }));
        host.Set("satisfies", new ClrFunction(engine, "satisfies", (_, args) =>
            args.Length > 0 && args[0].IsString() && Capabilities.GrantedSatisfies(granted, args[0].AsString())
                ? JsBoolean.True
                : JsBoolean.False));

        var kernel = engine.Evaluate(KernelSource.Value, "xript-event-bus.js");
        _api = engine.Invoke(kernel, host).AsObject();
    }

    /// <summary>
    /// Delivers a host emit to every matching subscriber. Each result is tagged with the mod
    /// that subscribed the handler; an undeclared or family-shaped id delivers to nobody.
    /// </summary>
    internal IReadOnlyList<(string? Owner, JsonElement Value)> Emit(string eventId, JsonElement[] args)
    {
        var array = new JsArray(_engine, args.Select(arg => _toJs(arg, EmitBinding)).ToArray());
        var result = Call("emit", new JsString(eventId), array);
        if (result is not ObjectInstance list)
            return [];

        var length = (int)list.Get("length").AsNumber();
        var results = new List<(string?, JsonElement)>(length);
        for (var i = 0; i < length; i++)
        {
            var entry = list.Get(i.ToString()).AsObject();
            var owner = entry.Get("owner");
            results.Add((owner.IsString() ? owner.AsString() : null, _toJson(entry.Get("value"), EmitBinding)));
        }
        return results;
    }

    internal int CancelOwned(string? owner) =>
        (int)Call("cancelOwned", owner is null ? JsValue.Null : new JsString(owner)).AsNumber();

    internal JsonElement Declare(JsonElement entry) =>
        _toJson(Call("declare", _toJs(entry, DeclareBinding)), DeclareBinding);

    private JsValue Call(string method, params JsValue[] args)
    {
        var fn = _api.Get(method);
        var withToken = new JsValue[args.Length + 1];
        withToken[0] = new JsString(_token);
        Array.Copy(args, 0, withToken, 1, args.Length);
        try
        {
            return _engine.Invoke(fn, withToken.Cast<object?>().ToArray());
        }
        catch (JavaScriptException ex) when (ex.Error is ObjectInstance error
            && error.Get("name") is { } name && name.IsString() && name.AsString() == "BindingError")
        {
            var binding = error.Get("binding");
            var bindingName = binding.IsString() ? binding.AsString() : method;
            var message = error.Get("message").ToString();
            var prefix = $"{bindingName}(): ";
            throw new BindingException(bindingName, message.StartsWith(prefix, StringComparison.Ordinal) ? message[prefix.Length..] : message);
        }
    }

    private static string LoadKernel()
    {
        var assembly = typeof(EventBus).GetTypeInfo().Assembly;
        using var stream = assembly.GetManifestResourceStream("Xript.Runtime.EventBusKernel.js")
            ?? throw new InvalidOperationException("the event bus kernel is not embedded in Xript.Runtime");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
