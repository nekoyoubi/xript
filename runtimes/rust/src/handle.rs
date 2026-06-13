use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::thread;

use crate::debug::DebugSession;
use crate::error::{Result, XriptError};
use crate::fragment::ModInstance;
use crate::sandbox::{ExecutionResult, RoleResolution, RuntimeOptions, SlotContribution};

enum Command {
    Execute {
        code: String,
        tx: mpsc::Sender<Result<ExecutionResult>>,
    },
    LoadMod {
        mod_manifest_json: String,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: HashSet<String>,
        entry_source: Option<String>,
        tx: mpsc::Sender<Result<ModInstance>>,
    },
    InvokeExport {
        name: String,
        args: Vec<serde_json::Value>,
        tx: mpsc::Sender<Result<serde_json::Value>>,
    },
    FireHook {
        hook: String,
        payload: Vec<serde_json::Value>,
        tx: mpsc::Sender<Result<Vec<serde_json::Value>>>,
    },
    Emit {
        event: String,
        payload: Vec<serde_json::Value>,
        tx: mpsc::Sender<Result<Vec<serde_json::Value>>>,
    },
    ResolveSlot {
        slot_id: String,
        tx: mpsc::Sender<Vec<SlotContribution>>,
    },
    ResolveRole {
        role: String,
        all: bool,
        tx: mpsc::Sender<Vec<RoleResolution>>,
    },
    DebugSession {
        tx: mpsc::Sender<Option<DebugSession>>,
    },
    ManifestName {
        tx: mpsc::Sender<String>,
    },
    Shutdown,
}

pub struct XriptHandle {
    cmd_tx: mpsc::Sender<Command>,
    thread: Option<thread::JoinHandle<()>>,
}

impl XriptHandle {
    pub fn new(manifest_json: String, options: RuntimeOptions) -> Result<Self> {
        let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
        let (init_tx, init_rx) = mpsc::channel::<Result<()>>();

        let thread = thread::spawn(move || {
            let rt = match crate::create_runtime(&manifest_json, options) {
                Ok(rt) => {
                    let _ = init_tx.send(Ok(()));
                    rt
                }
                Err(e) => {
                    let _ = init_tx.send(Err(e));
                    return;
                }
            };

            while let Ok(cmd) = cmd_rx.recv() {
                match cmd {
                    Command::Execute { code, tx } => {
                        let _ = tx.send(rt.execute(&code));
                    }
                    Command::LoadMod {
                        mod_manifest_json,
                        fragment_sources,
                        granted_capabilities,
                        entry_source,
                        tx,
                    } => {
                        let _ = tx.send(rt.load_mod(
                            &mod_manifest_json,
                            fragment_sources,
                            &granted_capabilities,
                            entry_source.as_deref(),
                        ));
                    }
                    Command::InvokeExport { name, args, tx } => {
                        let _ = tx.send(rt.invoke_export(&name, &args));
                    }
                    Command::FireHook { hook, payload, tx } => {
                        let _ = tx.send(rt.fire_hook(&hook, &payload));
                    }
                    Command::Emit { event, payload, tx } => {
                        let _ = tx.send(rt.emit(&event, &payload));
                    }
                    Command::ResolveSlot { slot_id, tx } => {
                        let _ = tx.send(rt.resolve_slot(&slot_id));
                    }
                    Command::ResolveRole { role, all, tx } => {
                        let result = if all {
                            rt.resolve_role_all(&role)
                        } else {
                            rt.resolve_role(&role).into_iter().collect()
                        };
                        let _ = tx.send(result);
                    }
                    Command::DebugSession { tx } => {
                        let _ = tx.send(rt.debug_session().cloned());
                    }
                    Command::ManifestName { tx } => {
                        let _ = tx.send(rt.manifest().name.clone());
                    }
                    Command::Shutdown => break,
                }
            }
        });

        init_rx
            .recv()
            .map_err(|_| XriptError::Engine("runtime thread panicked during init".into()))??;

        Ok(Self {
            cmd_tx,
            thread: Some(thread),
        })
    }

    pub fn execute(&self, code: &str) -> Result<ExecutionResult> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::Execute {
                code: code.to_string(),
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))?
    }

    pub fn load_mod(
        &self,
        mod_manifest_json: &str,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: &HashSet<String>,
        entry_source: Option<&str>,
    ) -> Result<ModInstance> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::LoadMod {
                mod_manifest_json: mod_manifest_json.to_string(),
                fragment_sources,
                granted_capabilities: granted_capabilities.clone(),
                entry_source: entry_source.map(|s| s.to_string()),
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))?
    }

    pub fn invoke_export(
        &self,
        name: &str,
        args: &[serde_json::Value],
    ) -> Result<serde_json::Value> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::InvokeExport {
                name: name.to_string(),
                args: args.to_vec(),
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))?
    }

    pub fn fire_hook(
        &self,
        hook: &str,
        payload: &[serde_json::Value],
    ) -> Result<Vec<serde_json::Value>> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::FireHook {
                hook: hook.to_string(),
                payload: payload.to_vec(),
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))?
    }

    pub fn emit(
        &self,
        event: &str,
        payload: &[serde_json::Value],
    ) -> Result<Vec<serde_json::Value>> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::Emit {
                event: event.to_string(),
                payload: payload.to_vec(),
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))?
    }

    pub fn resolve_slot(&self, slot_id: &str) -> Result<Vec<SlotContribution>> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::ResolveSlot {
                slot_id: slot_id.to_string(),
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))
    }

    pub fn resolve_role(&self, role: &str) -> Result<Option<RoleResolution>> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::ResolveRole {
                role: role.to_string(),
                all: false,
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map(|v| v.into_iter().next())
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))
    }

    pub fn resolve_role_all(&self, role: &str) -> Result<Vec<RoleResolution>> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::ResolveRole {
                role: role.to_string(),
                all: true,
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))
    }

    pub fn debug_session(&self) -> Result<Option<DebugSession>> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::DebugSession { tx })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))
    }

    pub fn manifest_name(&self) -> Result<String> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::ManifestName { tx })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))
    }
}

impl Drop for XriptHandle {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(Command::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
