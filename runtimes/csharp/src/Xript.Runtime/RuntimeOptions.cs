namespace Xript.Runtime;

public class RuntimeOptions
{
    public HostBindings HostBindings { get; set; } = new();
    public List<string> Capabilities { get; set; } = [];
    public ConsoleHandler Console { get; set; } = new();
}
