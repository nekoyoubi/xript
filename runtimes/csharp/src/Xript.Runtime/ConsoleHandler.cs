namespace Xript.Runtime;

public enum LogSeverity
{
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

public class ConsoleHandler
{
    public Action<string> Log { get; set; } = _ => { };
    public Action<string> Warn { get; set; } = _ => { };
    public Action<string> Error { get; set; } = _ => { };

    public Action<string>? Info { get; set; }
    public Action<string>? Debug { get; set; }
    public Action<string>? Trace { get; set; }

    public Action<LogSeverity, string>? OnLog { get; set; }

    internal void Dispatch(LogSeverity severity, string message)
    {
        if (OnLog is not null)
        {
            OnLog(severity, message);
            return;
        }

        switch (severity)
        {
            case LogSeverity.Trace:
                (Trace ?? (_ => { }))(message);
                break;
            case LogSeverity.Debug:
                (Debug ?? (_ => { }))(message);
                break;
            case LogSeverity.Info:
                if (Info is not null)
                    Info(message);
                else
                    Log(message);
                break;
            case LogSeverity.Warn:
                Warn(message);
                break;
            case LogSeverity.Error:
                Error(message);
                break;
        }
    }
}
