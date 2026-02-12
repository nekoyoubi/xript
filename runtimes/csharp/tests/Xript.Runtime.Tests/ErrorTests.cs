using Xript.Runtime;

namespace Xript.Runtime.Tests;

public class ErrorTests
{
    [Fact]
    public void ManifestValidationException_FormatsIssues()
    {
        var issues = new List<ValidationIssue>
        {
            new("/xript", "required field 'xript' must be a non-empty string"),
            new("/name", "required field 'name' must be a non-empty string")
        };

        var ex = new ManifestValidationException(issues);

        Assert.Contains("/xript", ex.Message);
        Assert.Contains("/name", ex.Message);
        Assert.Contains("invalid xript manifest", ex.Message);
        Assert.Equal(2, ex.Issues.Count);
    }

    [Fact]
    public void BindingException_IncludesBindingName()
    {
        var ex = new BindingException("myFunc", "something went wrong");

        Assert.Equal("myFunc", ex.Binding);
        Assert.Contains("myFunc", ex.Message);
        Assert.Contains("something went wrong", ex.Message);
    }

    [Fact]
    public void CapabilityDeniedException_IncludesBindingAndCapability()
    {
        var ex = new CapabilityDeniedException("dangerousOp", "dangerous");

        Assert.Equal("dangerousOp", ex.Binding);
        Assert.Equal("dangerous", ex.Capability);
        Assert.Contains("dangerousOp()", ex.Message);
        Assert.Contains("\"dangerous\"", ex.Message);
        Assert.Contains("capability", ex.Message);
    }

    [Fact]
    public void ExecutionLimitException_IncludesLimit()
    {
        var ex = new ExecutionLimitException("timeout_ms");

        Assert.Equal("timeout_ms", ex.Limit);
        Assert.Contains("timeout_ms", ex.Message);
        Assert.Contains("execution limit exceeded", ex.Message);
    }
}
