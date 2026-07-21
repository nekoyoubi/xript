using System.Text.Json;

namespace Xript.Runtime.Tests;

/// <summary>
/// Holds the C# HTML sanitizer to the shared cross-runtime corpus in
/// <c>spec/sanitizer-tests.json</c>, the same file the other runtimes assert against.
/// </summary>
public class SanitizerCorpusTests
{
    public static TheoryData<int, string, string, string> Corpus()
    {
        var cases = JsonDocument.Parse(File.ReadAllText(CorpusPath())).RootElement;
        var data = new TheoryData<int, string, string, string>();
        var index = 0;
        foreach (var entry in cases.EnumerateArray())
        {
            data.Add(
                index++,
                entry.GetProperty("description").GetString() ?? "",
                entry.GetProperty("input").GetString() ?? "",
                entry.GetProperty("expected").GetString() ?? "");
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(Corpus))]
    public void Sanitizer_Matches_Shared_Corpus(int index, string description, string input, string expected)
    {
        Assert.Equal(expected, HtmlReader.Sanitize(input));
        Assert.True(true, $"case {index}: {description}");
    }

    /// <summary>
    /// The tree path and the string path must agree byte for byte on the built-in HTML
    /// vocabulary. This is what makes the sanitized tree safe to hand a host that was
    /// previously mounting the string.
    /// </summary>
    [Theory]
    [MemberData(nameof(Corpus))]
    public void Tree_Projection_Matches_String_Sanitizer(int index, string description, string input, string expected)
    {
        var profile = FormatProfiles.Builtins["text/html"];
        var result = VocabularySanitizer.Sanitize(HtmlReader.ToTree(input, profile), profile);
        Assert.Equal(expected, FragmentTree.ToHtml(result.Tree));
        Assert.True(true, $"case {index}: {description}");
    }

    [Theory]
    [MemberData(nameof(Corpus))]
    public void SanitizeFragment_Html_Matches_Corpus(int index, string description, string input, string expected)
    {
        var sanitized = FragmentSanitizer.Sanitize(input, FormatProfiles.Builtins["text/html"]);
        Assert.Equal(expected, sanitized.Html);
        Assert.Equal(FragmentContentType.Html, sanitized.ContentType);
        Assert.True(true, $"case {index}: {description}");
    }

    private static string CorpusPath()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null)
        {
            var candidate = Path.Combine(dir, "spec", "sanitizer-tests.json");
            if (File.Exists(candidate))
                return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        }
        throw new FileNotFoundException("could not locate spec/sanitizer-tests.json from the test output directory");
    }
}
