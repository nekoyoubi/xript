using System.Text.Json;
using Xript.Runtime;

namespace Xript.Runtime.Tests;

/// <summary>
/// The shared corpus, so the rule deciding which budget governs a call into a slot's
/// fills cannot drift from the other three runtimes.
/// </summary>
public class SlotLimitCorpusTests
{
    private static JsonElement Load(string file)
    {
        var path = Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "spec", file);
        return JsonDocument.Parse(File.ReadAllText(Path.GetFullPath(path))).RootElement.Clone();
    }

    private static JsonElement Corpus => Load("slot-limit-tests.json");

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var entry in Corpus.GetProperty("resolve").EnumerateArray())
            data.Add(entry.GetProperty("name").GetString()!);
        return data;
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Resolves_The_Corpus_Case(string name)
    {
        var entry = Corpus.GetProperty("resolve").EnumerateArray()
            .First(c => c.GetProperty("name").GetString() == name);

        var options = new RuntimeOptions { Capabilities = [] };
        if (entry.TryGetProperty("hardLimits", out var hard) && hard.ValueKind == JsonValueKind.Object)
            options.HardLimits = new ExecutionLimits { TimeoutMs = hard.GetProperty("timeout_ms").GetInt64() };

        using var rt = XriptRuntime.Create(entry.GetProperty("manifest").GetRawText(), options);

        Assert.Equal(
            entry.GetProperty("expected").GetInt64(),
            rt.EffectiveSlotTimeoutMs(entry.GetProperty("slot").GetString()!));
    }

    [Fact]
    public void The_Corpus_Carries_Cases()
    {
        Assert.NotEmpty(Corpus.GetProperty("resolve").EnumerateArray());
    }

    [Fact]
    public void Keeps_The_Manifest_Schema_Block_In_Step_With_The_Corpus()
    {
        var declared = Load("manifest.schema.json")
            .GetProperty("$defs").GetProperty("slotExecutionLimits");
        var canonical = Corpus.GetProperty("schemaBlock");

        Assert.Equal(
            canonical.GetProperty("properties").GetProperty("timeout_ms").GetProperty("type").GetString(),
            declared.GetProperty("properties").GetProperty("timeout_ms").GetProperty("type").GetString());
        Assert.Equal(
            canonical.GetProperty("properties").GetProperty("timeout_ms").GetProperty("minimum").GetInt64(),
            declared.GetProperty("properties").GetProperty("timeout_ms").GetProperty("minimum").GetInt64());
        Assert.False(declared.GetProperty("additionalProperties").GetBoolean());
    }
}
