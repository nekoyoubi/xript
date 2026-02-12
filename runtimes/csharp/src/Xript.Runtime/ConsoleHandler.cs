namespace Xript.Runtime;

public class ConsoleHandler
{
    public Action<string> Log { get; set; } = _ => { };
    public Action<string> Warn { get; set; } = _ => { };
    public Action<string> Error { get; set; } = _ => { };
}
