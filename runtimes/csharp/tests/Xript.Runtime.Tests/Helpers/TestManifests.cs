namespace Xript.Runtime.Tests.Helpers;

internal static class TestManifests
{
    internal const string Minimal = """{ "xript": "0.1", "name": "test-app" }""";

    internal const string WithBinding = """
        {
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "add": {
                    "description": "adds two numbers",
                    "params": [
                        { "name": "a", "type": "number" },
                        { "name": "b", "type": "number" }
                    ]
                }
            }
        }
        """;

    internal const string WithCapability = """
        {
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "dangerousOp": {
                    "description": "requires permission",
                    "capability": "dangerous"
                }
            },
            "capabilities": {
                "dangerous": {
                    "description": "allows dangerous operations"
                }
            }
        }
        """;

    internal const string WithNamespace = """
        {
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "player": {
                    "description": "player namespace",
                    "members": {
                        "getName": {
                            "description": "gets the player name"
                        },
                        "getHealth": {
                            "description": "gets the player health"
                        }
                    }
                }
            }
        }
        """;

    internal const string WithNamespaceCapability = """
        {
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "admin": {
                    "description": "admin namespace",
                    "members": {
                        "reset": {
                            "description": "resets the system",
                            "capability": "admin-access"
                        },
                        "status": {
                            "description": "gets system status"
                        }
                    }
                }
            },
            "capabilities": {
                "admin-access": {
                    "description": "admin access"
                }
            }
        }
        """;

    internal const string WithHooks = """
        {
            "xript": "0.1",
            "name": "test",
            "hooks": {
                "onInit": {
                    "description": "called on initialization"
                }
            }
        }
        """;

    internal const string WithPhasedHooks = """
        {
            "xript": "0.1",
            "name": "test",
            "hooks": {
                "onTurn": {
                    "description": "called each turn",
                    "phases": ["before", "after"]
                }
            }
        }
        """;

    internal const string WithCapabilityGatedHook = """
        {
            "xript": "0.1",
            "name": "test",
            "hooks": {
                "onSave": {
                    "description": "called on save",
                    "capability": "save-access"
                }
            },
            "capabilities": {
                "save-access": {
                    "description": "access to save hooks"
                }
            }
        }
        """;

    internal const string WithShortTimeout = """
        {
            "xript": "0.1",
            "name": "test",
            "limits": { "timeout_ms": 200 }
        }
        """;

    internal const string WithLowRecursion = """
        {
            "xript": "0.1",
            "name": "test",
            "limits": { "max_stack_depth": 10 }
        }
        """;

    internal const string WithLowMemory = """
        {
            "xript": "0.1",
            "name": "test",
            "limits": { "memory_mb": 2 }
        }
        """;

    internal const string WithMultipleBindings = """
        {
            "xript": "0.1",
            "name": "test",
            "bindings": {
                "add": {
                    "description": "adds two numbers"
                },
                "fail": {
                    "description": "always fails"
                },
                "notProvided": {
                    "description": "not provided by host"
                }
            }
        }
        """;
}
